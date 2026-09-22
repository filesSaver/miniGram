# miniGram — AWS EKS Deployment Guide

## Overview

miniGram runs in production on Amazon EKS (Elastic Kubernetes Service). The cluster runs in `us-east-1` and is managed via `eksctl` and Helm. All application resources are in the `minigram` Kubernetes namespace.

**Current live ALB URL:**
```
k8s-minigram-minigram-3e16dfc8d5-1427249512.us-east-1.elb.amazonaws.com
```

---

## What Is EKS? A Brief Explanation

**Kubernetes** is a system that runs containerised applications on a fleet of servers. You describe what you want to run in YAML files and hand them to Kubernetes, which figures out which machine to put containers on, restarts them on crash, and replaces them if a machine dies.

Kubernetes has two layers:
- **Control plane** — the "brain" (API server, scheduler, etcd database). You never run code here.
- **Worker nodes** — the actual EC2 instances where your containers run.

**EKS** is AWS's managed Kubernetes. AWS runs the control plane for you. You only provision and pay for the worker node EC2 instances.

**eksctl** is a CLI tool that creates and manages EKS clusters from a YAML file. One command creates the entire cluster: VPC, subnets, security groups, IAM roles, and EC2 instances.

---

## Prerequisites: Install on the Deployment Machine

```bash
# AWS CLI
brew install awscli        # macOS

# eksctl
brew tap weaveworks/tap
brew install weaveworks/tap/eksctl

# kubectl
brew install kubectl

# Helm
brew install helm

# Docker Desktop (for building and pushing images)
# https://www.docker.com/products/docker-desktop/
```

---

## Step 0: Set AWS Credentials (Every Sandbox Session)

The Pluralsight sandbox provides temporary credentials that expire after ~4 hours.

```bash
export AWS_ACCESS_KEY_ID="paste_from_sandbox_console"
export AWS_SECRET_ACCESS_KEY="paste_from_sandbox_console"
export AWS_SESSION_TOKEN="paste_from_sandbox_console"
export AWS_DEFAULT_REGION="us-east-1"
```

Verify:
```bash
aws sts get-caller-identity
# Should show: "Account": "259939863830"
```

Use environment variable exports (not `aws configure`) for sandbox credentials. `aws configure` writes to `~/.aws/credentials` and persists across all terminal sessions, potentially conflicting with other AWS accounts.

---

## Step 1: Create the EKS Cluster

```bash
eksctl create cluster -f k8s/cluster/eksctl-cluster.yaml
```

This takes **15–20 minutes**. eksctl creates:
- A VPC with 3 public subnets and 3 private subnets across availability zones.
- An EKS control plane (managed by AWS, not billed as EC2).
- A Managed Node Group with 2 `t3.medium` EC2 instances in **private** subnets.
- IAM roles for nodes and the control plane.
- EBS CSI driver, CoreDNS, kube-proxy, and VPC CNI add-ons.
- Updates `~/.kube/config` so `kubectl` commands go to this cluster.

### `eksctl-cluster.yaml` Key Fields

```yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: minigram
  region: us-east-1
  version: "1.32"
iam:
  withOIDC: true          # enables IRSA (IAM Roles for Service Accounts)
managedNodeGroups:
  - name: minigram-nodes
    instanceType: t3.medium   # 2 vCPUs, 4 GB RAM
    minSize: 1
    desiredCapacity: 2
    maxSize: 3
    privateNetworking: true   # nodes in private subnets (not directly internet-accessible)
addons:
  - name: aws-ebs-csi-driver    # provisions EBS volumes for PersistentVolumeClaims
    wellKnownPolicies:
      ebsCSIController: true
  - name: coredns               # DNS inside the cluster (service-name → IP)
  - name: kube-proxy            # implements Service networking (ClusterIP)
  - name: vpc-cni               # assigns real VPC IPs to pods (required for ALB target-type: ip)
```

**Why `privateNetworking: true`:** Nodes are in private subnets. They cannot be reached from the internet. Only the ALB (in public subnets) forwards traffic to them. This is standard security practice.

**Why the EBS CSI driver:** When the PostgreSQL StatefulSet requests a 20 GB PersistentVolumeClaim, the EBS CSI driver calls AWS to create a real EBS volume and attach it to the node. Without it, the postgres pod would be stuck in `Pending` state.

**Why VPC CNI:** Assigns real VPC IP addresses to pods. Required for `alb.ingress.kubernetes.io/target-type: ip` — the ALB routes directly to pod IPs rather than node IPs.

After cluster creation:
```bash
kubectl get nodes
# Should show 2 nodes, STATUS=Ready
```

---

## Step 2: Download the ALB Controller IAM Policy

The AWS Load Balancer Controller needs IAM permissions to create ALBs.

```bash
curl -sSL \
  "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json" \
  -o /tmp/alb-iam-policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file:///tmp/alb-iam-policy.json \
  || echo "Policy already exists, continuing"
```

---

## Step 3: Attach Policies to the Node Role (Sandbox Workaround)

**The problem:** Normally, the ALB controller uses IRSA (IAM Roles for Service Accounts) — a secure mechanism where only that specific pod can assume the required IAM role. IRSA requires creating an OIDC identity provider in AWS IAM, which the Pluralsight sandbox blocks (`iam:CreateOpenIDConnectProvider` permission denied).

**The workaround:** Attach the policies directly to the EC2 worker node IAM role. Every pod on those nodes inherits the permissions. Less secure than IRSA (too broad), but functional in the sandbox.

```bash
# Find the node role name (eksctl auto-creates it with a predictable naming pattern)
NODE_ROLE=$(aws iam list-roles \
  --query "Roles[?contains(RoleName,'NodeInstanceRole')].RoleName" \
  --output text)
echo "Attaching policies to: $NODE_ROLE"

# Attach the required policies
aws iam attach-role-policy \
  --role-name "$NODE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess

aws iam attach-role-policy \
  --role-name "$NODE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess

aws iam attach-role-policy \
  --role-name "$NODE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AWSWAFFullAccess

aws iam attach-role-policy \
  --role-name "$NODE_ROLE" \
  --policy-arn arn:aws:iam::259939863830:policy/AWSLoadBalancerControllerIAMPolicy
```

---

## Step 4: Install the AWS Load Balancer Controller

The ALB controller watches Kubernetes Ingress resources and creates real AWS ALBs when it finds one.

```bash
# Get the VPC ID
VPC_ID=$(aws eks describe-cluster \
  --name minigram \
  --region us-east-1 \
  --query 'cluster.resourcesVpcConfig.vpcId' \
  --output text)
echo "VPC ID: $VPC_ID"

# Add the AWS EKS Helm chart repository
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Install the controller
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=minigram \
  --set serviceAccount.create=true \
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

Wait for the controller pods to start:
```bash
kubectl get pods -n kube-system | grep aws-load-balancer
# Expect: 2 pods in Running state
```

---

## Step 5: Configure Secrets

Before deploying, fill in real base64-encoded values in `k8s/helm/minigram/templates/secret.yaml`.

**How to base64-encode a value:**
```bash
echo -n "mypassword" | base64
# The -n flag is critical — without it, echo adds a newline that gets encoded,
# causing authentication failures when the value is decoded
```

**How to generate a strong JWT_SECRET:**
```bash
openssl rand -hex 32 | base64
```

**What each secret key holds:**

| Key | Purpose |
|-----|---------|
| `JWT_SECRET` | Long random string for signing/verifying JWTs. All services that verify tokens must share this value. |
| `POSTGRES_USER` | PostgreSQL username (e.g. `minigram`) |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `POSTGRES_DB` | PostgreSQL database name (e.g. `minigram`) |
| `DATABASE_URL` | Full connection string: `postgresql://user:pass@postgres:5432/dbname`. Hostname must be `postgres` — the Kubernetes Service name. |

**Verify secrets are readable after deploy:**
```bash
kubectl get secret minigram-secrets -n minigram \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 --decode
```

**Important:** base64 is NOT encryption. Anyone with kubectl read access to the namespace can decode secrets. Protection comes from RBAC, not encoding.

---

## Step 6: Deploy miniGram with Helm

```bash
helm install minigram ./k8s/helm/minigram \
  --namespace minigram \
  --create-namespace \
  --wait \
  --timeout 5m
```

What happens:
1. Helm renders all templates in `k8s/helm/minigram/templates/` using values from `values.yaml`.
2. Sends all manifests to the Kubernetes API server.
3. Kubernetes creates: Namespace, Secret, 8 Deployments, 9 Services, 1 StatefulSet, 1 Ingress.
4. EBS CSI driver creates the 20 GB EBS volume for postgres.
5. DockerHub images are pulled onto the nodes.
6. Pods start; `initContainers` run dependency waits.
7. The ALB controller detects the new Ingress and calls AWS to create the ALB.
8. `--wait` blocks until all pods are `Ready` or 5 minutes pass.

---

## Step 7: Get the ALB URL

The ALB takes 1–3 minutes to provision after the Ingress is created.

```bash
kubectl get ingress minigram-ingress -n minigram
```

Look for the `ADDRESS` field. The URL looks like:
```
k8s-minigram-minigram-xxxxxxxxxx-1427249512.us-east-1.elb.amazonaws.com
```

Open this in a browser. The miniGram login screen should appear.

---

## Helm Chart Structure

```
k8s/helm/minigram/
├── Chart.yaml           # chart metadata
├── values.yaml          # all configurable values
└── templates/
    ├── namespace.yaml
    ├── secret.yaml
    ├── ingress.yaml
    ├── postgres/
    │   ├── statefulset.yaml
    │   └── service.yaml
    ├── api-gateway/deployment.yaml
    ├── auth-service/deployment.yaml
    ├── db-service/deployment.yaml
    ├── telegram-read-service/deployment.yaml
    ├── telegram-download-service/deployment.yaml
    ├── google-upload-service/deployment.yaml
    ├── google-download-service/deployment.yaml
    └── ui-service/deployment.yaml
```

### `values.yaml` Key Settings

```yaml
namespace: minigram

postgres:
  image: postgres:16-alpine
  port: 5432
  storage:
    size: 20Gi
    className: gp2

# Per-service settings
apiGateway:
  image: sauravmehta/content-scrapper-api-gateway:latest
  replicas: 1

authService:
  replicas: 1    # MUST stay 1 — holds in-memory OTP state that breaks with multiple pods

telegramReadService:
  replicas: 1    # MUST stay 1 — in-memory message cache

uiService:
  replicas: 1    # stateless, can be increased

ingress:
  host: ""             # empty = use auto-generated ALB DNS name
  tlsEnabled: false    # HTTP only
```

### Ingress Annotations Explained

```yaml
annotations:
  kubernetes.io/ingress.class: alb
  alb.ingress.kubernetes.io/scheme: internet-facing      # public ALB
  alb.ingress.kubernetes.io/target-type: ip              # route to pod IPs directly
  alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=600
```

- `scheme: internet-facing` — the ALB is placed in public subnets with a public IP. (Opposite: `internal` for VPC-only access.)
- `target-type: ip` — ALB registers pod IP addresses as targets. Requires VPC CNI add-on. Reduces one network hop vs `target-type: instance` (which goes through kube-proxy).
- `idle_timeout.timeout_seconds=600` — extends the ALB connection idle timeout from the default 60 seconds to 600 seconds. Required for large file downloads and long SSE streams. Without this, the ALB would drop connections during a 5-minute download.

### Deployment Template Key Sections

**initContainers (dependency check):**
```yaml
initContainers:
  - name: wait-for-auth
    image: busybox:1.36
    command: ["sh", "-c", "until nc -z auth-service 3001; do echo waiting; sleep 2; done"]
```

`nc -z auth-service 3001` tries to TCP-connect to auth-service. If it succeeds, the init container exits 0 and the main container starts. This replaces docker-compose's `depends_on: condition: service_healthy` — Kubernetes doesn't have a native equivalent without a controller.

**readinessProbe and livenessProbe:**
```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 10
livenessProbe:
  httpGet:
    path: /health
    port: 3001
  initialDelaySeconds: 30
  periodSeconds: 30
```

`readinessProbe` controls when a pod receives traffic — Kubernetes removes unready pods from the Service's endpoint list. `livenessProbe` controls restarts — Kubernetes restarts a pod when this fails. The `initialDelaySeconds` gap prevents restart loops during slow cold starts.

**Resource limits:**
```yaml
resources:
  requests:
    cpu: "150m"      # 15% of one CPU core, reserved on the node for scheduling
    memory: "256Mi"  # 256 MiB reserved
  limits:
    cpu: "500m"      # throttled if it tries to use more
    memory: "512Mi"  # OOMKilled if it exceeds this
```

---

## Ongoing Operations

### Redeploy After a Code Change

```bash
# 1. Build and push the updated image for the correct architecture
docker buildx build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-<service-name>:latest \
  ./services/<service-name> \
  --push

# 2. Force Kubernetes to pull the new image (triggers a rolling update)
kubectl rollout restart deployment/<service-name> -n minigram

# 3. Watch the rollout
kubectl rollout status deployment/<service-name> -n minigram
```

### Update Helm Values or Templates

```bash
helm upgrade minigram ./k8s/helm/minigram -n minigram
```

### Rollback to a Previous Helm Release

```bash
helm history minigram -n minigram   # see past releases
helm rollback minigram 1 -n minigram
```

### View Logs

```bash
kubectl logs -n minigram deployment/ui-service --tail=50
kubectl logs -n minigram deployment/auth-service --tail=50
kubectl logs -n minigram statefulset/postgres --tail=50
kubectl logs -n minigram -l app=telegram-download-service --tail=100
```

### Access the Database Directly

```bash
kubectl exec -it postgres-0 -n minigram -- psql -U minigram -d minigram
```

### See Pod Events (for debugging stuck pods)

```bash
kubectl describe pod <pod-name> -n minigram
# Look at the "Events:" section at the bottom
```

### Reconnect kubectl After Credentials Expire

The Pluralsight sandbox resets credentials every ~4 hours. After exporting new credentials:

```bash
aws eks update-kubeconfig --region us-east-1 --name minigram
kubectl get pods -n minigram   # verify it works
```

---

## Kubernetes Resources Reference

### Namespace

Groups all miniGram resources. Allows `kubectl delete namespace minigram` to remove everything at once.

### Secret

Stores sensitive data as base64-encoded values. Pods reference secrets with `valueFrom.secretKeyRef`. Secret values are decoded and injected as plain-text environment variables at container startup.

### Deployment (for stateless services)

Manages a set of identical pod replicas. If a pod crashes, the Deployment controller creates a replacement. Rolling updates: new pod starts, passes readiness probe, then old pod terminates.

### StatefulSet (for PostgreSQL)

Like a Deployment but with stable pod names (`postgres-0`) and stable storage. Each pod gets its own PersistentVolumeClaim. The same EBS volume re-attaches to `postgres-0` every time it restarts, even on a different node. Data survives pod restarts.

### Service (ClusterIP)

A stable virtual IP + DNS name in front of a set of pods. `db-service` resolves to the ClusterIP of the db-service Service within the cluster. Traffic is load-balanced across all healthy pods matching the selector.

### Ingress

Defines HTTP routing rules. The ALB controller reads this and creates a real AWS ALB. All traffic on the ALB routes to the ui-service Service on port 80.

### PersistentVolumeClaim (PVC)

A pod's request for storage. The EBS CSI driver fulfils this by calling `aws ec2 create-volume`, getting back a volume ID, then calling `aws ec2 attach-volume`. `ReadWriteOnce` access mode means one node at a time (an EBS block device constraint).

---

## Known Issues and Workarounds

### Pluralsight Sandbox Credential Expiry

Credentials expire after ~4 hours. When they expire, `kubectl` commands fail with `Unauthorized`. Re-export new credentials from the sandbox console and run `aws eks update-kubeconfig` again. The EKS cluster itself persists — you do not need to recreate it.

### OIDC Disabled in Pluralsight Sandbox

`eksctl create cluster` with `iam.withOIDC: true` attempts to create an OIDC identity provider in IAM. The sandbox blocks `iam:CreateOpenIDConnectProvider`. As a result, `eksctl create iamserviceaccount` (IRSA) cannot be used. The workaround (Step 3) attaches policies to the node role directly — broader than ideal but functional.

### Helm 5-Minute Timeout / Release Stuck "in use"

If DockerHub image pulls are slow, pods may not become `Ready` within `--timeout 5m`. Helm marks the release as failed but does NOT clean up the resources.

If you then try `helm install` again:
```
Error: INSTALLATION FAILED: cannot re-use a name that is still in use
```

Fix:
```bash
helm uninstall minigram -n minigram
# Wait for pods to terminate, then re-install
helm install minigram ./k8s/helm/minigram --namespace minigram --create-namespace
```

Check if images are being pulled (slow DockerHub, not a bug):
```bash
kubectl describe pod <stuck-pod-name> -n minigram
# Look for: "Pulling image" or "ImagePullBackOff" in Events
```

### exec format error (ARM Images on amd64 Nodes)

**Symptom:** All pods crash immediately on startup:
```bash
kubectl logs <pod-name> -n minigram
# standard_init_linux.go:228: exec user process caused: exec format error
```

**Cause:** Images built on Apple Silicon (M1/M2/M3/M4) are `linux/arm64`. EKS nodes are `linux/amd64` (x86_64). A binary compiled for one architecture cannot run on the other.

**Fix:**
```bash
# Rebuild all images for the correct architecture
docker buildx build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-<service>:latest \
  ./services/<service> --push

# Or rebuild all at once:
docker buildx bake --file docker-compose.yml \
  --set "*.platform=linux/amd64" \
  --push

# Then restart the deployments
kubectl rollout restart deployment -n minigram
```

### Large File Downloads Return Corrupted 718-byte Files

**Cause:** nginx `proxy_buffering` enabled for the download endpoint. nginx buffers the binary stream into its internal memory buffer, which fills up and truncates the response to the header size (~718 bytes).

**Fix:** Ensure `nginx.conf` has `proxy_buffering off` in the `/api/download/file` location block. See the Bugs and Fixes document for the complete analysis.

---

## Network Flow in Production

```
Browser
  │ HTTP to ALB DNS hostname
  ▼
AWS ALB (internet-facing, public subnets)
  │ Routes to ui-service pod IPs (target-type: ip, via VPC CNI)
  ▼
nginx in ui-service pod (port 80)
  │ /api/* → api-gateway:3000 (ClusterIP)
  │ / → serves index.html (Angular SPA)
  ▼
api-gateway pod (port 3000)
  │ /auth/* → auth-service:3001
  │ /groups/* → telegram-read-service:3002
  │ /download/* → telegram-download-service:3003 (timeout:0)
  │ /download/log-db → db-service:3006
  ▼
Individual service pods
  │ fetch(http://db-service:3006/...) for all persistence
  ▼
db-service pod (port 3006)
  │ pg Pool → postgres:5432
  ▼
postgres-0 pod
  │ mounted EBS volume (20 GB gp2)
```

All inter-service communication is over plain HTTP on the cluster's internal network. No TLS between services (acceptable for a private cluster network; a service mesh like Istio would add mTLS for production-grade security).

---

## Full Cluster Teardown

```bash
# Removes all AWS resources: EC2 instances, VPC, IAM roles, EBS volumes
eksctl delete cluster -f k8s/cluster/eksctl-cluster.yaml
```

**Warning:** This deletes the EBS volume containing the PostgreSQL data. Export the database first if the data matters:
```bash
kubectl exec postgres-0 -n minigram -- pg_dump -U minigram minigram > backup.sql
```

---

## CI/CD: GitHub Actions Smart Deploy

The workflow at `.github/workflows/deploy.yml` is triggered manually via `workflow_dispatch`. It is designed to be **idempotent** — safe to run multiple times. Each run detects existing state and skips or upgrades rather than blindly recreating.

### What It Does

**Job 1 — Build & Push (runs in parallel across all 7 services):**
- Builds each Docker image for `linux/amd64`.
- Pushes two tags: `:latest` and `:<git-sha>`.
- Uses GitHub Actions layer cache (`cache-from: type=gha`) — unchanged layers are not re-uploaded, making reruns fast.

**Job 2 — Deploy (runs after all images are pushed):**
Runs 6 steps sequentially. Each step is smart about existing state.

### Step-by-Step Logic

**Step 1 — Cluster:**
```
eksctl get cluster → exists?
  YES → aws eks update-kubeconfig (reconnect kubectl, skip 15-min creation)
  NO  → eksctl create cluster (full ~15-20 min setup)
```

**Step 2 — IAM policies:**
```
aws iam get-policy → ALB policy exists?
  NO  → create it from upstream JSON
  YES → skip

For each of 4 policies:
  list-attached-role-policies → already attached?
    YES → skip
    NO  → attach
```

**Step 3 — AWS Load Balancer Controller:**
```
helm status aws-load-balancer-controller → installed?
  YES → helm upgrade (apply any chart updates)
  NO  → helm install
kubectl rollout status → wait until controller pods are ready
```

**Step 4 — App deploy:**
```
helm upgrade --install  (handles both first install and upgrades in one command)
--create-namespace      (creates namespace if missing, no-ops if it exists)
Images pinned to :<git-sha> so every PR deploys its exact images
--wait --timeout 5m     (blocks until all pods pass readiness probes)
```

**Step 5 — ALB URL:**
```
Poll kubectl get ingress every 10s (up to 3 min) until ALB hostname appears
Compare new hostname vs current README
  SAME → skip git commit (no noise in history)
  DIFFERENT → sed-replace in README, commit with [skip ci]
```

**Step 6 — Verify:**
```
kubectl get pods -n minigram  (final sanity check, printed in workflow log)
```

### Behaviour on Repeated Runs

| Scenario | Cluster step | IAM step | ALB controller | App deploy |
|---|---|---|---|---|
| First ever run | Creates (~15 min) | Creates + attaches | Installs | Installs |
| Rerun, nothing changed | Skips | Skips all | Upgrades (no-op) | Upgrades (rolling restart) |
| Rerun after partial failure | Creates if missing | Attaches missing only | Installs/upgrades | Installs/upgrades |
| New PR with code changes | Skips cluster | Skips IAM | Upgrades controller | Upgrades pods to new SHA |

### Why `helm upgrade --install` Instead of `helm install`

`helm install` fails if the release already exists:
```
Error: INSTALLATION FAILED: cannot re-use a name that is still in use
```

`helm upgrade --install` is idempotent: installs on first run, upgrades on every subsequent run. No need to detect state manually for the app deploy step.

### Why Images Are Tagged with `github.sha`

Each run tags images with the commit SHA (e.g. `:abc1234`). Helm passes these SHA-tagged images to the deployment. This means:
- Every PR deploys its exact code, not whatever `:latest` happens to be.
- Rolling back is `helm rollback minigram 1 -n minigram` — Kubernetes pulls the old SHA image, not latest.
- Concurrent runs don't step on each other's images.

### Known Limitation: Sandbox Resets Every 4 Hours

The Pluralsight sandbox destroys all AWS resources every 4 hours. After a reset, the cluster is gone and the next workflow run does a full 15–20 minute creation. The smart-skip logic helps only within a single sandbox session. This is expected behaviour for a sandbox environment.
