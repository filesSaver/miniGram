# miniGram — Local Development Guide

## Overview

miniGram runs locally using Docker Compose, which orchestrates all 9 containers (8 services + PostgreSQL) with correct startup ordering, internal networking, and environment variable injection. The entire stack starts with one command.

---

## Prerequisites

Install these tools before starting:

- **Docker Desktop** — [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/). This installs both `docker` and `docker compose`.
- **Git** — to clone the repository.

No Node.js, PostgreSQL, or any programming language runtime needs to be installed on your machine — Docker handles all of that inside containers.

---

## Project Root: Environment Variables (`.env` file)

Docker Compose reads a `.env` file from the same directory as `docker-compose.yml` (the project root). You must create this file before starting the stack.

```bash
cd /path/to/miniGram
cp .env.example .env   # if an example exists, otherwise create from scratch
```

Required variables:

```bash
# PostgreSQL credentials
POSTGRES_USER=minigram
POSTGRES_PASSWORD=choose_a_strong_password_here
POSTGRES_DB=minigram

# Full connection string — hostname must be "postgres" (the Docker service name)
DATABASE_URL=postgresql://minigram:choose_a_strong_password_here@postgres:5432/minigram

# JWT signing secret — a long, random string. Used by auth-service, telegram-read-service,
# and telegram-download-service. All three must share the same value.
JWT_SECRET=generate_a_64_char_or_longer_random_string_here
```

Generate a strong `JWT_SECRET`:
```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**The `DATABASE_URL` hostname must be `postgres`** — this is the Docker Compose service name, which Docker's internal DNS resolves to the postgres container's IP. Using `localhost` would fail because `localhost` inside the db-service container refers to itself, not the postgres container.

---

## Starting the Full Stack

```bash
# From the project root
docker compose up
```

This builds all images if needed (takes several minutes on first run due to `npm install` steps), then starts all containers in dependency order.

**First-run timing:** Building images takes 5–15 minutes depending on internet speed (downloading Node.js Alpine images, installing npm packages including GramJS with native compilation). Subsequent starts use Docker's layer cache and take under 30 seconds.

To run in the background (detached mode):
```bash
docker compose up -d
```

To view logs for all services:
```bash
docker compose logs -f
```

To view logs for a specific service:
```bash
docker compose logs -f auth-service
```

---

## Startup Order: Why Services Start in a Specific Sequence

Docker Compose enforces startup ordering through `depends_on` with `condition` settings. Violating this order would cause services to crash because their dependencies are not ready.

```
postgres
  │ healthcheck: pg_isready -U minigram
  │ (passes when PostgreSQL is accepting connections)
  ▼
db-service
  │ depends_on: postgres: condition: service_healthy
  │ healthcheck: wget -qO- http://localhost:3006/health
  │ (passes after initDb() creates the schema)
  ▼
auth-service
  │ depends_on: db-service: condition: service_healthy
  │ healthcheck: wget -qO- http://localhost:3001/health
  ▼
telegram-read-service      telegram-download-service
  │ depends_on:              │ depends_on:
  │   auth-service:          │   auth-service:
  │     condition:           │     condition:
  │       service_healthy    │       service_healthy
  ▼                          ▼
                api-gateway
                  │ depends_on:
                  │   auth-service: service_healthy
                  │   telegram-read-service: service_started
                  │   telegram-download-service: service_started
                  │   google-upload-service: service_started
                  │   google-download-service: service_started
                  ▼
                ui-service
                  │ depends_on: api-gateway: service_started
```

**`condition: service_healthy`** means Docker waits until the container's healthcheck command succeeds. This is the strict dependency used when a downstream service literally cannot function until the upstream is ready (e.g., db-service cannot serve requests until the postgres schema is created).

**`condition: service_started`** means Docker only waits until the container process has started, not until it passes any healthcheck. This looser dependency is used when the downstream service can boot independently and will just retry the upstream if it is not ready yet.

---

## Service Port Map

| Service | Internal port | Host port (for debugging) | Accessible at |
|---------|--------------|--------------------------|---------------|
| ui-service | 80 | 4200 | http://localhost:4200 |
| api-gateway | 3000 | 3000 | http://localhost:3000 |
| auth-service | 3001 | 3001 | http://localhost:3001 |
| telegram-read-service | 3002 | 3002 | http://localhost:3002 |
| telegram-download-service | 3003 | 3003 | http://localhost:3003 |
| google-upload-service | 3004 | 3004 | http://localhost:3004 |
| google-download-service | 3005 | 3005 | http://localhost:3005 |
| db-service | 3006 | 3006 | http://localhost:3006 |
| postgres | 5432 | Not published | Internal only |

The postgres container does **not** have a `ports:` mapping — port 5432 is only accessible from within the Docker bridge network (`app-network`). All other services are exposed to the host for direct debugging but in production only `ui-service` is reachable from outside.

---

## How Services Communicate Internally (Docker DNS)

Docker Compose creates a virtual network called `app-network` (a bridge network). Every service on this network can reach every other service by the service name defined in `docker-compose.yml`.

Examples:
- `http://auth-service:3001` — the api-gateway reaches auth-service this way.
- `http://db-service:3006` — auth-service, telegram-read-service, and telegram-download-service all reach db-service this way.
- `postgresql://minigram:password@postgres:5432/minigram` — db-service connects to postgres this way.

Docker's embedded DNS server (`127.0.0.11` inside each container) resolves these service names to the container's internal IP address automatically. These hostnames work only within the Docker network — they cannot be used from your host machine.

---

## The Request Path Locally

```
Browser on your laptop
  │
  │ http://localhost:4200  (any route: /, /group/123, etc.)
  ▼
ui-service container (nginx on port 80, mapped to host:4200)
  │
  │ Static files (/index.html, JS bundles) → served directly by nginx
  │ /api/* requests → proxied to api-gateway:3000
  │   /api/download/file → proxied with proxy_buffering off
  │   /api/*/breakdown/stream → proxied as SSE with proxy_buffering off
  ▼
api-gateway container (Node.js on port 3000)
  │
  │ /auth/* → auth-service:3001 (prefix stripped)
  │ /groups/* → telegram-read-service:3002
  │ /download/* → telegram-download-service:3003 (timeout:0)
  │ /download/log-db → db-service:3006 (path rewritten to /downloads)
  │ /download/counts-db → db-service:3006 (path rewritten to /downloads/counts)
  ▼
Individual services → db-service:3006 → postgres:5432
```

---

## Docker Compose Files

There are two Compose files:

**`docker-compose.yml`** — the full stack. All services run in containers. Used for testing the complete system and for building production images.

**`docker-compose.local.yml`** — runs only postgres in Docker; all Node.js services run natively on your machine. Used during active development to get fast code reloads without rebuilding Docker images. Start each service with `npm run dev` after setting environment variables in your shell.

To use the local development file:
```bash
# Start only postgres
docker compose -f docker-compose.local.yml up -d

# Then start individual services locally:
cd services/auth-service
export JWT_SECRET=dev-secret
export DB_SERVICE_URL=http://localhost:3006
export PORT=3001
npm run dev
```

---

## Building Images

### Standard build (current platform architecture)

```bash
docker compose build
```

Builds all service images for your current machine's CPU architecture. Fast and simple.

**Warning for Apple Silicon (M1/M2/M3/M4) users:** This builds `linux/arm64` images. EKS worker nodes are x86_64 (`linux/amd64`). Images built for `arm64` will crash on EKS with `exec format error`. See the Bugs and Fixes document for details.

### Cross-platform build for EKS deployment

```bash
docker buildx create --use --name multiarch 2>/dev/null || true
docker buildx bake --file docker-compose.yml \
  --set "*.platform=linux/amd64" \
  --push
```

This builds all images for `linux/amd64` and pushes them to DockerHub in one step. Requires being logged into DockerHub (`docker login`) first.

### Building a single service

```bash
docker build -t sauravmehta/content-scrapper-auth-service:latest \
  ./services/auth-service

# Cross-platform:
docker buildx build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-auth-service:latest \
  ./services/auth-service \
  --push
```

---

## Pushing to DockerHub

```bash
# Login first (one-time per session)
docker login
# Enter DockerHub username and password when prompted

# Push all images (after building them)
docker compose push

# Or push a single image
docker push sauravmehta/content-scrapper-auth-service:latest
```

DockerHub rejects pushes with `denied: requested access to the resource is denied` if you are not logged in. This is a common stumble point.

---

## Verifying Services Are Running

After `docker compose up`, verify each service is healthy:

```bash
# Check container status
docker compose ps

# Check health specifically
docker inspect <container-name> | grep -A 5 '"Health"'

# Hit health endpoints directly
curl http://localhost:3000/health   # api-gateway
curl http://localhost:3001/health   # auth-service
curl http://localhost:3002/health   # telegram-read-service
curl http://localhost:3003/health   # telegram-download-service
curl http://localhost:3006/health   # db-service
```

Expected response for all: `{"status":"ok","service":"<name>"}`.

---

## Resetting Everything

```bash
# Stop all containers
docker compose down

# Stop and delete all data (including the postgres volume)
docker compose down -v

# Rebuild images from scratch (ignores cache)
docker compose build --no-cache
docker compose up
```

`docker compose down` without `-v` preserves the postgres data volume (`pg-data`), so your database survives between stack restarts.

---

## Running a Specific Service in Isolation

```bash
# Run only db-service and its dependencies (postgres)
docker compose up db-service

# Run only auth-service and all its dependencies (postgres, db-service)
docker compose up auth-service
```

Docker Compose's dependency resolution means `docker compose up auth-service` automatically starts postgres and db-service first.

---

## Common Issues

### "Cannot connect to the Docker daemon"

Docker Desktop is not running. Start it from the Applications folder (macOS) or system tray.

### Port already in use

Another process is listening on one of the ports. Find and stop it:
```bash
lsof -i :3001   # find what's using port 3001
kill -9 <PID>   # stop it
```

### Database schema errors

The postgres volume may contain an old schema from a previous run. Reset it:
```bash
docker compose down -v
docker compose up
```

### `auth-service` keeps restarting

Check that `JWT_SECRET` is set in your `.env` file. The service exits immediately with a fatal error if this variable is absent.

### Download corruption (file saves as HTML)

This is the nginx buffering bug. Ensure the `nginx.conf` has `proxy_buffering off` in the `/api/download/file` location block. See the Bugs and Fixes document for the full explanation.

### Images pull slowly or time out on first run

DockerHub free tier has pull rate limits. Wait a few minutes and try again, or log in to DockerHub (`docker login`) to get higher limits.
