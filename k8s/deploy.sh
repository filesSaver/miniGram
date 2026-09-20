#!/usr/bin/env bash
# ── deploy.sh ─────────────────────────────────────────────────────────────────
#
# One-time bootstrap script to deploy miniGram to EKS on ap-south-1.
# Run this ONCE from the laptop where you have AWS credentials configured.
#
# WHAT THIS SCRIPT DOES (in order):
#   1. Checks that required tools are installed
#   2. Creates the EKS cluster (takes ~15-20 minutes)
#   3. Installs the AWS Load Balancer Controller into the cluster
#   4. Deploys the miniGram Helm chart
#   5. Prints the public URL
#
# PREREQUISITES — install these on the deployment laptop first:
#   aws CLI:   https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html
#   eksctl:    https://eksctl.io/installation/
#   kubectl:   https://kubernetes.io/docs/tasks/tools/
#   helm:      https://helm.sh/docs/intro/install/
#
# BEFORE RUNNING:
#   1. Export credentials in your terminal (does NOT affect other projects):
#        export AWS_ACCESS_KEY_ID="your_key"
#        export AWS_SECRET_ACCESS_KEY="your_secret"
#        export AWS_DEFAULT_REGION="us-east-1"
#   2. Fill in the secret values in:  k8s/helm/minigram/templates/secret.yaml
#      (See instructions inside that file)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Step 0: Check prerequisites ───────────────────────────────────────────────
echo ""
echo "==> Checking prerequisites..."

for tool in aws eksctl kubectl helm; do
  if ! command -v "$tool" &>/dev/null; then
    echo "ERROR: '$tool' is not installed. Install it and re-run this script."
    exit 1
  fi
done

echo "    All tools found."

# Check AWS credentials are configured
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: AWS credentials not found in environment."
  echo ""
  echo "  Do NOT use 'aws configure' — it affects all projects on this laptop."
  echo "  Instead, paste these 3 lines in THIS terminal only:"
  echo ""
  echo "    export AWS_ACCESS_KEY_ID=\"your_key_from_sandbox\""
  echo "    export AWS_SECRET_ACCESS_KEY=\"your_secret_from_sandbox\""
  echo "    export AWS_DEFAULT_REGION=\"us-east-1\""
  echo ""
  echo "  These expire when you close this terminal. Nothing else is affected."
  exit 1
fi

echo "    AWS credentials OK (account: $(aws sts get-caller-identity --query Account --output text))"

# ── Step 1: Create EKS Cluster ────────────────────────────────────────────────
# This step takes 15-20 minutes. eksctl creates:
#   - The EKS control plane
#   - VPC with public/private subnets
#   - 2 t3.medium worker nodes
#   - Installs EBS CSI driver (for PostgreSQL persistent volume)
#   - Configures OIDC (for ALB Controller IAM permissions)
echo ""
echo "==> Creating EKS cluster (this takes ~15-20 minutes)..."
eksctl create cluster -f k8s/cluster/eksctl-cluster.yaml

# eksctl automatically updates your ~/.kube/config so kubectl points to the new cluster
echo "    Cluster created. kubectl is now configured to use it."

# ── Step 2: Install AWS Load Balancer Controller ──────────────────────────────
# WHY: The ALB Ingress in the Helm chart creates an AWS Application Load Balancer.
# For that to work, the AWS Load Balancer Controller must be running inside the cluster.
# It watches for Ingress resources and calls AWS APIs to create/configure ALBs.
#
# This needs an IAM policy attached to the controller's service account.
echo ""
echo "==> Installing AWS Load Balancer Controller..."

CLUSTER_NAME="minigram"
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Download the IAM policy that allows the controller to call AWS APIs
curl -sSL \
  "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json" \
  -o /tmp/alb-iam-policy.json

# Create the IAM policy in AWS (skip if it already exists)
aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file:///tmp/alb-iam-policy.json \
  2>/dev/null || echo "    IAM policy already exists, skipping."

# Create a Kubernetes service account linked to that IAM policy (IRSA)
# IRSA = IAM Roles for Service Accounts: lets a pod assume an IAM role without storing AWS keys
eksctl create iamserviceaccount \
  --cluster="$CLUSTER_NAME" \
  --region="$AWS_REGION" \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn="arn:aws:iam::${AWS_ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy" \
  --approve

# Install the controller via Helm
helm repo add eks https://aws.github.io/eks-charts
helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName="$CLUSTER_NAME" \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region="$AWS_REGION" \
  --set vpcId="$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" --query 'cluster.resourcesVpcConfig.vpcId' --output text)"

echo "    AWS Load Balancer Controller installed."

# ── Step 3: Check secrets are filled in ───────────────────────────────────────
echo ""
echo "==> Checking secrets..."
if grep -q "REPLACE_WITH_BASE64" k8s/helm/minigram/templates/secret.yaml; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  ERROR: You have not filled in the secrets yet!"
  echo ""
  echo "  Open:  k8s/helm/minigram/templates/secret.yaml"
  echo "  Replace all REPLACE_WITH_BASE64_* placeholders with real"
  echo "  base64-encoded values. See the comments in that file."
  echo ""
  echo "  Quick encode example:"
  echo "    echo -n 'mypassword' | base64"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 1
fi
echo "    Secrets look filled in."

# ── Step 4: Deploy miniGram with Helm ─────────────────────────────────────────
# Helm installs all the Kubernetes manifests from k8s/helm/minigram/templates/
# in the correct order and creates the "minigram" namespace.
echo ""
echo "==> Deploying miniGram..."
helm install minigram ./k8s/helm/minigram \
  --namespace minigram \
  --create-namespace \
  --wait \
  --timeout 5m

echo "    miniGram deployed."

# ── Step 5: Print the public URL ──────────────────────────────────────────────
# The ALB takes 1-3 minutes to provision after the Ingress is created.
echo ""
echo "==> Waiting for the ALB to be provisioned (up to 3 minutes)..."
for i in $(seq 1 18); do
  ALB_URL=$(kubectl get ingress minigram-ingress -n minigram \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  if [ -n "$ALB_URL" ]; then
    break
  fi
  echo "    Still waiting... (${i}/18)"
  sleep 10
done

echo ""
echo "================================================================"
echo "  miniGram is live!"
echo ""
if [ -n "${ALB_URL:-}" ]; then
  echo "  Public URL:  http://$ALB_URL"
else
  echo "  ALB URL not ready yet. Run this to get it once ready:"
  echo "  kubectl get ingress minigram-ingress -n minigram"
fi
echo ""
echo "  Useful commands:"
echo "    kubectl get pods -n minigram          # Check all pods are Running"
echo "    kubectl logs -n minigram <pod-name>   # View logs for a pod"
echo "    helm upgrade minigram ./k8s/helm/minigram -n minigram  # Re-deploy after changes"
echo "    helm uninstall minigram -n minigram   # Remove the app (keeps the cluster)"
echo "    eksctl delete cluster -f k8s/cluster/eksctl-cluster.yaml  # Delete everything"
echo "================================================================"
