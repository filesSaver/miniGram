# miniGram — Bugs and Fixes

This document records every significant bug encountered during development and deployment, with full root cause analysis, the exact fix applied, and why the bug happened in the first place.

---

## Bug 1: Download Files Corrupted — nginx Buffering

### Symptom

Clicking Download on a video or image file saves a file of approximately **718 bytes** with the correct filename but corrupt content. Opening the file in a text editor reveals it contains the Angular app's `index.html` rather than the expected binary data.

### When It Was Noticed

During testing after the first EKS deployment. Downloads appeared to work locally (the file downloaded and was valid). The bug only appeared in the production environment (the full Kubernetes stack with nginx in front).

### Root Cause

The Angular UI's `downloadFile()` method builds a download URL:

```ts
// BEFORE THE FIX (broken):
a.href = `${BASE_DIRECT}/download/file?groupId=...&messageId=...&token=...`;
```

In production, `BASE_DIRECT` is `''` (empty string), so the full href was:
```
/download/file?groupId=...&messageId=...&token=...
```

**nginx received `GET /download/file`.** It evaluated its `location` blocks:

- `location /api/download/file` — does NOT match (path does not start with `/api`)
- `location /api/` — does NOT match
- `location /` (catch-all) — **MATCHES**

The catch-all block has `try_files $uri $uri/ /index.html`. nginx looked for a file named `download/file` in `/usr/share/nginx/html/` (not found), then a directory (not found), then served `index.html` as the fallback. The browser received the Angular application HTML with a `200 OK` status and saved it as the download file.

The 718 bytes was the exact size of the compressed `index.html`. Every "download" returned this same corrupted file.

### Why It Was Invisible Locally

In local development, `BASE_DIRECT` is set to `'http://localhost:3000'` (the gateway address):
```ts
const BASE_DIRECT = (window.location.port === '4200') ? 'http://localhost:3000' : '';
```

So locally, the download URL was `http://localhost:3000/download/file?...`. The gateway has a route for `/download/*` that proxies to telegram-download-service. Downloads worked correctly in development.

The missing `/api/` prefix only caused a failure in the production nginx path, where the URL `localhost:3000` was not involved.

### The Fix

Two changes were needed:

**Fix 1: Add `/api/` to the download URL in `auth.service.ts`:**
```ts
// AFTER THE FIX:
a.href = `${BASE_DIRECT}/api/download/file?groupId=...&messageId=...&token=...`;
```

Now the URL in production is `/api/download/file?...`, which matches the specific `location /api/download/file` block in nginx.

**Fix 2 (pre-existing / defensive): Ensure `nginx.conf` has `proxy_buffering off` for the download route:**
```nginx
location /api/download/file {
    proxy_pass http://api-gateway:3000/download/file;
    proxy_buffering off;       # ← this must be present
    proxy_request_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_read_timeout 3600s;
}
```

Even if the URL had been correct from the start, if `proxy_buffering off` were absent, nginx would buffer the entire binary response into its internal memory buffer (~1MB default). For video files larger than ~1MB, the buffer would fill up, and nginx would truncate the response — still resulting in a corrupted file, just a larger one. The specific `location /api/download/file` block exists precisely to add this flag while keeping the general `/api/` block with default (buffered) settings for small JSON responses.

### Lesson

The bug combined two problems:
1. A missing URL prefix (`/api/`) that caused requests to fall through to the catch-all location block.
2. The fact that the incorrect behaviour (serving `index.html`) returns HTTP 200 with a plausible file size — the browser has no way to know the content is wrong and saves it without complaint.

Always verify downloaded files are valid after any change to the nginx config or the `downloadFile()` URL construction.

---

## Bug 2: exec format error — ARM Images on amd64 Nodes

### Symptom

All pods crash immediately after Helm deploys the application. `kubectl get pods -n minigram` shows all pods with `CrashLoopBackOff` or `Error` status. Checking any pod's logs:

```bash
kubectl logs auth-service-xxxxxxx -n minigram
# standard_init_linux.go:228: exec user process caused: exec format error
```

### When It Was Noticed

Immediately after `helm install` on the first EKS deployment from an Apple Silicon (M-series) MacBook.

### Root Cause

Docker's default behaviour on Apple Silicon (M1/M2/M3/M4) is to build images for the native CPU architecture: `linux/arm64`. EKS worker nodes are standard EC2 `t3.medium` instances, which are x86_64 (`linux/amd64`). A Linux binary compiled for ARM64 cannot execute on an AMD64 processor. The kernel refuses to run it with `exec format error`.

The `exec format error` message comes from the Linux kernel's binary loader, not from Docker or Kubernetes. It fires at the very first instruction of the binary — before Node.js prints any output — which is why the log is empty except for this single line.

This bug is silent during `docker compose up` on the development MacBook because Docker Desktop on Apple Silicon uses QEMU emulation to transparently run `arm64` containers. The images run fine locally. The problem only manifests when those same `arm64` images are pulled onto `amd64` nodes.

### The Fix

All images must be built for `linux/amd64` when targeting EKS.

**Build and push a single service:**
```bash
docker buildx build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-auth-service:latest \
  ./services/auth-service \
  --push
```

**Build and push all services at once:**
```bash
docker buildx create --use --name multiarch 2>/dev/null || true
docker buildx bake --file docker-compose.yml \
  --set "*.platform=linux/amd64" \
  --push
```

**`docker buildx`** is Docker's build system for cross-platform image creation. `--platform linux/amd64` instructs the builder to cross-compile for x86_64 even when running on an ARM Mac. The `--push` flag pushes the image to DockerHub immediately after building.

After rebuilding and pushing:
```bash
kubectl rollout restart deployment -n minigram
kubectl get pods -n minigram -w   # watch pods come up
```

### Prevention

Always use `--platform linux/amd64` when building images for EKS from an Apple Silicon machine. Consider adding this to a `Makefile` target or CI/CD pipeline to make it the default.

---

## Bug 3: Helm Timeout — Release Stuck "in use"

### Symptom

`helm install` runs for 5 minutes, then prints:
```
Error: INSTALLATION FAILED: timed out waiting for the condition
```

A subsequent `helm install` attempt returns:
```
Error: INSTALLATION FAILED: cannot re-use a name that is still in use
```

### When It Was Noticed

During initial EKS deployments when DockerHub image pulls were slow.

### Root Cause

`helm install --wait --timeout 5m` blocks until all pods reach `Ready` status or 5 minutes pass. If DockerHub is slow pulling large images (each service image is 150–250MB), pods remain in `ContainerCreating` or `ImagePullBackOff` status past the 5-minute window. Helm marks the release as **failed**.

However, `helm install` does not clean up the resources it created when it times out. The Namespace, Secret, Deployments, Services, StatefulSet, and Ingress all exist in the cluster and Kubernetes continues pulling images and starting pods in the background. The Helm release record exists in the cluster (stored as a Kubernetes Secret in the namespace) with a `failed` status.

When you try `helm install` again, Helm sees a release record with the name `minigram` already exists (even though it shows as failed) and refuses to overwrite it.

### The Fix

```bash
# Remove the failed release (does NOT destroy the EBS volume)
helm uninstall minigram -n minigram

# Wait for pods to fully terminate
kubectl get pods -n minigram -w

# Check if images are being pulled (this is normal, just slow)
kubectl describe pod <pod-name> -n minigram
# Look for: "Pulling image" in the Events section

# Once terminated, reinstall
helm install minigram ./k8s/helm/minigram \
  --namespace minigram \
  --create-namespace
```

If images were being pulled in the background (pods were not actually failing, just slow), it can help to skip `--wait` on the first install and monitor manually:
```bash
helm install minigram ./k8s/helm/minigram \
  --namespace minigram \
  --create-namespace
# (no --wait)

# Monitor separately
kubectl get pods -n minigram -w
```

### Prevention

- Build and push images to DockerHub before running `helm install` so node pulls are fast.
- Increase `--timeout` to `10m` for initial installs on slow connections.
- Avoid `--wait` during initial setup; verify manually instead.

---

## Bug 4: OIDC Disabled in Pluralsight Sandbox

### Symptom

`eksctl create cluster -f eksctl-cluster.yaml` completes but with a warning or error about OIDC provider creation. Later, `eksctl create iamserviceaccount` fails with:
```
Error: failed to create IAM OIDC provider
```

Or, if the OIDC step is attempted separately:
```
An error occurred (AccessDenied): User is not authorized to perform: iam:CreateOpenIDConnectProvider
```

### Root Cause

`eksctl-cluster.yaml` sets `iam.withOIDC: true`, which instructs eksctl to register an OIDC (OpenID Connect) identity provider in the AWS IAM service. This is required for IRSA (IAM Roles for Service Accounts) — the mechanism that allows specific Kubernetes pods to assume specific IAM roles without sharing credentials.

The Pluralsight sandbox restricts IAM permissions for security reasons. The `iam:CreateOpenIDConnectProvider` action is not granted to sandbox users, so the OIDC provider creation fails.

Without OIDC, the standard way to give the AWS Load Balancer Controller IAM permissions (`eksctl create iamserviceaccount ...`) does not work.

### The Fix (Workaround)

Skip IRSA entirely and attach the required IAM policies directly to the EC2 worker node instance role:

```bash
NODE_ROLE=$(aws iam list-roles \
  --query "Roles[?contains(RoleName,'NodeInstanceRole')].RoleName" \
  --output text)

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

When installing the ALB controller with Helm, set `serviceAccount.create=true` (creates a service account without IRSA annotations):
```bash
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=minigram \
  --set serviceAccount.create=true \
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

**Why this works:** Every EC2 worker node runs under an IAM instance role. Any pod on that node can use that role's permissions via the EC2 instance metadata service (IMDS). By attaching the ALB controller's required policies to the node role, the controller pod inherits them.

**Why this is less secure:** IRSA restricts permissions to a specific service account in a specific namespace in a specific cluster. The node role workaround grants those permissions to every pod on every node — including pods from other deployments. This is acceptable for a sandbox/demo environment but not for production.

**In a real production account with proper IAM permissions**, use the standard IRSA flow:
```bash
eksctl utils associate-iam-oidc-provider --region us-east-1 --cluster minigram --approve
eksctl create iamserviceaccount \
  --cluster=minigram \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --attach-policy-arn=arn:aws:iam::<ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy \
  --override-existing-serviceaccounts \
  --approve
```

---

## Bug 5: `docker login` Required Before Push

### Symptom

```bash
docker push sauravmehta/content-scrapper-auth-service:latest
# denied: requested access to the resource is denied
```

Or with `docker buildx bake --push`:
```
error: failed to push image: denied: requested access to the resource is denied
```

### Root Cause

DockerHub requires authentication before pushing images. By default, `docker` commands use anonymous access for pulls but reject pushes from unauthenticated users. The error message "denied: requested access to the resource is denied" is DockerHub's way of saying "you are not authenticated as the owner of this repository."

This error also appears if you are logged in but pushing to a repository name that does not match your DockerHub username (e.g., trying to push to `sauravmehta/...` while logged in as a different account).

### The Fix

```bash
docker login
# Enter your DockerHub username (sauravmehta) and password when prompted
```

`docker login` without arguments logs into DockerHub (`docker.io`). Credentials are stored in `~/.docker/config.json` and persist across terminal sessions. You only need to log in once per machine (until the token expires or you log out).

After login, `docker push` and `docker buildx bake --push` work normally.

**If you have Two-Factor Authentication enabled on DockerHub**, you must use a DockerHub Access Token instead of your account password:
1. Go to DockerHub → Account Settings → Security → New Access Token.
2. Use the token as the password in `docker login`.

---

## Bug 6: Pluralsight Sandbox Credential Expiry Mid-Session

### Symptom

`kubectl` commands that were working suddenly fail:
```
error: You must be logged in to the server (Unauthorized)
```

Or AWS CLI commands fail:
```
An error occurred (ExpiredTokenException): The security token included in the request is expired
```

### Root Cause

Pluralsight sandbox AWS credentials expire after approximately 4 hours. The session token (`AWS_SESSION_TOKEN`) becomes invalid. The kubeconfig that was written by `aws eks update-kubeconfig` embeds the AWS credentials that were valid at the time it was created — those credentials are now expired.

### The Fix

1. Get new credentials from the Pluralsight sandbox console (there is a "AWS credentials" or "Lab credentials" section that shows the current temporary access key, secret, and session token).

2. Export the new credentials in your terminal:
```bash
export AWS_ACCESS_KEY_ID="new_key"
export AWS_SECRET_ACCESS_KEY="new_secret"
export AWS_SESSION_TOKEN="new_token"
```

3. Update kubeconfig to use the new credentials:
```bash
aws eks update-kubeconfig --region us-east-1 --name minigram
```

4. Verify:
```bash
kubectl get nodes
```

**The cluster itself is not affected.** It keeps running regardless of whether your local credentials are valid. Only your local access to the cluster is broken during the credential gap.

---

## Bug 7: Auth Service Starts Then Immediately Exits

### Symptom

`docker compose up` shows auth-service starting, then repeatedly restarting. `docker compose logs auth-service` shows:
```
[auth-service] FATAL: JWT_SECRET is not set
```

The container exits with code 1. Docker's `restart: unless-stopped` policy restarts it, causing a restart loop.

### Root Cause

The auth-service (and other JWT-consuming services) call `process.exit(1)` at startup if `JWT_SECRET` is not set in the environment:

```js
if (!JWT_SECRET) {
  console.error('[auth-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}
```

This is an intentional fail-fast guard. If `JWT_SECRET` were missing, the service would start and silently accept requests but fail to verify any JWT — a confusing and dangerous failure mode. The immediate exit makes the misconfiguration obvious.

### The Fix

Ensure `JWT_SECRET` is defined in the `.env` file at the project root:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

Then restart:
```bash
docker compose up
```

Also applies to any service that validates `JWT_SECRET` at startup: telegram-read-service and telegram-download-service.

---

## Bug 8: `dotenv` Imported but Never Called in api-gateway

### Symptom

Running the api-gateway outside of Docker (directly with `node server.js`) without first exporting environment variables causes it to use `localhost:*` defaults for all downstream service URLs, even if a `.env` file is present.

### Root Cause

The `dotenv` package is listed as a production dependency in `package.json` but `require('dotenv').config()` is never called in `server.js`. Docker Compose injects environment variables directly via the `environment:` block, so dotenv is never needed in the Docker workflow. But for running outside Docker with a `.env` file, the call is missing.

### The Fix

Add `require('dotenv').config()` at the top of `api-gateway/server.js` if local non-Docker development is needed:

```js
require('dotenv').config();   // add this line
const express = require('express');
// ...
```

This is a low-priority fix because the service runs correctly inside Docker (where environment variables are always injected by Docker Compose or Kubernetes). The issue only affects the uncommon case of running the gateway directly with `node server.js`.

---

## Summary Table

| # | Bug | Where | Symptom | Root Cause | Fix |
|---|-----|--------|---------|------------|-----|
| 1 | Download files corrupted | ui-service nginx + auth.service.ts | 718-byte file containing HTML | Missing `/api/` prefix in download URL; fell through to nginx catch-all → served index.html | Add `/api/` to download URL; ensure `proxy_buffering off` in nginx download location |
| 2 | exec format error | All pods on EKS | Immediate crash: `exec format error` | ARM64 images built on Apple Silicon, deployed to AMD64 EKS nodes | Build with `--platform linux/amd64` using `docker buildx` |
| 3 | Helm timeout / stuck release | EKS deployment | `cannot re-use a name that is still in use` | Slow DockerHub pulls exceeded `--wait --timeout 5m`; Helm marked release failed but left resources | `helm uninstall minigram -n minigram`, wait for termination, reinstall |
| 4 | OIDC disabled | AWS IAM / Pluralsight sandbox | `AccessDenied: iam:CreateOpenIDConnectProvider` | Sandbox IAM restrictions prevent OIDC provider creation needed for IRSA | Attach ALB controller policies to node instance role directly |
| 5 | docker login required | DockerHub push | `denied: requested access to the resource is denied` | Not authenticated to DockerHub before push | `docker login` with DockerHub credentials |
| 6 | Credential expiry | kubectl / AWS CLI | `Unauthorized` / `ExpiredTokenException` | Pluralsight sandbox credentials expire after ~4 hours | Export new credentials, run `aws eks update-kubeconfig` |
| 7 | Auth service restart loop | auth-service startup | `FATAL: JWT_SECRET is not set` | `JWT_SECRET` missing from `.env` file | Add `JWT_SECRET` to `.env` |
| 8 | dotenv not called | api-gateway server.js | `.env` file ignored outside Docker | `dotenv` in `package.json` but `require('dotenv').config()` not in server.js | Add `require('dotenv').config()` at top of server.js |
