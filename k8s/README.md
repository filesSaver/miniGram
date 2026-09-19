# miniGram — AWS EKS Deployment Guide
### For someone new to AWS and Kubernetes

---

## Table of Contents

1. [What is all of this? (Concepts explained)](#1-what-is-all-of-this-concepts-explained)
2. [What will be created in your AWS account](#2-what-will-be-created-in-your-aws-account)
3. [Cost estimate](#3-cost-estimate)
4. [Using Pluralsight Cloud Labs Sandbox (RECOMMENDED for learning)](#using-pluralsight-cloud-labs-sandbox-recommended-for-learning)
5. [Step 0 — Create a real AWS account and IAM user (skip if using sandbox)](#step-0--create-a-real-aws-account-and-iam-user-skip-if-using-sandbox)
6. [Step 1 — Install required tools](#step-1--install-required-tools)
7. [Step 2 — Configure AWS credentials on your laptop](#step-2--configure-aws-credentials-on-your-laptop)
8. [Step 3 — Fill in your secrets](#step-3--fill-in-your-secrets)
9. [Step 4 — Run the deploy script](#step-4--run-the-deploy-script)
10. [Step 5 — Open your app in the browser](#step-5--open-your-app-in-the-browser)
11. [How to update the app after code changes](#how-to-update-the-app-after-code-changes)
12. [Day-to-day useful commands](#day-to-day-useful-commands)
13. [File structure explained](#file-structure-explained)
14. [How all the pieces connect (Architecture)](#how-all-the-pieces-connect-architecture)
15. [Troubleshooting](#troubleshooting)
16. [How to shut everything down](#how-to-shut-everything-down)

---

## 1. What is all of this? (Concepts explained)

If you are new to AWS and Kubernetes, read this section first. Skip it if you already know these terms.

### What is AWS?
AWS (Amazon Web Services) is a cloud platform — it lets you rent computers, storage, databases, and networking from Amazon instead of buying your own hardware. You pay only for what you use.

### What is a container?
Your app is packaged as Docker containers. Think of a container as a box that contains your app and everything it needs to run (Node.js, your code, dependencies). It runs identically on any computer.

### What is Kubernetes (K8s)?
Kubernetes is a system that manages your containers. You tell it "I want 1 copy of auth-service running at all times" and Kubernetes makes sure that's always true — if it crashes, Kubernetes restarts it automatically. It also handles networking between containers.

### What is EKS?
EKS (Elastic Kubernetes Service) is AWS's managed Kubernetes. Instead of installing and maintaining Kubernetes yourself (very complex), AWS runs the Kubernetes "brain" (called the control plane) for you. You just add worker machines (EC2 nodes) and deploy your app.

### What is a Node?
A node is a real EC2 virtual machine (computer) in AWS that runs your containers. We use `t3.medium` nodes — each has 2 CPU cores and 4 GB RAM. We start with 2 nodes and auto-scale to 3 if needed.

### What is a Pod?
A pod is the smallest unit in Kubernetes. Each pod runs one container (one service). For example, `auth-service` runs as one pod on one of your nodes.

### What is a Deployment?
A Deployment tells Kubernetes: "keep N copies of this pod running". If a pod crashes, the Deployment restarts it. If you push new code, the Deployment rolls it out smoothly.

### What is a Service (Kubernetes)?
Pods get random IP addresses that change on restart. A Kubernetes Service gives a stable name (like `auth-service`) that other pods use to find each other. Think of it like a phone book entry — the name always resolves to the right pod.

### What is a StatefulSet?
Like a Deployment, but for apps that need to store data on disk (like a database). It guarantees the pod always gets the same storage volume back after a restart. We use this for PostgreSQL.

### What is a PersistentVolumeClaim (PVC)?
A request for disk storage. When PostgreSQL starts, it asks for 20 GB of disk. Kubernetes fulfils this by creating an EBS volume (Amazon's cloud hard drive) and attaching it to the pod.

### What is EBS?
EBS (Elastic Block Store) is Amazon's cloud hard drive service. When PostgreSQL stores your data, it goes on an EBS volume. The data persists even if the pod or node is restarted.

### What is Helm?
Helm is a package manager for Kubernetes — like npm for Node.js, but for Kubernetes apps. Instead of applying 20 YAML files one by one with `kubectl apply`, you run `helm install` once and Helm applies everything in the right order. The YAML files we wrote are a "Helm chart".

### What is an Ingress / ALB?
An Ingress is a Kubernetes resource that defines how outside traffic enters the cluster. We use the AWS ALB (Application Load Balancer) — it's a managed AWS service that receives traffic from the internet and routes it to the right pods. It gives you a public DNS address like `k8s-minigram-xxx.ap-south-1.elb.amazonaws.com`.

### What is eksctl?
`eksctl` is a command-line tool that creates EKS clusters. Instead of clicking through 50 pages in the AWS console, you run one command and it sets everything up automatically.

### What is kubectl?
`kubectl` is the command-line tool for talking to Kubernetes. You use it to check pod status, view logs, describe resources, etc.

### What is a Namespace?
A namespace is like a folder inside your Kubernetes cluster. All miniGram resources live in the `minigram` namespace. This isolates them from any other apps you might run in the same cluster.

### What is a Secret?
A Kubernetes Secret stores sensitive values (passwords, API keys) separately from your app config. Values are base64-encoded and injected into pods as environment variables. They are never stored in your Docker images.

---

## 2. What will be created in your AWS account

When you run the deploy script, the following resources are created:

| Resource | What it is | Why |
|---|---|---|
| **EKS Cluster** | The Kubernetes control plane | The "brain" that manages all your pods |
| **2 × EC2 t3.medium nodes** | Virtual machines that run your containers | The actual computers your app runs on |
| **VPC** | A private network in AWS | Isolates your cluster from the internet except through the ALB |
| **ALB** | Application Load Balancer | Your public URL — receives internet traffic and routes it to your app |
| **EBS Volume (20 GB)** | Cloud hard drive | Stores PostgreSQL data permanently |
| **IAM Roles** | AWS permissions | Allows the ALB controller to create load balancers on your behalf |
| **ECR** | (Not used — images stay on Docker Hub) | — |

All resources are in region **ap-south-1 (Mumbai)**.

---

## 3. Cost estimate

> **If you are using the Pluralsight sandbox: $0. Skip this section entirely.**

For a real AWS account (for future reference when you go to production):

| Resource | Monthly cost (approx) |
|---|---|
| 2 × t3.medium EC2 nodes | ~$60 |
| EKS control plane | ~$73 |
| ALB | ~$16 |
| EBS 20 GB gp2 | ~$2 |
| Data transfer | ~$1–5 depending on usage |
| **Total** | **~$150–160/month** |

> **To avoid charges when not using the app:** Run `eksctl delete cluster -f k8s/cluster/eksctl-cluster.yaml` to delete everything. See [How to shut everything down](#how-to-shut-everything-down).

---

## Using Pluralsight Cloud Labs Sandbox (RECOMMENDED for learning)

If you have a Pluralsight subscription, use their Cloud Labs sandbox instead of a real AWS account. It gives you a real, fully functional AWS environment at **zero cost to you** — Pluralsight pays the AWS bill.

### What the Pluralsight sandbox gives you
- A **real AWS account** with real AWS services (EKS, EC2, ALB, EBS — everything works)
- **No credit card** needed from you
- **Full admin permissions** inside the sandbox account
- Automatically **shuts down and wipes clean** at the time shown on the screen
- A fixed region — **`us-east-1` (US East - N. Virginia)**

### What "auto shutdown" means
When the timer runs out, AWS **deletes everything** that was created during that session:
- Your EKS cluster is gone
- Your PostgreSQL data is gone
- Your app URL stops working

This is completely fine for **learning and testing** — you are practising the deployment process, not running a permanent app.

### Important time constraint
Your sandbox auto-shuts down at a fixed time (shown as "Auto Shutdown at X:XXAM" on the screen). EKS cluster creation takes **15–20 minutes**. So **start a session with at least 2.5 hours remaining** or you won't have enough time to deploy and actually use the app.

---

### How to start a Pluralsight sandbox session

1. Go to https://app.pluralsight.com → log in
2. Navigate to **Cloud Labs** in the top menu
3. Search for **"AWS"** or **"Amazon EKS"** in the lab catalogue and start a lab
4. A panel appears that looks like this:

```
Username:        cloud_user
Password:        B&4ZOv0q-sL9jc*{6lDQ    ← for logging into AWS Console (browser)
Access Key Id:   AKIAU6GD27NU7BP5N6W3    ← for CLI access (what we use)
Secret Access Key: JiN9J9JdeVvPjdCEK...  ← for CLI access (what we use)
Sandbox URL:     https://339713129321.signin.aws.amazon.com/console?region=us-east-1
```

5. You only need the **Access Key Id** and **Secret Access Key** for the CLI deployment
6. The **Username + Password** are only for logging into the AWS web console in a browser (optional — useful for visually watching resources being created)
7. Note the **Auto Shutdown** time — that is your deadline

> **Tip:** Open the Sandbox URL in an incognito/private window as Pluralsight recommends. This avoids your personal AWS account cookies interfering.

---

### What is different about the sandbox vs a real AWS account

When people talk about AWS CLI setup online, they often mention a **Session Token** as a third credential. Here is the full picture:

| Credential type | Real AWS account | Some sandbox providers | Pluralsight sandbox (yours) |
|---|---|---|---|
| Access Key ID | ✅ Required | ✅ Required | ✅ Required |
| Secret Access Key | ✅ Required | ✅ Required | ✅ Required |
| Session Token | ❌ Not needed | ✅ Required (extra step) | ❌ Not needed |

**What is a Session Token and why do some sandboxes need it?**
A Session Token is a short-lived temporary credential that expires in minutes or hours. AWS generates it when you use `AssumeRole` (temporarily borrowing permissions). Some sandbox providers (like AWS Academy, Qwiklabs) give you temporary role credentials which include a Session Token. If you use those without setting the token, every AWS CLI command fails with `InvalidClientTokenId`.

**Your Pluralsight sandbox gives you permanent IAM user keys** (`AKIA...` — notice the prefix starts with `AKIA`, not `ASIA`). `AKIA` = long-term IAM user key. `ASIA` = short-term assumed role key that needs a Session Token. Since yours starts with `AKIA`, you are safe — no Session Token step needed.

**What we are also skipping because of sandbox:**
- ❌ Creating an AWS account (sandbox gives you one)
- ❌ Creating an IAM user (sandbox gives you `cloud_user` pre-made)
- ❌ Attaching IAM policies (sandbox user already has full admin access)
- ❌ Generating access keys (sandbox gives you pre-made keys)
- ❌ Worrying about cost (sandbox pays the bill)
- ❌ Session Token setup (not needed for `AKIA` keys)
- ❌ `aws configure` (we use `export` instead — no files written, other projects unaffected)

**What you still do exactly the same as a real AWS account:**
- ✅ Install tools (aws, eksctl, kubectl, helm) — same on any laptop
- ✅ `aws configure` — same command, just paste sandbox keys
- ✅ Fill in `secret.yaml` — same process
- ✅ `bash k8s/deploy.sh` — same script, same output
- ✅ All `kubectl` commands — identical
- ✅ All `helm` commands — identical

So the sandbox removes all the account setup overhead and lets you go straight to the actual deployment.

---

### Sandbox-specific Step 2 — Configure credentials (safe for this terminal only)

> **Important:** Do NOT use `aws configure` — it writes credentials to `~/.aws/credentials` on disk and affects every project on your laptop permanently.
>
> Instead, use **environment variables** — they exist only in the current terminal window and vanish the moment you close it. Nothing is written to disk, other projects are completely unaffected.

Open your terminal and paste these 3 lines (copy values from your sandbox panel):

```bash
export AWS_ACCESS_KEY_ID="paste_Access_Key_Id_here"
export AWS_SECRET_ACCESS_KEY="paste_Secret_Access_Key_here"
export AWS_DEFAULT_REGION="us-east-1"
```

**What `export` does:** Sets environment variables in the current shell session only. Every command you run in this terminal (aws, eksctl, kubectl, helm) automatically picks them up. Close the terminal → credentials are gone.

Verify it worked:
```bash
aws sts get-caller-identity
```

Expected output (account number will match your sandbox):
```json
{
    "UserId": "AIDA...",
    "Account": "339713129321",
    "Arn": "arn:aws:iam::339713129321:user/cloud_user"
}
```

If you see this — you are connected. If you get an error, re-paste the export commands carefully (no extra spaces, no newlines).

> **Every new sandbox session:** Open a fresh terminal, paste the 3 new `export` lines with the new session's credentials, and you're ready. The old credentials are already gone since the previous terminal was closed.

---

### Sandbox session workflow (what to do each time)

Every time you start a **new** sandbox session, the credentials change — repeat Steps 2–4:

| Step | What to do | Time taken |
|---|---|---|
| Start sandbox | Open Pluralsight Cloud Labs, start a lab | 1 min |
| Configure credentials | `aws configure` with new keys | 1 min |
| Fill secrets | Already done — skip if `secret.yaml` is filled in | 0 min |
| Create cluster | `bash k8s/deploy.sh` | 15–20 min |
| Use and test the app | Your actual testing window | ~2 hours |
| Sandbox auto-shuts down | Everything wiped — nothing to clean up | 0 min |

> `secret.yaml` values (JWT_SECRET, POSTGRES_PASSWORD etc.) stay the same every session — you only fill those in **once** ever.

---

### What you can learn and validate in each session

Each sandbox session is enough to:
- ✅ Watch the full EKS cluster creation process (eksctl output)
- ✅ See all 9 pods come up and reach `Running` state
- ✅ Access the app through the public ALB URL in a browser
- ✅ Test the login flow, Telegram group reading, file downloads end-to-end
- ✅ Practice `kubectl get pods`, `kubectl logs`, `kubectl describe pod`
- ✅ Intentionally break something and debug it with kubectl
- ✅ Practice `helm upgrade` after changing a value
- ✅ Watch the AWS Console while the cluster builds (EC2, VPC, EKS pages)
- ✅ Practice clean shutdown with `helm uninstall` or `eksctl delete cluster`

---

## Step 0 — Create a real AWS account and IAM user (skip if using sandbox)

### 0a. Create an AWS account
Go to https://aws.amazon.com and click "Create an AWS Account". You need a credit card. AWS has a free tier but EKS is NOT free.

### 0b. Create an IAM user (do NOT use root account for deployments)

The root account is the master account with your email/password. Never use it for CLI access — it's too powerful. Instead, create an IAM user:

1. Log into AWS Console → search "IAM" → open IAM
2. Click **Users** → **Create user**
3. Username: `minigram-deploy` (or anything you like)
4. Click **Next**
5. Select **Attach policies directly**
6. Search and attach these policies:
   - `AdministratorAccess` (simplest for a personal project — gives full AWS access)
   - OR if you want tighter security, attach: `AmazonEKSClusterPolicy`, `AmazonEKSWorkerNodePolicy`, `AmazonEC2FullAccess`, `IAMFullAccess`, `AmazonVPCFullAccess`
7. Click **Create user**
8. Click on the user you just created → **Security credentials** tab
9. Scroll to **Access keys** → **Create access key**
10. Choose **Command Line Interface (CLI)**
11. Download the CSV or copy the **Access Key ID** and **Secret Access Key** — you will need these in Step 2

---

## Step 1 — Install required tools

Install all four tools on the laptop you are deploying from.

### 1a. AWS CLI
The AWS CLI lets you talk to AWS from your terminal.

**Mac:**
```bash
brew install awscli
```
**Windows:** Download the installer from https://aws.amazon.com/cli/

**Verify:**
```bash
aws --version
# Should print: aws-cli/2.x.x ...
```

### 1b. eksctl
Creates and manages EKS clusters.

**Mac:**
```bash
brew tap weaveworks/tap
brew install weaveworks/tap/eksctl
```
**Windows:** Download from https://eksctl.io/installation/

**Verify:**
```bash
eksctl version
# Should print: 0.x.x
```

### 1c. kubectl
The command-line tool for Kubernetes.

**Mac:**
```bash
brew install kubectl
```
**Windows:** Download from https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/

**Verify:**
```bash
kubectl version --client
# Should print: Client Version: v1.xx.x
```

### 1d. Helm
Package manager for Kubernetes.

**Mac:**
```bash
brew install helm
```
**Windows:** Download from https://helm.sh/docs/intro/install/

**Verify:**
```bash
helm version
# Should print: version.BuildInfo{Version:"v3.x.x", ...}
```

---

## Step 2 — Configure AWS credentials on your laptop

> **Pluralsight sandbox users:** Use the sandbox-specific instructions in the [Pluralsight section above](#sandbox-specific-step-2--configure-credentials) instead of this section. The process is the same but you paste the sandbox keys.

For a **real AWS account**, this tells the AWS CLI who you are and which region to use.

```bash
aws configure
```

It will ask 4 questions:

```
AWS Access Key ID [None]: PASTE_YOUR_ACCESS_KEY_ID_HERE
AWS Secret Access Key [None]: PASTE_YOUR_SECRET_ACCESS_KEY_HERE
Default region name [None]: ap-south-1
Default output format [None]: json
```

These credentials are saved to `~/.aws/credentials` on your laptop. The CLI uses them for every AWS command you run.

**Verify it worked:**
```bash
aws sts get-caller-identity
```
You should see your AWS account ID and user name printed. If you get an error, your credentials are wrong.

---

## Step 3 — Fill in your secrets

Secrets are sensitive values (database passwords, JWT signing keys) that your services need to run. They are stored in Kubernetes as encrypted values — never in your code or Docker images.

Open this file: `k8s/helm/minigram/templates/secret.yaml`

You will see placeholder values like `REPLACE_WITH_BASE64_ENCODED_JWT_SECRET`. Replace each one.

### What is base64 encoding?
Base64 is a way to encode text so it's safe to store in YAML. It is NOT encryption — it's just encoding. The reason Kubernetes uses it is to handle special characters (like `@` or `:` in a password) safely in YAML files.

### How to encode a value

**Mac/Linux terminal:**
```bash
echo -n "your-actual-value" | base64
```
The `-n` flag is important — it stops `echo` from adding a newline character at the end (which would corrupt the value).

**Example:**
```bash
echo -n "minigram" | base64
# Output: bWluaWdyYW0=
```

### What values to use

**JWT_SECRET** — A long random string used to sign login tokens. Generate one:
```bash
openssl rand -hex 32
# Example output: a3f8c2d1e9b7... (64 hex characters)

# Now encode it:
echo -n "a3f8c2d1e9b7..." | base64
# Paste this base64 result into secret.yaml
```

**POSTGRES_USER** — The username for your PostgreSQL database. Choose anything, e.g. `minigram`:
```bash
echo -n "minigram" | base64
# Output: bWluaWdyYW0=
```

**POSTGRES_PASSWORD** — A strong password for the database. Example:
```bash
echo -n "MyStr0ngP@ssword123" | base64
```

**POSTGRES_DB** — The database name. Use `minigram`:
```bash
echo -n "minigram" | base64
# Output: bWluaWdyYW0=
```

**DATABASE_URL** — The full connection string the Node.js app uses to connect to PostgreSQL.
Format: `postgresql://USER:PASSWORD@postgres:5432/DB`

> **Important:** The hostname is `postgres` — that is the Kubernetes Service name, not a real server hostname. Inside the cluster, services find each other by their Kubernetes Service name.

Example (using the values above):
```bash
echo -n "postgresql://minigram:MyStr0ngP@ssword123@postgres:5432/minigram" | base64
```

### After filling in the values, your secret.yaml should look like:
```yaml
data:
  JWT_SECRET: "YTNmOGMyZDFlOWI3..."       # your encoded value
  POSTGRES_USER: "bWluaWdyYW0="
  POSTGRES_PASSWORD: "TXlTdHIwbmdQ..."
  POSTGRES_DB: "bWluaWdyYW0="
  DATABASE_URL: "cG9zdGdyZXNxbDovLy4u..."
```

### IMPORTANT — Do NOT commit real secrets to git

Add this to your `.gitignore` file:
```
k8s/helm/minigram/templates/secret.yaml
```

Or keep the file with placeholder values in git and fill in real values only on the deployment laptop (never push real values).

---

## Step 4 — Run the deploy script

Make sure you are in the project root directory (where `docker-compose.yml` is):

```bash
cd /path/to/miniGram
bash k8s/deploy.sh
```

### What the script does — step by step:

**Step 1: Checks tools** — Verifies `aws`, `eksctl`, `kubectl`, `helm` are installed and AWS credentials work.

**Step 2: Creates the EKS cluster (~15-20 minutes)** — This is the longest step. `eksctl` reads `k8s/cluster/eksctl-cluster.yaml` and does the following in AWS:
- Creates a VPC (private network) with public and private subnets across 3 availability zones
- Creates the EKS control plane (the Kubernetes brain)
- Creates 2 × t3.medium EC2 worker nodes
- Installs the EBS CSI driver (so Kubernetes can create EBS disk volumes)
- Sets up OIDC (so Kubernetes pods can get AWS permissions)
- Updates your `~/.kube/config` file so `kubectl` points to the new cluster

**Step 3: Installs the AWS Load Balancer Controller** — This is a piece of software that runs inside the cluster and watches for Ingress resources. When it sees the `minigram-ingress` resource, it calls AWS APIs to create a real ALB (Load Balancer) in your account. It needs an IAM role to do this — the script creates that automatically.

**Step 4: Deploys miniGram** — Runs `helm install` which applies all the YAML files in `k8s/helm/minigram/templates/` to the cluster. Kubernetes then:
- Creates the `minigram` namespace
- Applies the Secrets
- Starts the PostgreSQL StatefulSet (creates EBS volume, starts postgres pod)
- Starts db-service (waits for postgres to be healthy first)
- Starts auth-service, telegram-read-service, telegram-download-service (wait for db-service)
- Starts api-gateway (waits for auth-service)
- Starts ui-service
- Creates the ALB Ingress (triggers ALB creation in AWS)

**Step 5: Prints your URL** — Waits for the ALB to be provisioned and prints the public address.

### What you'll see in the terminal:

```
==> Checking prerequisites...
    All tools found.
    AWS credentials OK (account: 123456789012)

==> Creating EKS cluster (this takes ~15-20 minutes)...
[eksctl output scrolling by...]

==> Installing AWS Load Balancer Controller...
    AWS Load Balancer Controller installed.

==> Checking secrets...
    Secrets look filled in.

==> Deploying miniGram...
    miniGram deployed.

==> Waiting for the ALB to be provisioned...

================================================================
  miniGram is live!

  Public URL:  http://k8s-minigram-abc123.ap-south-1.elb.amazonaws.com
================================================================
```

---

## Step 5 — Open your app in the browser

Copy the URL printed at the end and open it in your browser. The Angular UI should load.

If the URL isn't printed (ALB takes longer sometimes), run:
```bash
kubectl get ingress minigram-ingress -n minigram
```

Look at the `ADDRESS` column. Wait 1-3 minutes if it's empty — the ALB is still provisioning.

---

## How to update the app after code changes

When you change code and push new Docker images to Docker Hub, update the cluster with:

```bash
# Re-deploy all services with latest images
helm upgrade minigram ./k8s/helm/minigram -n minigram
```

> `helm upgrade` is like `helm install` but for an already-deployed app. It only changes what's different.

To force Kubernetes to pull the latest Docker image even if the tag didn't change:
```bash
kubectl rollout restart deployment -n minigram
```

---

## Day-to-day useful commands

### Check what's running
```bash
# Show all pods and their status
kubectl get pods -n minigram

# Example output:
# NAME                                        READY   STATUS    RESTARTS   AGE
# api-gateway-7d9f8c-x4k2p                   1/1     Running   0          5m
# auth-service-6b8d4f-n9j3q                  1/1     Running   0          5m
# db-service-5c7b9d-m2h4r                    1/1     Running   0          5m
# google-download-service-4f6a8b-k1j5t       1/1     Running   0          5m
# google-upload-service-3e5a7b-l2k6u         1/1     Running   0          5m
# postgres-0                                  1/1     Running   0          5m
# telegram-download-service-8a2c4e-p7m9s     1/1     Running   0          5m
# telegram-read-service-9b3d5f-q8n0t         1/1     Running   0          5m
# ui-service-2a4c6e-r9o1u                    1/1     Running   0          5m
```

**STATUS meanings:**
- `Running` — healthy, all good
- `Pending` — waiting to be scheduled on a node (usually temporary)
- `CrashLoopBackOff` — crashing repeatedly (check logs)
- `ImagePullBackOff` — can't download the Docker image (wrong image name or tag)
- `Init:0/1` — initContainer is still running (waiting for a dependency)

### View logs for a service
```bash
# View logs for auth-service
kubectl logs -n minigram -l app=auth-service

# View logs and keep watching (like tail -f)
kubectl logs -n minigram -l app=auth-service -f

# View logs for a specific pod (use the pod name from kubectl get pods)
kubectl logs -n minigram auth-service-6b8d4f-n9j3q

# View last 100 lines only
kubectl logs -n minigram -l app=auth-service --tail=100
```

### Get more details about a pod (useful when something is wrong)
```bash
kubectl describe pod -n minigram auth-service-6b8d4f-n9j3q
```
This shows events, environment variables, and why a pod might be failing.

### Restart a service
```bash
# Restart auth-service (triggers a rolling restart — zero downtime)
kubectl rollout restart deployment/auth-service -n minigram

# Restart all services at once
kubectl rollout restart deployment -n minigram
```

### Check the public URL
```bash
kubectl get ingress minigram-ingress -n minigram
```

### Check node health
```bash
kubectl get nodes
```

### Scale a service (for stateless services only)
```bash
# Scale api-gateway to 2 replicas
kubectl scale deployment api-gateway -n minigram --replicas=2

# DO NOT scale these — they have in-memory state that breaks with multiple replicas:
# auth-service, telegram-read-service, telegram-download-service
```

### Open a shell inside a running pod (for debugging)
```bash
kubectl exec -it -n minigram $(kubectl get pod -n minigram -l app=db-service -o name) -- sh
```

---

## File structure explained

```
k8s/
├── README.md                          ← You are reading this
├── deploy.sh                          ← Run this once to set everything up
├── cluster/
│   └── eksctl-cluster.yaml            ← Defines the EKS cluster
└── helm/
    └── minigram/
        ├── Chart.yaml                 ← Helm chart name and version
        ├── values.yaml                ← The ONE file you edit to change config
        └── templates/
            ├── _helpers.tpl           ← Shared macros (don't edit)
            ├── namespace.yaml         ← Creates "minigram" namespace
            ├── secret.yaml            ← ⚠️ FILL THIS IN — passwords and keys
            ├── postgres/
            │   ├── statefulset.yaml   ← Runs PostgreSQL with persistent EBS storage
            │   └── service.yaml       ← Makes postgres reachable at "postgres:5432"
            ├── db-service/
            │   ├── deployment.yaml    ← Runs the Node.js DB wrapper service
            │   └── service.yaml       ← Makes it reachable at "db-service:3006"
            ├── auth-service/
            │   ├── deployment.yaml    ← Telegram login + JWT issuance
            │   └── service.yaml       ← Reachable at "auth-service:3001"
            ├── telegram-read-service/
            │   ├── deployment.yaml    ← Reads Telegram groups/messages
            │   └── service.yaml       ← Reachable at "telegram-read-service:3002"
            ├── telegram-download-service/
            │   ├── deployment.yaml    ← Streams files from Telegram to browser
            │   └── service.yaml       ← Reachable at "telegram-download-service:3003"
            ├── google-upload-service/
            │   ├── deployment.yaml    ← Future Google Drive upload (placeholder)
            │   └── service.yaml       ← Reachable at "google-upload-service:3004"
            ├── google-download-service/
            │   ├── deployment.yaml    ← Future Google Drive download (placeholder)
            │   └── service.yaml       ← Reachable at "google-download-service:3005"
            ├── api-gateway/
            │   ├── deployment.yaml    ← Reverse proxy routing all API traffic
            │   └── service.yaml       ← Reachable at "api-gateway:3000"
            ├── ui-service/
            │   ├── deployment.yaml    ← Angular app served by nginx
            │   └── service.yaml       ← Reachable at "ui-service:80"
            └── ingress.yaml           ← Creates the public AWS ALB (your URL)
```

### values.yaml — The config file you'll edit most

`values.yaml` is the central config for the entire deployment. Instead of hunting through all the template files, you change things here:

- **Image tag** — Change `latest` to a specific version (e.g. `v1.2.3`) to pin a release
- **Replicas** — How many copies of each service to run
- **Storage size** — How big the PostgreSQL EBS disk should be
- **Ingress host** — Set your custom domain name here if you have one

---

## How all the pieces connect (Architecture)

```
Internet
    │
    ▼
┌─────────────────────────────────────────────┐
│  AWS Application Load Balancer (ALB)         │
│  Public URL: k8s-minigram-xxx.elb.amazonaws │
└────────────────────┬────────────────────────┘
                     │ all traffic (port 80)
                     ▼
┌─────────────────────────────────────────────┐
│  ui-service (nginx, port 80)                 │
│  Serves Angular app                          │
│  Proxies /api/* → api-gateway:3000           │
└────────────────────┬────────────────────────┘
                     │ /api/* (strips /api prefix)
                     ▼
┌─────────────────────────────────────────────┐
│  api-gateway (Node.js, port 3000)            │
│  Routes:                                     │
│   /auth/*         → auth-service:3001        │
│   /groups/*       → telegram-read:3002       │
│   /download/*     → telegram-download:3003   │
│   /google/upload  → google-upload:3004       │
│   /google/download→ google-download:3005     │
│   /download/*-db  → db-service:3006          │
└──┬──────┬──────┬──────┬──────┬──────────────┘
   │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼
auth  tg-read  tg-dl  g-up  g-down
:3001  :3002   :3003  :3004  :3005
   │      │      │
   └──────┴──────┘
          │ all services call db-service for user data
          ▼
┌─────────────────────────────────────────────┐
│  db-service (Node.js, port 3006)             │
│  REST API wrapper over PostgreSQL            │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│  PostgreSQL (port 5432)                      │
│  StatefulSet with 20 GB EBS volume           │
│  Stores: users, sessions, download logs      │
└─────────────────────────────────────────────┘
```

**Key rule:** Nothing except the ALB is exposed to the internet. All services talk to each other using internal Kubernetes Service names (`auth-service`, `db-service`, etc.) which only work inside the cluster.

---

## Troubleshooting

### Pod is in `CrashLoopBackOff`

The pod is crashing repeatedly. View the logs to see why:
```bash
kubectl logs -n minigram -l app=auth-service
```

Most common causes:
- **Missing or wrong secrets** — Check that `secret.yaml` is filled in correctly
- **Wrong DATABASE_URL** — Make sure the format is `postgresql://USER:PASS@postgres:5432/DB` with `postgres` as hostname
- **db-service not ready yet** — Wait a minute and check again; the `initContainer` should handle this but give it time

### Pod is stuck in `Pending`

The pod can't be scheduled on any node:
```bash
kubectl describe pod -n minigram <pod-name>
```
Look at the `Events` section at the bottom. Common causes:
- **Not enough resources** — The cluster autoscaler will add a 3rd node automatically. Wait 2-3 minutes.
- **EBS volume can't be attached** — If the EBS CSI driver isn't working, the postgres pod will be stuck. Check with: `kubectl get pods -n kube-system | grep ebs-csi`

### Pod is in `ImagePullBackOff`

Kubernetes can't download the Docker image:
```bash
kubectl describe pod -n minigram <pod-name>
```
Look for `Failed to pull image`. Causes:
- Image name is wrong in `values.yaml`
- Docker Hub rate limiting (try again in an hour)
- Image doesn't exist on Docker Hub (need to push first)

### ALB has no address after 5 minutes

The ALB controller isn't working:
```bash
# Check if the controller pod is running
kubectl get pods -n kube-system | grep aws-load-balancer

# View its logs
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```

Common cause: The IAM role wasn't created correctly. Re-run the deploy script from Step 3 onwards.

### PostgreSQL keeps restarting

Check that the EBS volume was created:
```bash
kubectl get pvc -n minigram
# STATUS should be "Bound", not "Pending"
```

If it's `Pending`, the EBS CSI driver isn't working:
```bash
kubectl get pods -n kube-system | grep ebs-csi
```

### Can't connect to the app URL

1. Check the ALB is provisioned: `kubectl get ingress minigram-ingress -n minigram` — should show an ADDRESS
2. Check the ui-service pod is running: `kubectl get pods -n minigram -l app=ui-service`
3. Check the api-gateway pod is running: `kubectl get pods -n minigram -l app=api-gateway`
4. Try hitting the health endpoint directly: `curl http://YOUR_ALB_URL/api/health`

### Something is wrong and I don't know what

Get a full picture of everything:
```bash
# All pods and their status
kubectl get pods -n minigram

# All services
kubectl get services -n minigram

# Ingress and its ALB address
kubectl get ingress -n minigram

# Recent events (errors and warnings)
kubectl get events -n minigram --sort-by='.lastTimestamp' | tail -20
```

---

## How to shut everything down

### Option A — Remove the app but keep the cluster (saves cluster cost if you want to redeploy later)
```bash
helm uninstall minigram -n minigram
```
This deletes all pods, services, and the ALB. The EBS volume (PostgreSQL data) is also deleted.

### Option B — Delete the entire cluster and everything in it

```bash
eksctl delete cluster -f k8s/cluster/eksctl-cluster.yaml
```

**This deletes:**
- All EC2 nodes
- The EKS control plane
- The VPC and all subnets
- All EBS volumes (PostgreSQL data is lost permanently)
- The ALB

This takes about 10-15 minutes. After this, you will stop being charged.

> **Always verify deletion completed** by checking the AWS Console → EKS → Clusters. An accidental running cluster costs ~$150/month even if no app is deployed.
