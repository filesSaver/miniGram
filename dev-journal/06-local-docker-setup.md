# 06 — Local Docker Setup: A Complete Beginner's Guide

This document covers everything you need to understand about running miniGram on
your own machine using Docker Compose. It explains every line of configuration,
every decision, and every gotcha — especially the ones that burned real time
during the EKS deployment.

---

## Table of Contents

1. [What is Docker Compose and why does miniGram use it?](#1-what-is-docker-compose-and-why-does-minigram-use-it)
2. [Local Docker Compose — Every Service Explained](#2-local-docker-compose--every-service-explained)
3. [How to Run Locally — Step by Step](#3-how-to-run-locally--step-by-step)
4. [Service Communication — Docker DNS and Exposed Ports](#4-service-communication--docker-dns-and-exposed-ports)
5. [Docker Build — docker-compose build vs buildx bake](#5-docker-build--docker-compose-build-vs-buildx-bake)
6. [ARM vs AMD64 — The Apple Silicon Trap](#6-arm-vs-amd64--the-apple-silicon-trap)
7. [Docker Push — Getting Images to DockerHub](#7-docker-push--getting-images-to-dockerhub)
8. [Local vs Production — What Changes](#8-local-vs-production--what-changes)

---

## 1. What is Docker Compose and why does miniGram use it?

Docker is software that packages an application and everything it needs to run
(OS libraries, runtime, config) into a single portable unit called a
**container**. A container is like a lightweight virtual machine, but instead of
virtualising an entire operating system it shares the host kernel — so it starts
in milliseconds and uses a fraction of the memory.

**Docker Compose** is a tool that manages *multiple containers at once*. Instead
of running eight separate `docker run` commands and wiring them together
manually, you describe all the containers in a single file called
`docker-compose.yml` and start the entire system with one command:

```
docker compose up
```

miniGram is a microservices application — it is split into eight separate
services (postgres, db-service, auth-service, telegram-read-service,
telegram-download-service, google-upload-service, google-download-service,
api-gateway, ui-service). Running them all manually without Compose would be
painful. Compose solves that.

There are actually two Compose files in the project:

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Full stack — all services in containers. Used for building, testing, and pushing images. |
| `docker-compose.local.yml` | Only runs postgres in Docker; all Node services run natively on your machine via `npm run local:start`. Used during active development to get fast code reloads without rebuilding images. |

The rest of this document focuses on the main `docker-compose.yml`.

---

## 2. Local Docker Compose — Every Service Explained

The file has three top-level sections: `networks`, `volumes`, and `services`.
We will go through each section and then every service.

### 2.1 Shared Network

```yaml
networks:
  app-network:
    driver: bridge
```

A **network** in Docker is a private virtual LAN that containers can join. By
default, containers are isolated — they cannot talk to each other unless they
share a network.

- `app-network` is the name we give to our shared network. We made it up; it
  could be called anything.
- `driver: bridge` means Docker creates a virtual switch on your machine. All
  containers that join this network can reach each other by name (more on that
  in section 4). The `bridge` driver is the default for single-host setups.
- Every service in the file has `networks: - app-network`. This connects them
  all to the same LAN so they can talk to each other.

### 2.2 Persistent Volume

```yaml
volumes:
  pg-data:
```

A **volume** is Docker's way of persisting data that survives container restarts.
Containers are ephemeral by design — if you stop and remove a container,
everything written inside it is gone. PostgreSQL stores its data files inside the
container at `/var/lib/postgresql/data`. Without a volume, every time you restart
postgres you lose all your data.

- `pg-data` is a named volume managed by Docker. Docker stores it somewhere on
  your host disk (usually in `/var/lib/docker/volumes/` on Linux, or in the
  Docker Desktop VM on Mac/Windows).
- The postgres service mounts it: `volumes: - pg-data:/var/lib/postgresql/data`.
  This means: "mount the `pg-data` volume from the host at the path
  `/var/lib/postgresql/data` inside the container." PostgreSQL reads and writes
  its data there, and that data lives on the host even when the container stops.

### 2.3 Service: postgres

```yaml
postgres:
  image: postgres:16-alpine
  environment:
    POSTGRES_USER: ${POSTGRES_USER}
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    POSTGRES_DB: ${POSTGRES_DB}
  volumes:
    - pg-data:/var/lib/postgresql/data
  networks:
    - app-network
  restart: unless-stopped
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
```

**image: postgres:16-alpine**
This service does not have a `build:` section — it uses a pre-built image from
DockerHub. `postgres:16-alpine` means PostgreSQL version 16 built on Alpine
Linux (a very small Linux distro, ~5 MB). The image is downloaded automatically
the first time you run `docker compose up`.

**environment block**
These are environment variables passed into the container at startup. The
official `postgres` image reads specific variables to bootstrap the database:
- `POSTGRES_USER` — the database username to create.
- `POSTGRES_PASSWORD` — the password for that user.
- `POSTGRES_DB` — the name of the database to create on first startup.

The `${POSTGRES_USER}` syntax means "read this value from the environment or
from a `.env` file in the same directory as `docker-compose.yml`". Docker
Compose automatically reads a file named `.env` if it exists. This keeps secrets
out of the Compose file itself.

**volumes**
As explained above, mounts the `pg-data` named volume to persist database files.

**networks**
Connects this container to `app-network` so other services can reach it.

**restart: unless-stopped**
If the container crashes, Docker restarts it automatically. `unless-stopped`
means: restart on crash or reboot, but do not restart if you explicitly run
`docker compose stop` or `docker stop postgres`.

**healthcheck**
This is one of the most important parts of the Compose file for reliability.
A healthcheck runs a command inside the container on a schedule. Docker uses the
result to know whether the container is actually ready, not just started.

- `test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]` — runs the
  `pg_isready` command inside the container. This utility (bundled with postgres)
  connects to the database socket and returns exit code 0 if postgres is
  accepting connections, non-zero otherwise.
- `interval: 10s` — run the test every 10 seconds.
- `timeout: 5s` — if the test does not respond within 5 seconds, count it as
  failed.
- `retries: 5` — after 5 consecutive failures, mark the container as
  `unhealthy`.
- `start_period: 10s` — during the first 10 seconds after start, failures do not
  count against the retry limit. This gives postgres time to initialise its data
  directory on first run.

Other services declare `depends_on: postgres: condition: service_healthy`. This
means Docker Compose will not start those services until the postgres healthcheck
returns healthy. Without this, db-service might try to connect to postgres before
postgres is ready and crash.

### 2.4 Service: db-service

```yaml
db-service:
  build:
    context: ./services/db-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-db-service:latest
  environment:
    PORT: 3006
    DATABASE_URL: ${DATABASE_URL}
  ports:
    - "3006:3006"
  networks:
    - app-network
  restart: unless-stopped
  depends_on:
    postgres:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3006/health"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
```

**build section**
Unlike postgres, db-service is built from source code. The `build` block tells
Compose where to find the source.
- `context: ./services/db-service` — the build context is the directory Docker
  copies into the build environment. All paths in the Dockerfile are relative to
  this directory.
- `dockerfile: Dockerfile` — the name of the file with build instructions
  (default is `Dockerfile`, but being explicit avoids confusion).

**image: sauravmehta/content-scrapper-db-service:latest**
When you run `docker compose build` or `docker compose up --build`, Docker builds
the image and tags it with this name. This tag is what gets pushed to DockerHub.
The format is `<dockerhub-username>/<repository-name>:<tag>`. `latest` is a
conventional tag meaning "the most recent version".

**environment: PORT: 3006**
The service reads `process.env.PORT` to know which port to listen on. Setting it
here rather than hardcoding it in the source code makes the service configurable.

**environment: DATABASE_URL**
The full Postgres connection string. Its value in `.env` is:
`postgres://minigram:changeme@postgres:5432/minigram`.
Breaking this down: `postgres://` is the protocol, `minigram:changeme` is
username:password, `postgres` is the hostname (the name of the postgres
container on the Docker network — Docker DNS resolves this automatically),
`5432` is the postgres port, and `minigram` is the database name.

**ports: "3006:3006"**
This publishes port 3006 from the container to port 3006 on your host machine.
Format is `<host-port>:<container-port>`. This is what lets you call
`http://localhost:3006/health` from your browser or from `curl` on your laptop.
Without this, the port is reachable only from other containers on the same
Docker network.

**depends_on: postgres: condition: service_healthy**
Waits for postgres's healthcheck to pass before starting db-service. Without
this, db-service boots, tries `DATABASE_URL`, finds postgres not ready, and
crashes.

**healthcheck using wget**
The alpine base image does not include `curl`, but it does include `wget`.
`wget -qO-` fetches the URL and writes the response to stdout (`-q` is quiet,
`-O-` means "write to stdout instead of a file"). If the server returns HTTP 200,
wget exits 0 (healthy). A non-200 or a connection error exits non-zero
(unhealthy). The db-service exposes a `/health` endpoint that returns 200 OK
when the service is initialised and connected to postgres.

### 2.5 Service: auth-service

```yaml
auth-service:
  build:
    context: ./services/auth-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-auth-service:latest
  environment:
    PORT: 3001
    DB_SERVICE_URL: http://db-service:3006
    JWT_SECRET: ${JWT_SECRET}
  ports:
    - "3001:3001"
  networks:
    - app-network
  restart: unless-stopped
  depends_on:
    db-service:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3001/health"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
```

**DB_SERVICE_URL: http://db-service:3006**
auth-service does not talk to postgres directly. Instead it calls db-service via
HTTP. `db-service` is a hostname that Docker DNS resolves to the db-service
container's internal IP address (see section 4). This is the microservices
pattern: each service owns its data layer, and other services access data through
a well-defined HTTP API instead of direct database connections.

**JWT_SECRET: ${JWT_SECRET}**
The secret key used to sign and verify JSON Web Tokens (JWTs). Both auth-service
(which signs tokens on login) and any service that verifies tokens
(telegram-read-service, telegram-download-service) must share the same value.
It comes from the `.env` file so it never appears in version control.

**depends_on: db-service: condition: service_healthy**
Waits for db-service's healthcheck (which itself waited for postgres) before
starting. This creates a proper startup chain: postgres → db-service → auth-service.

### 2.6 Service: telegram-read-service

```yaml
telegram-read-service:
  build:
    context: ./services/telegram-read-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-telegram-read-service:latest
  environment:
    PORT: 3002
    JWT_SECRET: ${JWT_SECRET}
    DB_SERVICE_URL: http://db-service:3006
  ports:
    - "3002:3002"
  networks:
    - app-network
  restart: unless-stopped
  depends_on:
    auth-service:
      condition: service_healthy
```

This service reads messages from Telegram. It depends on auth-service being
healthy (which transitively guarantees db-service and postgres are healthy).

Notice it has no `healthcheck` block. This means Docker considers it healthy the
moment the process starts and does not crash. The api-gateway depends on this
service with `condition: service_started` (not `service_healthy`) for the same
reason — there is no formal health endpoint to check.

### 2.7 Service: telegram-download-service

```yaml
telegram-download-service:
  build:
    context: ./services/telegram-download-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-telegram-download-service:latest
  environment:
    PORT: 3003
    JWT_SECRET: ${JWT_SECRET}
    DB_SERVICE_URL: http://db-service:3006
  ports:
    - "3003:3003"
  networks:
    - app-network
  restart: unless-stopped
  depends_on:
    auth-service:
      condition: service_healthy
```

Handles downloading Telegram media files. Same pattern as telegram-read-service.
Shares `JWT_SECRET` so it can verify authentication tokens independently without
calling auth-service on every request.

### 2.8 Service: google-upload-service

```yaml
google-upload-service:
  build:
    context: ./services/google-upload-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-google-upload-service:latest
  environment:
    PORT: 3004
  ports:
    - "3004:3004"
  networks:
    - app-network
  restart: unless-stopped
```

Placeholder service for future Google Drive upload integration. It has no
`depends_on` and no `JWT_SECRET` because the Google integration is not yet
implemented. It boots immediately and starts up independently.

Note: this service is intentionally kept in the project even though it is not
yet functional — the Google service pair will be implemented in a future
iteration.

### 2.9 Service: google-download-service

```yaml
google-download-service:
  build:
    context: ./services/google-download-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-google-download-service:latest
  environment:
    PORT: 3005
  ports:
    - "3005:3005"
  networks:
    - app-network
  restart: unless-stopped
```

Partner to google-upload-service. Same placeholder status. Exposed on port 3005.

### 2.10 Service: api-gateway

```yaml
api-gateway:
  build:
    context: ./services/api-gateway
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-api-gateway:latest
  environment:
    PORT: 3000
    AUTH_SERVICE_URL: http://auth-service:3001
    READ_SERVICE_URL: http://telegram-read-service:3002
    DOWNLOAD_SERVICE_URL: http://telegram-download-service:3003
    GUPLOAD_SERVICE_URL: http://google-upload-service:3004
    GDOWNLOAD_SERVICE_URL: http://google-download-service:3005
    DB_SERVICE_URL: http://db-service:3006
  ports:
    - "3000:3000"
  depends_on:
    auth-service:
      condition: service_healthy
    telegram-read-service:
      condition: service_started
    telegram-download-service:
      condition: service_started
    google-upload-service:
      condition: service_started
    google-download-service:
      condition: service_started
  networks:
    - app-network
  restart: unless-stopped
```

The api-gateway is the single entry point for all backend traffic. The frontend
never calls individual services directly — everything goes through the gateway.
The gateway routes requests to the correct downstream service.

All the `*_SERVICE_URL` environment variables tell the gateway where to find each
service. The hostnames (`auth-service`, `telegram-read-service`, etc.) are the
Docker Compose service names and are resolved automatically by Docker DNS.

**Mixed depends_on conditions**
The gateway waits for auth-service to be `service_healthy` (because auth-service
has a healthcheck) but only waits for the other services to be
`service_started` (because they do not). This means the gateway starts as soon
as all services are at least running, even if some are still initialising.

### 2.11 Service: ui-service

```yaml
ui-service:
  build:
    context: ./services/ui-service
    dockerfile: Dockerfile
  image: sauravmehta/content-scrapper-ui-service:latest
  ports:
    - "4200:80"
  depends_on:
    - api-gateway
  networks:
    - app-network
  restart: unless-stopped
```

The Angular frontend, served by nginx. A few things to notice:

**ports: "4200:80"**
The nginx container listens on port 80 (standard HTTP). We publish it to port
4200 on the host. Why 4200? Angular's built-in dev server (`ng serve`) uses 4200
by default, so developers instinctively reach for `http://localhost:4200`. Using
the same port avoids confusion.

**No environment variables**
The UI is compiled static HTML/JS/CSS. It has no access to environment variables
at runtime (the browser is not a Node.js process). All configuration is baked
into the build.

**depends_on: - api-gateway**
Simple list form with no condition. This is equivalent to
`condition: service_started`. The gateway has no healthcheck either.

**The nginx reverse proxy**
Inside the ui-service container, nginx does two things:
1. Serves the compiled Angular bundle as static files for any request that
   matches a real file path.
2. Proxies any request starting with `/api/` to `http://api-gateway:3000/`,
   stripping the `/api/` prefix. This means the browser calls
   `/api/some-endpoint` and nginx forwards it to `api-gateway:3000/some-endpoint`
   without the browser needing to know the gateway's address.

The nginx config also has specialised `location` blocks for:
- `/api/download/file` — binary file streaming, must disable nginx buffering to
  avoid truncation.
- `/api/download/batch` — bulk download, extended 600s timeouts.
- SSE streams — `proxy_buffering off` and `proxy_cache off` so the
  browser receives server-sent events in real time.

---

## 3. How to Run Locally — Step by Step

### Prerequisites

Before you start, install:
- **Docker Desktop** — download from https://www.docker.com/products/docker-desktop/.
  On Mac it provides both the `docker` CLI and Docker Compose. Start it and make
  sure the whale icon appears in your menu bar.
- **Git** — for cloning the repository.

### Step 1 — Clone the repository

```bash
git clone https://github.com/mehtasaurav/miniGram.git
cd miniGram
```

### Step 2 — Create your secrets file

Docker Compose reads environment variables from a file named `.env` in the same
directory as `docker-compose.yml`. One is already included in the repository with
safe local defaults:

```
# /miniGram/.env (already present — do not commit changes to this)
JWT_SECRET=dev-secret-change-me-in-production
POSTGRES_USER=minigram
POSTGRES_PASSWORD=changeme
POSTGRES_DB=minigram
DATABASE_URL=postgres://minigram:changeme@postgres:5432/minigram
```

This file is already in the repo for local development convenience. Never
commit real credentials here if you fork the project.

What each variable does:
- `JWT_SECRET` — a string used to sign authentication tokens. Any value works
  locally. In production this must be long, random, and secret.
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — credentials the
  postgres container uses to create the database on first startup.
- `DATABASE_URL` — the full connection string used by db-service to connect to
  postgres. The hostname `postgres` in the URL must match the service name in
  `docker-compose.yml`.

### Step 3 — Build and start the stack

```bash
docker compose up --build
```

This single command:
1. Reads `docker-compose.yml` in the current directory.
2. Builds a Docker image from source code for every service that has a `build:`
   block (all except postgres). This takes 3-5 minutes on the first run because
   it is downloading base images and installing npm packages.
3. Starts all containers in dependency order.
4. Streams logs from all containers to your terminal.

Alternatively, to run in the background (detached mode):

```bash
docker compose up --build -d
```

The `-d` flag stands for "detached". The terminal returns immediately.
Use `docker compose logs -f` to follow logs afterwards.

Or, using the Makefile shortcut:

```bash
make up      # equivalent to docker compose up --build -d
make logs    # equivalent to docker compose logs -f
make down    # stop everything
```

### Step 4 — What to expect during startup

Containers start in this order due to `depends_on` declarations:

```
postgres (boots, runs healthcheck)
    └── db-service (waits for postgres healthy)
            └── auth-service (waits for db-service healthy)
                    ├── telegram-read-service (waits for auth-service healthy)
                    ├── telegram-download-service (waits for auth-service healthy)
                    └── google-upload-service (no deps, starts immediately)
                    └── google-download-service (no deps, starts immediately)
                            └── api-gateway (waits for auth-service healthy + others started)
                                    └── ui-service (waits for api-gateway started)
```

The full stack takes about 30-60 seconds from `docker compose up` to all
services healthy.

You will see log lines like:

```
postgres        | database system is ready to accept connections
db-service      | Server running on port 3006
auth-service    | Server running on port 3001
...
```

### Step 5 — Open the application

Once all services are up, open: http://localhost:4200

That is the ui-service nginx serving the Angular app. The app makes API calls to
`/api/...` which nginx proxies to the api-gateway.

### Step 6 — Verify individual services

Each backend service exposes its port directly on your machine:

| Service | URL | Useful check |
|---------|-----|-------------|
| api-gateway | http://localhost:3000/health | Gateway health |
| auth-service | http://localhost:3001/health | Auth service health |
| telegram-read-service | http://localhost:3002/health | Read service health |
| telegram-download-service | http://localhost:3003/health | Download service health |
| google-upload-service | http://localhost:3004/health | Upload service health |
| google-download-service | http://localhost:3005/health | Download service health |
| db-service | http://localhost:3006/health | DB service health |

Note: postgres port 5432 is NOT exposed to the host in the main
`docker-compose.yml`. To connect to it from a database GUI like TablePlus, use
`docker-compose.local.yml` which exposes port 5432, or exec into the container.

### Step 7 — Stop the stack

```bash
docker compose down        # stop and remove containers (data volume survives)
docker compose down -v     # also remove the pg-data volume (DELETES ALL DATA)
```

`down` without `-v` preserves your postgres data. Next time you run
`docker compose up`, postgres finds the existing data directory and skips
initialisation.

---

## 4. Service Communication — Docker DNS and Exposed Ports

### How containers find each other

When Docker creates a bridge network, it also runs a built-in DNS server for
that network. Every container that joins the network is automatically registered
in DNS with its service name as the hostname.

In `docker-compose.yml`, the service is named `db-service`. Any other container
on `app-network` can reach it at `http://db-service:3006`. Docker translates
`db-service` to the container's internal IP address automatically.

This is why auth-service has:
```
DB_SERVICE_URL: http://db-service:3006
```

The string `db-service` is not a real domain name on the internet. It only
resolves inside the Docker network. If you tried to curl `http://db-service:3006`
from your laptop's terminal (outside Docker), it would fail with a DNS resolution
error.

### The difference between internal and external ports

Containers communicate with each other on **internal ports** — the port the
process inside the container actually listens on. These are never exposed to your
laptop.

The `ports:` field in a service definition **publishes** (exposes) an internal
port to your laptop's network. Format: `"<host-port>:<container-port>"`.

```yaml
ports:
  - "3001:3001"
```

This says: "when someone connects to port 3001 on my laptop, forward that
connection to port 3001 inside the auth-service container."

**What is accessible from your laptop vs what stays inside Docker:**

| What | Port | Accessible from laptop? |
|------|------|------------------------|
| ui-service nginx | 80 (internal) → 4200 (host) | Yes, at localhost:4200 |
| api-gateway | 3000 (internal) → 3000 (host) | Yes, at localhost:3000 |
| auth-service | 3001 (internal) → 3001 (host) | Yes, at localhost:3001 |
| telegram-read-service | 3002 → 3002 | Yes |
| telegram-download-service | 3003 → 3003 | Yes |
| google-upload-service | 3004 → 3004 | Yes |
| google-download-service | 3005 → 3005 | Yes |
| db-service | 3006 → 3006 | Yes |
| postgres | 5432 (internal only) | NO — not published in main Compose file |

Postgres is intentionally not exposed in the main Compose file. db-service is
the only legitimate way to interact with the database. This enforces the
microservices boundary. Use `docker-compose.local.yml` (which adds the port
mapping) when you need direct psql access during development.

### Service-to-service call path (full example)

The user clicks "download file" in the Angular app:

```
Browser (your laptop)
  → HTTP GET http://localhost:4200/api/download/file?...
  → nginx inside ui-service container (port 80)
  → nginx strips /api/ prefix, proxies to http://api-gateway:3000/download/file
  → api-gateway container (port 3000, Docker DNS resolves "api-gateway")
  → api-gateway calls http://telegram-download-service:3003/download/file
  → telegram-download-service fetches file from Telegram, streams back
  → response streams back through api-gateway → nginx → browser
```

Every hop after the browser uses Docker DNS hostnames. No IP addresses appear
in the code.

---

## 5. Docker Build — docker-compose build vs buildx bake

### Standard docker-compose build

```bash
docker compose build
```

This command:
1. Reads the `build:` section of each service in `docker-compose.yml`.
2. Runs `docker build` for each service that has a build section (skipping
   `image:` only services like postgres).
3. Builds images **for your machine's native CPU architecture** — ARM64 on Apple
   Silicon, AMD64 on Intel/AMD.
4. Tags each image with the name given in the `image:` field.

The Dockerfiles in this project use **multi-stage builds**. For example,
db-service's Dockerfile:

```dockerfile
FROM node:20-alpine AS builder    # Stage 1: install deps + copy source
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev             # Install only production deps
COPY . .

FROM node:20-alpine               # Stage 2: lean runtime image
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
EXPOSE 3006
USER node
CMD ["node", "server.js"]
```

Why two stages? The first stage installs npm packages (which requires npm and
sometimes build tools like python3/make/g++ for native addons). The second stage
starts fresh and copies only the compiled output — no npm, no build cache, no
source files. This makes the final image much smaller (around 60-80 MB vs 400+
MB) and reduces the attack surface.

The auth-service Dockerfile is slightly larger because `bufferutil`
(a Telegram client dependency) is a native C++ addon that must be compiled:

```dockerfile
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev
```

Alpine Linux is minimal — it does not include a C compiler by default. The
`apk add` installs the build tools into the builder stage only. They are
discarded when the runtime stage starts fresh.

The ui-service has three stages — deps, build, serve:

```dockerfile
FROM node:20-alpine AS deps     # Stage 1: npm install
FROM node:20-alpine AS builder  # Stage 2: ng build (TypeScript → JavaScript)
FROM nginx:alpine               # Stage 3: serve compiled files with nginx
```

The final image contains only nginx and the compiled HTML/JS/CSS. Node.js is
completely absent from the production image.

### docker compose up --build

```bash
docker compose up --build
```

Combines build and start. Rebuilds any service whose build context has changed,
then starts the entire stack. For day-to-day development, use this.

### docker buildx bake (multi-platform builds)

```bash
docker buildx bake --file docker-compose.yml --set "*.platform=linux/amd64" --push
```

`buildx` is Docker's extended build tool that supports **multi-platform image
builds**. `bake` is a subcommand of buildx that reads a build definition (in this
case the Compose file itself) and builds multiple images together.

Key differences from `docker compose build`:

| Aspect | docker compose build | docker buildx bake |
|--------|---------------------|--------------------|
| Platform | Host machine's native arch | Can cross-compile for any platform |
| Push | Separate `docker compose push` step | Can push directly with `--push` |
| Multi-arch | Not supported natively | Can build for multiple platforms in one shot |
| Build context | Per-service by default | Reads Compose file as bake definition |
| When to use | Daily local development | Before deploying to servers of different architecture |

The `--set "*.platform=linux/amd64"` flag overrides the target platform for
every service (`*` is a glob matching all services). This forces the build to
produce AMD64 binaries even on an ARM Mac — which is exactly what AWS EKS nodes
need.

**Setting up buildx**

Before using buildx for cross-platform builds, you must create a builder that
supports it:

```bash
docker buildx create --use --name multiarch 2>/dev/null || true
```

- `create` — creates a new builder instance backed by a container (using the
  `docker-container` driver instead of the default `docker` driver).
- `--use` — sets this new builder as the active one.
- `--name multiarch` — gives it a memorable name.
- `2>/dev/null || true` — swallows the error if the builder already exists.
  Safe to run repeatedly.

The default Docker builder cannot cross-compile. The new `docker-container`
builder uses QEMU (an emulator) to run AMD64 binaries inside an ARM Mac's
kernel, effectively building as if you were on an AMD64 machine.

---

## 6. ARM vs AMD64 — The Apple Silicon Trap

This section explains one of the most time-consuming bugs you can hit when
deploying from a modern Mac to cloud infrastructure. It happened to this project.

### What is a CPU architecture?

A CPU architecture defines the instruction set — the language the processor
speaks. There are two dominant families:

- **AMD64 (also called x86_64)** — Intel and AMD chips. Almost all cloud servers
  (including AWS EC2 instances) run this architecture.
- **ARM64 (also called aarch64)** — ARM processors. Apple Silicon (M1, M2, M3)
  runs this architecture. Also used by AWS Graviton instances.

A binary compiled for AMD64 will not run on ARM64 hardware, and vice versa.
When Docker builds an image, it compiles the binaries (and the base image layers)
for the machine's native architecture unless told otherwise.

### The symptom

miniGram was built on an Apple Silicon Mac with `docker compose build`.
Images were pushed to DockerHub. When deployed to EKS (which uses t3.medium
nodes — Intel AMD64), every pod crashed immediately:

```
exec format error
```

That error comes from the Linux kernel. It means the kernel tried to execute an
ELF binary (a Linux program) but found the wrong CPU instruction set header —
it was ARM64 instructions, the kernel was AMD64. The kernel refuses to run it.

### Why it is easy to miss

`docker compose build` on an M1 Mac produces ARM64 images. Those images:
- Work perfectly on your Mac (`docker compose up` runs fine).
- Work perfectly in any other ARM64 environment.
- Fail silently-looking when pushed to DockerHub — DockerHub stores them but
  does not warn you that they are ARM64.
- Crash immediately on AMD64 servers.

There is no warning during `docker compose build`. The build succeeds with exit
code 0.

### The fix

Always specify `--platform linux/amd64` when building for EKS:

**Option A — buildx bake (recommended for deployment)**
```bash
docker buildx create --use --name multiarch 2>/dev/null || true
docker buildx bake --file docker-compose.yml --set "*.platform=linux/amd64" --push
```

Builds all services and pushes them directly to DockerHub in one step.

**Option B — docker build for a single service**
```bash
docker build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-ui-service:latest \
  ./services/ui-service
```

**Option C — BUILDPLATFORM in Dockerfile (multi-arch images)**
For the most robust solution, add `ARG TARGETPLATFORM` to Dockerfiles and use
`--platform=$BUILDPLATFORM` on the intermediate stages. This allows publishing
a single image that works on both ARM and AMD64. Not currently implemented in
miniGram but worth knowing.

### Quick check: what architecture is an image?

```bash
docker inspect sauravmehta/content-scrapper-auth-service:latest | grep Architecture
```

You want to see `"Architecture": "amd64"` before pushing to EKS.

### The golden rule for this project

When deploying to EKS from any Apple Silicon Mac, use buildx bake, not
docker-compose build.

---

## 7. Docker Push — Getting Images to DockerHub

### What is a container registry?

A container registry is a storage service for Docker images, analogous to GitHub
for code. DockerHub (hub.docker.com) is the default public registry. When
Kubernetes pulls an image (via the `image:` field in a deployment spec), it
contacts the registry specified in the image name.

For `sauravmehta/content-scrapper-auth-service:latest`:
- `sauravmehta` — DockerHub username (the account that owns this image).
- `content-scrapper-auth-service` — the repository name.
- `latest` — the tag (version).

### Logging in

Before you can push images, you must authenticate with DockerHub:

```bash
docker login -u sauravmehta
```

Docker prompts for a password (or an access token — preferred over your actual
password; create one at hub.docker.com → Account Settings → Security). The
credentials are stored in your system keychain. You only need to do this once
per machine.

Without logging in, `docker push` returns:
```
denied: requested access to the resource is denied
```

This error means either you are not logged in, or you are logged in as a
different user who does not own the repository. This exact error appeared during
the EKS deployment session (DEPLOY-LOG step 10).

### Pushing after docker compose build

```bash
# Build all service images
docker compose build

# Push all images to DockerHub
docker compose push
```

`docker compose push` reads the `image:` field of each service in the Compose
file and pushes that image to the corresponding registry. Only services with an
`image:` field are pushed. Postgres (which uses a third-party image) is skipped.

### Pushing with buildx bake (AMD64 for EKS)

```bash
docker buildx bake --file docker-compose.yml --set "*.platform=linux/amd64" --push
```

The `--push` flag builds and pushes in one step. No separate `docker compose push`
needed.

### Pushing a single service after a code change

When only one service changed (the most common case during development), only
rebuild and push that service:

```bash
# Build single service
docker build --platform linux/amd64 \
  -t sauravmehta/content-scrapper-ui-service:latest \
  ./services/ui-service

# Push it
docker push sauravmehta/content-scrapper-ui-service:latest
```

This is much faster than rebuilding all eight images.

### Image tags

Every image in the Compose file uses the `latest` tag. This is convenient but
has a downside: Kubernetes nodes may have `latest` cached from a previous push.
If you push a new image with the same `latest` tag and the node already has the
old one cached, it may not pull the new version.

The Makefile addresses this by also tagging with the git commit SHA:

```bash
make build   # tags as :latest AND :<git-sha> simultaneously
make push    # pushes both tags
```

Using `:<git-sha>` tags makes rollbacks trivially easy (`kubectl set image
deployment/auth-service auth-service=sauravmehta/...:abc1234`).

For EKS redeploys without a tag change, force a re-pull with:
```bash
kubectl rollout restart deployment/ui-service -n minigram
```

This recreates pods, which forces them to pull a fresh image if `imagePullPolicy`
is `Always` in the Kubernetes spec.

---

## 8. Local vs Production — What Changes

Running miniGram locally on Docker Compose is fundamentally different from
running it in production on EKS (Elastic Kubernetes Service). This section maps
every difference.

### Traffic routing

| | Docker Compose (local) | Kubernetes / EKS (production) |
|---|----------------------|------------------------------|
| Entry point | localhost:4200 (direct to nginx) | AWS ALB (a managed load balancer in front of the cluster) |
| Public DNS | None — only your laptop | The ALB has a public hostname |
| TLS/HTTPS | None | Optional (ACM certificate + ALB HTTPS listener) |
| Load balancing | Single instance of each container | Multiple pod replicas distributed across nodes |

On EKS the traffic path is:
```
Internet → ALB → Kubernetes Service (ClusterIP) → ui-service pod → nginx
→ api-gateway ClusterIP Service → api-gateway pod
```

### Networking

| | Docker Compose | Kubernetes |
|---|---------------|------------|
| Service discovery | Docker DNS (service name is the hostname) | Kubernetes DNS (`<service-name>.<namespace>.svc.cluster.local`) |
| Short name resolution | `http://db-service:3006` | Also `http://db-service:3006` within the same namespace |
| Port exposure | `ports:` in Compose file exposes to localhost | `Service` (type ClusterIP or LoadBalancer) exposes within cluster or externally |
| External access | Every port in `ports:` is on localhost | Only what ALB/Ingress routes is public |

The environment variables in the Compose file — `DB_SERVICE_URL: http://db-service:3006`, `AUTH_SERVICE_URL: http://auth-service:3001` — work identically in Kubernetes because Kubernetes DNS resolves service names the same way within a namespace. The application code does not change.

### Secrets

| | Docker Compose | Kubernetes |
|---|---------------|------------|
| Source | `.env` file in project root | Kubernetes `Secret` resource (base64-encoded, managed by Helm) |
| Location | File on developer's machine | Stored in etcd inside the cluster |
| How injected | `environment:` block in Compose reads `.env` | Kubernetes mounts secret values as environment variables via `envFrom:` |
| Risk | `.env` is git-ignored but on disk | Secrets are in the cluster, not on your laptop, but plain-text in etcd by default |

The actual secret values are the same (`JWT_SECRET`, `DATABASE_URL`, etc.). Only
the delivery mechanism differs.

### Postgres

| | Docker Compose | Kubernetes |
|---|---------------|------------|
| How deployed | `image: postgres:16-alpine` as a service | StatefulSet with a PersistentVolumeClaim (EBS volume on AWS) |
| Data persistence | Named volume on Docker Desktop VM | AWS EBS volume — survives pod restarts and node failures |
| Accessible from localhost | No (port not published) | No (ClusterIP only) |
| Direct access | `docker exec -it postgres psql` | `kubectl exec -it postgres-0 -n minigram -- psql -U minigram -d minigram` |

### nginx / ui-service

| | Docker Compose | Kubernetes |
|---|---------------|------------|
| What nginx proxies to | `http://api-gateway:3000` (Docker DNS) | `http://api-gateway:3000` (Kubernetes DNS, same syntax) |
| nginx in the request path | Only when browser goes through port 4200 | Always — all traffic from ALB hits ui-service nginx |
| Download buffering | Not in the request path for API calls (browser calls api-gateway:3000 directly for downloads) | In the path — must have `proxy_buffering off` for binary streams |

This is the root cause of the download corruption bug found in the EKS deployment
(documented in DEPLOY-LOG.md, Session 2026-09-21). Locally, the Angular app
called `http://localhost:3000/download/file` directly (bypassing nginx entirely),
so the buffering settings did not matter. In production, every request goes
through nginx and binary streams were being truncated by default buffer limits.

The fix: a dedicated `location /api/download/file` block in `nginx.conf` with
`proxy_buffering off` and `proxy_request_buffering off`.

### Configuration summary

Things that are the same in both environments:
- Service names used as hostnames (`db-service`, `auth-service`, etc.)
- Internal port numbers (3000-3006, 80)
- Environment variable names
- Docker images (same images, pushed to DockerHub, used by both)

Things that are different:
- How traffic enters the system (localhost vs ALB)
- How secrets are stored (`.env` file vs Kubernetes Secret)
- How services are scaled (single container vs replicated pods)
- Postgres data storage (Docker volume vs AWS EBS)
- Nginx in the critical path (optional locally, always present in production)
- CPU architecture of images (host arch locally, must be linux/amd64 for EKS)

---

## Quick Reference

### Start the full stack locally
```bash
docker compose up --build          # foreground, logs in terminal
docker compose up --build -d       # background
make up                            # shortcut for the above
```

### Watch logs
```bash
docker compose logs -f             # all services
docker compose logs -f auth-service  # single service
make logs
```

### Stop
```bash
docker compose down                # keep data
docker compose down -v             # wipe data too
make down
```

### Build for EKS (Apple Silicon Mac — IMPORTANT)
```bash
docker buildx create --use --name multiarch 2>/dev/null || true
docker buildx bake --file docker-compose.yml --set "*.platform=linux/amd64" --push
```

### Push to DockerHub
```bash
docker login -u sauravmehta       # once per machine
docker compose build
docker compose push
```

### Check image architecture
```bash
docker inspect <image-name> | grep Architecture
# Should show "amd64" before pushing to EKS
```

### Connect to postgres (local)
Use `docker-compose.local.yml` which exposes port 5432:
```bash
docker compose -f docker-compose.local.yml up -d
# Then connect via localhost:5432 with user=minigram, pass=changeme, db=minigram
```
