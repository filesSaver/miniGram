# miniGram EKS Deploy Log

## Cluster Info
- **Cluster:** `minigram` (eksctl, us-east-1, 2x t3.medium)
- **Namespace:** `minigram`
- **Registry:** DockerHub (`sauravmehta/`)
- **ALB URL:** `http://k8s-minigram-minigram-3e16dfc8d5-1427249512.us-east-1.elb.amazonaws.com`
- **AWS Sandbox Account:** `259939863830` (Pluralsight — credentials reset each session)

---

## AWS Credentials (each sandbox session)
```bash
export AWS_ACCESS_KEY_ID=<key>
export AWS_SECRET_ACCESS_KEY=<secret>
export AWS_SESSION_TOKEN=<token>
export AWS_DEFAULT_REGION=us-east-1
```
Verify: `aws sts get-caller-identity` → should show account `259939863830`

---

## Standard Redeploy Sequence

```bash
# 1. Verify identity
aws sts get-caller-identity

# 2. Connect kubectl to EKS
aws eks update-kubeconfig --region us-east-1 --name minigram

# 3. Check all pods are running
kubectl get pods -n minigram

# 4. Build & push changed service (example: ui-service)
docker build -t sauravmehta/content-scrapper-ui-service:latest ./services/ui-service
docker push sauravmehta/content-scrapper-ui-service:latest

# 5. Restart the deployment
kubectl rollout restart deployment/ui-service -n minigram

# 6. Watch rollout
kubectl rollout status deployment/ui-service -n minigram

# 7. Check logs if something is wrong
kubectl logs -n minigram deployment/ui-service --tail=50
```

---

## Session: 2026-09-21

### Bug: All file downloads corrupted on EKS (any file size)

**Symptom:** Any file downloaded via the ALB returns a tiny corrupted response (e.g. 718 bytes instead of the real file). Works fine on local Docker Compose.

**Root cause:** nginx in `ui-service` buffers all proxy responses by default. The generic `/api/` location block had no `proxy_buffering off`, so nginx buffered the entire binary stream — truncating it when buffer limits were hit. This was invisible locally because Docker Compose routes the browser directly to api-gateway without nginx in the path.

The SSE (breakdown/stream) routes already had `proxy_buffering off` correctly — the download route was just missed.

**Fix applied:** `services/ui-service/nginx.conf`
- Added dedicated `location /api/download/file` block with `proxy_buffering off`, `proxy_request_buffering off`, HTTP/1.1, and 3600s timeouts.
- Added same fix to `location /api/download/batch` (had extended timeouts but was still buffering).

**Status:** Fix committed locally. Pending redeploy to EKS.

---

### Steps Executed

| # | Command | Result |
|---|---------|--------|
| 1 | `aws sts get-caller-identity` | Pending |
| 2 | `aws eks update-kubeconfig --region us-east-1 --name minigram` | Pending |
| 3 | `kubectl get pods -n minigram` | Pending |
| 4 | `docker build -t sauravmehta/content-scrapper-ui-service:latest ./services/ui-service` | Pending |
| 5 | `docker push sauravmehta/content-scrapper-ui-service:latest` | Pending |
| 6 | `kubectl rollout restart deployment/ui-service -n minigram` | Pending |
| 7 | `kubectl rollout status deployment/ui-service -n minigram` | Pending |
| 8 | Test download on ALB URL | Pending |

---

---

## Session: 2026-09-21 — Cluster Recreation

### Situation
Pluralsight sandbox reset — cluster `minigram` no longer exists. Full recreation needed.

### Known issue from last session
`eksctl create iamserviceaccount` (IRSA) fails in Pluralsight sandbox because OIDC provider creation is restricted. Workaround last time: attach IAM policies directly to the node instance role instead.

### Steps to recreate cluster

**Step 1 — Create cluster (~15-20 min)**
```bash
eksctl create cluster -f k8s/cluster/eksctl-cluster.yaml
```

**Step 2 — Install ALB Controller IAM policy**
```bash
curl -sSL https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json -o /tmp/alb-iam-policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file:///tmp/alb-iam-policy.json
```

**Step 3 — Attach policies directly to node role (sandbox workaround)**
```bash
# Get the node role name
NODE_ROLE=$(aws iam list-roles --query "Roles[?contains(RoleName,'NodeInstanceRole')].RoleName" --output text)
echo $NODE_ROLE

# Attach required policies
aws iam attach-role-policy --role-name $NODE_ROLE --policy-arn arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess
aws iam attach-role-policy --role-name $NODE_ROLE --policy-arn arn:aws:iam::aws:policy/AmazonEC2FullAccess
aws iam attach-role-policy --role-name $NODE_ROLE --policy-arn arn:aws:iam::aws:policy/AWSWAFFullAccess
aws iam attach-role-policy --role-name $NODE_ROLE --policy-arn arn:aws:iam::259939863830:policy/AWSLoadBalancerControllerIAMPolicy
```

**Step 4 — Install ALB Controller via Helm (no IRSA)**
```bash
VPC_ID=$(aws eks describe-cluster --name minigram --region us-east-1 --query 'cluster.resourcesVpcConfig.vpcId' --output text)

helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=minigram \
  --set serviceAccount.create=true \
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

**Step 5 — Deploy miniGram**
```bash
helm install minigram ./k8s/helm/minigram \
  --namespace minigram \
  --create-namespace \
  --wait \
  --timeout 5m
```

**Step 6 — Get new ALB URL**
```bash
kubectl get ingress minigram-ingress -n minigram
```

---

### Command Log

| # | Command | Output / Error |
|---|---------|----------------|
| 1 | `aws sts get-caller-identity` | ✅ Account 259939863830 confirmed |
| 2 | `eksctl get cluster --region us-east-1` | ❌ No clusters found — sandbox reset |
| 3 | `eksctl create cluster -f k8s/cluster/eksctl-cluster.yaml` | ✅ Cluster created, 2 nodes ready (ip-192-168-125-48, ip-192-168-74-127). OIDC disabled in sandbox — IRSA workaround needed for ALB controller. |
| 4 | Get node role name | ✅ `eksctl-minigram-nodegroup-minigram-NodeInstanceRole-YzZbUcyJLl1S` |
| 5 | Attach IAM policies to node role | ✅ ElasticLoadBalancingFullAccess, AmazonEC2FullAccess, AWSWAFFullAccess — silent success |
| 6 | Install ALB controller via Helm | ✅ Installed. Note: first attempt failed with "Chart cannot be installed without a valid clusterName" — happened because terminal split the command before `--set clusterName=minigram` was passed. Second run succeeded. VPC: vpc-04a9284906d94922a |
| 7 | Deploy miniGram via Helm | ✅ Deployed. Note: deprecation warning on `kubernetes.io/ingress.class` annotation — harmless for now but should migrate to `spec.ingressClassName` eventually |
| 8 | Check pods + get ALB URL | ✅ All 9 pods Running. New ALB: `k8s-minigram-minigram-3e16dfc8d5-1226055827.us-east-1.elb.amazonaws.com` |
### Bug: Download URL missing `/api/` prefix in production

**Symptom:** Download hits `/download/log-db/...` instead of `/api/download/file` — returns 2 bytes of JSON, not the file.

**Root cause:** `auth.service.ts:116` — `downloadFile()` builds the URL as `${BASE_DIRECT}/download/file?...`. In production `BASE_DIRECT` is `''` (empty string), so the path becomes `/download/file` with no `/api/` prefix. nginx never matches the download location block and the request falls through to the wrong route.

Locally `BASE_DIRECT` is `http://localhost:3000` (direct to api-gateway), which also has no `/api/` prefix — and the api-gateway exposes `/download/file` directly, so it worked fine locally.

**Fix applied:** `services/ui-service/src/app/services/auth.service.ts` line 116
- Changed `/download/file` → `/api/download/file`

**Status:** Fix committed. Rebuild + redeploy needed.

---

| 9 | `docker-compose build` | ✅ All 8 images built successfully |
| 10 | `docker-compose push` | ❌ `denied: requested access to the resource is denied` — not logged in to DockerHub. Fix: `docker login -u sauravmehta` then retry |
| 11 | `docker-compose push` (after login) | ✅ All images pushed |
| 12 | `helm install minigram` (new sandbox) | ❌ Timeout after 5m — pods still pulling images. Release stuck as "in use". |
| 13 | `kubectl get pods -n minigram` | ❌ All pods `CrashLoopBackOff` or `Init:0/1`. Logs: `exec format error` |

### Bug: `exec format error` — ARM images on amd64 nodes

**Symptom:** All pods crash immediately with `exec format error`.

**Root cause:** Images built on Apple Silicon (ARM64) using `docker-compose build`. EKS nodes are `x86_64` (amd64). ARM images cannot run on amd64 nodes.

**Fix:** Rebuild all images targeting `linux/amd64` using buildx, then restart all deployments:
```bash
docker buildx create --use --name multiarch 2>/dev/null || true
docker buildx bake --file docker-compose.yml --set "*.platform=linux/amd64" --push

kubectl rollout restart deployment -n minigram
kubectl get pods -n minigram -w
```

**Note for future:** Always build with `--platform linux/amd64` when deploying to EKS from an Apple Silicon Mac.

| 14 | `docker buildx bake --platform linux/amd64 --push` | ✅ All 8 images rebuilt for amd64 and pushed |
| 15 | `kubectl rollout restart deployment -n minigram` | ✅ All 9 pods Running with new amd64 images |
| 16 | Test file download | Pending |

---

## PostgreSQL Access

**Connect to the postgres pod:**
```bash
kubectl exec -it postgres-0 -n minigram -- psql -U minigram -d minigram
```

**Credentials** (from `k8s/helm/minigram/templates/secret.yaml`):
- User: `minigram`
- Password: `MyStr0ngPass123`
- Database: `minigram`

**Useful queries:**
```sql
\dt                                              -- list all tables
SELECT id, username FROM users;                 -- list users
SELECT id, username, password_hash FROM users;  -- with password hashes
\q                                              -- exit
```

**Note:** `psql -U postgres` fails — there is no `postgres` superuser. Always use `-U minigram`.

---

## Session: 2026-09-22 — GitHub Actions CI/CD

### What was set up

Created `.github/workflows/deploy.yml` — a manual-trigger GitHub Actions workflow that builds, pushes, and deploys the full stack to EKS.

**Trigger:** Manual only — GitHub UI → Actions → "Build, Push & Deploy to EKS" → Run workflow

**Job 1 — Build & Push** (parallel matrix, all 7 services):
- Builds each image tagged as `:latest` and `:<git-sha>`
- Pushes to Docker Hub (`sauravmehta/content-scrapper-*`)
- Uses GitHub Actions layer cache per service to speed up rebuilds

**Job 2 — Create Cluster & Deploy** (runs after all builds pass):
- Authenticates to AWS using GitHub Secrets
- Installs `eksctl` on the runner
- Creates a **fresh EKS cluster** every time (`eksctl create cluster`) — sandbox resets every 4h so the cluster never exists
- Attaches IAM policies directly to the node role (sandbox workaround — OIDC/IRSA is restricted in Pluralsight)
- Installs AWS Load Balancer Controller via Helm (no IRSA)
- Runs `helm install` with the `:<git-sha>` images just built
- Polls for ALB URL and prints it at the end

### Required GitHub Secrets

Go to: repo → Settings → Secrets and variables → Actions → New repository secret

| Secret | Value |
|--------|-------|
| `DOCKERHUB_USERNAME` | `sauravmehta` |
| `DOCKERHUB_TOKEN` | Docker Hub access token (hub.docker.com → Account Settings → Security) |
| `AWS_ACCESS_KEY_ID` | From Pluralsight sandbox (update each new session) |
| `AWS_SECRET_ACCESS_KEY` | From Pluralsight sandbox (update each new session) |

> **Important:** AWS credentials are Pluralsight sandbox credentials that reset each session. Update the two AWS secrets in GitHub before running the workflow in a new lab session.

### Key design notes

- **Platform fix baked in:** GitHub Actions runners are `linux/amd64` — no more ARM vs amd64 mismatch from building on Apple Silicon locally.
- **`--reuse-values`:** Helm keeps all existing values (secrets, postgres config, ingress) and only overrides the image tags. Safe to run without touching `values.yaml`.
- **Git SHA tagging:** Every deploy is traceable — `:<git-sha>` tag matches the exact commit deployed.
