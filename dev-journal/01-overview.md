# miniGram — Project Overview

## What Is miniGram?

miniGram is a self-hosted web application that solves a specific, practical problem: Telegram groups and channels that accumulate thousands of media files (videos, images, PDFs, audio) have no native way to bulk-browse or bulk-download that media. The official Telegram clients show messages one at a time; there is no "download everything in this group" button, no media gallery view grouped by type, and no way to see at a glance that a group contains 4,500 videos and 12,000 images before committing to downloading anything.

miniGram solves this by authenticating as a real Telegram user account (using the Telegram API, not a bot), reading the full message history of any group or channel the user is a member of, categorising every piece of media, and presenting it in a clean web UI with filtering, search, and bulk-download controls.

The typical workflow is:
1. Log in to the miniGram web app with a username and password.
2. Connect your Telegram account by entering your API credentials and phone number, then completing the OTP login.
3. See a searchable list of all your Telegram groups and channels.
4. Click any group to trigger a background scan of all its messages.
5. Watch a live progress bar as the scan categorises each message by type (video, image, PDF, audio, chat, other).
6. Filter to a specific type, select files, and download them in sequence directly to your browser.

---

## System Architecture

```
                              ┌─────────────────────────────────────────────┐
                              │               External World                  │
                              │                                               │
                              │   Browser (user's laptop/desktop)             │
                              │   Telegram's MTProto servers (Telegram API)   │
                              └──────────────────┬──────────────────────────┘
                                                  │ HTTP
                                                  │
                              ┌───────────────────▼─────────────────────────┐
                              │              AWS ALB (EKS)                    │
                              │          — or —                               │
                              │    localhost:4200 (Docker Compose)            │
                              └───────────────────┬─────────────────────────┘
                                                  │ HTTP :80
                                                  │
                              ┌───────────────────▼─────────────────────────┐
                              │   ui-service  (nginx + compiled Angular SPA) │
                              │   port 80                                     │
                              │                                               │
                              │   Serves:  /          → index.html            │
                              │   Proxies: /api/*     → api-gateway:3000      │
                              │   Special: /api/download/file → buffering off │
                              │            /api/*/breakdown/stream → SSE off  │
                              └───────────────────┬─────────────────────────┘
                                                  │ HTTP :3000
                                                  │
                              ┌───────────────────▼─────────────────────────┐
                              │            api-gateway                        │
                              │            port 3000                          │
                              │                                               │
                              │  Routes:                                      │
                              │  /auth/*      → auth-service:3001             │
                              │  /groups/*    → telegram-read-service:3002    │
                              │  /download/*  → telegram-download-service:3003│
                              │  /download/log-db   → db-service:3006         │
                              │  /download/counts-db → db-service:3006        │
                              │  /google/upload  → google-upload-service:3004 │
                              │  /google/download → google-download-service:3005│
                              └──┬────────┬──────┬──────────────────────────┘
                                 │        │      │
                   ┌─────────────▼─┐  ┌──▼──────▼───┐  ┌──────────────────┐
                   │  auth-service │  │telegram-read│  │telegram-download │
                   │  port 3001    │  │port 3002    │  │port 3003         │
                   │               │  │             │  │                  │
                   │ - app login   │  │ - list groups│  │ - stream files   │
                   │ - app register│  │ - scan msgs  │  │ - per-user queue │
                   │ - TG OTP flow │  │ - SSE stream │  │ - range resume   │
                   │ - issue JWT   │  │ - topics     │  │ - log to db      │
                   └──────┬────────┘  └──────┬───────┘  └────────┬─────────┘
                          │                  │                    │
                          │ All 3 services call db-service over HTTP
                          │                  │                    │
                          └──────────────────▼────────────────────┘
                                      ┌──────────────┐
                                      │  db-service  │
                                      │  port 3006   │
                                      │              │
                                      │ - users CRUD │
                                      │ - downloads  │
                                      │ - sessions   │
                                      └──────┬───────┘
                                             │ pg driver
                                             │
                                      ┌──────▼───────┐
                                      │  PostgreSQL  │
                                      │  port 5432   │
                                      │  (not public)│
                                      └──────────────┘

   ┌──────────────────────┐    ┌──────────────────────┐
   │  google-upload-service│    │google-download-service│
   │  port 3004 (stub)    │    │  port 3005 (stub)    │
   └──────────────────────┘    └──────────────────────┘
```

---

## Technology Choices

### Node.js 20 (LTS) for all backend services

Node.js was chosen because every backend service is I/O-bound, not CPU-bound. The API gateway never computes anything — it opens sockets and pipes bytes. The auth, read, and download services spend most of their time waiting for Telegram's servers or PostgreSQL to respond. Node.js's event loop is purpose-built for this pattern: a single thread manages thousands of concurrent I/O operations without the overhead of per-thread stack memory that a Java or Python multi-threaded server would require.

Node 20 specifically was chosen for its native `fetch` API, which means no `axios` or `node-fetch` dependency for service-to-service HTTP calls.

### Express 5 for HTTP routing

Express is the thinnest possible HTTP server abstraction. Version 5 was chosen over 4 because it makes async route handlers automatically propagate unhandled promise rejections to the error handler, eliminating a whole class of silent crashes that were a known pitfall of Express 4.

### Angular 21 for the frontend

Angular was chosen over React/Vue for its opinionated structure: dependency injection, a built-in HTTP client with interceptors, and TypeScript-first design make the codebase predictable. Angular 17+ signals (`signal()`, `computed()`) replace the need for a state management library (NgRx) for local component state. Angular 21's `withComponentInputBinding()` allows route parameters to be injected as typed input signals directly onto components, removing boilerplate `ActivatedRoute` injection.

### PostgreSQL 16 for persistence

PostgreSQL was chosen over a NoSQL database because the data has clear relational structure: users own downloads, downloads reference groups and messages. The relational model gives `JOIN`s, `ON DELETE CASCADE` referential integrity, and upsert (`ON CONFLICT DO UPDATE`) semantics for free. The `BIGINT` type handles Telegram's 64-bit message IDs without precision loss. PostgreSQL 16's `pg_isready` healthcheck utility integrates cleanly with Docker's and Kubernetes's health check mechanisms.

### Telegram MTProto via GramJS

Telegram's Bot API (the simple REST API) cannot access private group history or download arbitrary files as a user. miniGram needs a real user account session, which requires the MTProto protocol — Telegram's proprietary binary protocol with its own encryption layer. GramJS is the only mature, actively maintained MTProto implementation in JavaScript/TypeScript. It abstracts the key exchange, encryption, and pagination of message history into a clean async generator API.

### Docker + Docker Compose for local development

Docker Compose gives every developer an identical environment without installing PostgreSQL, Node, or any native library on their machine. The `depends_on` + healthcheck mechanism enforces the correct startup order (postgres → db-service → auth-service → all others) declaratively.

### AWS EKS + Helm for production

EKS (Elastic Kubernetes Service) manages the Kubernetes control plane, freeing the team from etcd maintenance and master node upgrades. The Helm chart (`k8s/helm/minigram`) packages all Kubernetes resources with a single `values.yaml` file for configuration, making it possible to redeploy the entire application with one command. The AWS Load Balancer Controller provisions an Application Load Balancer automatically when an `Ingress` resource is created, giving public HTTPS access without manual ALB configuration.

---

## The Complete Request Flow: From Browser Click to File Downloaded

This section traces every hop a byte travels for the most complex request: a user clicking "Download" on a video file.

### Step 1 — User clicks Download in the Angular UI

The `downloadFile()` method in `auth.service.ts` creates a hidden `<a>` element with:
```
href = /api/download/file?groupId=-1001234567890&messageId=9876&token=eyJhbGci...
```
The token is the user's JWT, passed as a query parameter because the browser's download mechanism does not send custom headers.

The `<a>` element is clicked programmatically. The browser initiates a `GET` to `/api/download/file?...`.

### Step 2 — Request arrives at nginx (ui-service)

nginx receives the request. It evaluates its `location` blocks and matches the specific `/api/download/file` block (the longest prefix match, ahead of the generic `/api/` block). This block has:
- `proxy_pass http://api-gateway:3000/download/file` — strips `/api` and forwards to the gateway
- `proxy_buffering off` — critical: tells nginx to stream bytes to the browser immediately rather than buffering the entire file first
- `proxy_read_timeout 3600s` — allows up to one hour for the download

### Step 3 — Request arrives at the API gateway

The gateway receives `GET /download/file?...`. The `/download` route matches. The gateway proxies it to `http://telegram-download-service:3003/download/file?...` with `proxyTimeout: 0` and `timeout: 0` — meaning no timeout at all on either the upstream or downstream socket.

### Step 4 — Download service validates the JWT and finds the file

The download service:
1. Reads the `token` query parameter and calls `jwt.verify(token, JWT_SECRET)` to extract the user ID from the `sub` claim.
2. Calls `GET http://db-service:3006/users/:userId` to fetch the user's `api_id`, `api_hash`, and `session_string`.
3. Checks the in-memory client pool for an existing live `TelegramClient` for this user. Creates one if not present (performing the MTProto handshake).
4. Enqueues the download in the per-user queue (max 3 concurrent).
5. Uses GramJS to resolve the group entity from `groupId`, then fetches the message by `messageId`.

### Step 5 — Binary streaming from Telegram to the browser

The download service calls `iterDownload(client, { file: msg.media })`. GramJS:
1. Issues `upload.getFile` MTProto RPCs to Telegram's servers, 512KB at a time.
2. Decrypts each MTProto message (AES-IGE).
3. Yields each 512KB chunk as a Node.js `Buffer`.

For each chunk:
1. The download service calls `res.write(chunk)`.
2. If `res.write()` returns `false` (socket buffer full, browser is slow), the service pauses by waiting for the `drain` event before writing the next chunk. This is backpressure handling — it prevents memory from filling up.
3. The chunk flows upstream: download service → api-gateway (piped, no modification) → nginx (unbuffered, streamed immediately) → browser.

### Step 6 — Download confirmed

When all bytes are written, `res.end()` closes the response. The download service checks if `startByte + totalBytes >= fileSize * 0.99`. If true (download was complete, not aborted), it fires a background `POST /downloads` to the db-service to log the completed download. This write is fire-and-forget — failure does not affect the user.

### Step 7 — UI polling detects completion

Meanwhile, the Angular UI is polling `GET /api/groups/:groupId/log-db?userId=...` every 5 seconds. When the download log entry appears in the response, the UI transitions the item from the spinning "Downloading..." indicator to a green checkmark.

---

## Local vs Production Environment Differences

| Aspect | Local (Docker Compose) | Production (AWS EKS) |
|--------|----------------------|----------------------|
| Entry point | `localhost:4200` (nginx in Docker) | ALB DNS name (e.g. `k8s-minigram-...us-east-1.elb.amazonaws.com`) |
| TLS | None (plain HTTP) | Optional via ACM certificate configured in `values.yaml` |
| Services address each other | Docker internal DNS (`auth-service`, `db-service`, etc.) | Kubernetes ClusterIP service names (same names, same mechanism) |
| PostgreSQL storage | Docker named volume (`pg-data`) | AWS EBS volume (20Gi gp2, provisioned by EBS CSI driver) |
| Image registry | Built locally via `docker-compose build` | DockerHub (`sauravmehta/content-scrapper-*`) |
| Secrets | `.env` file at project root | Kubernetes `Secret` resource (`minigram-secrets`) |
| Port exposure | All services exposed to host (3000–3006) | Only ui-service exposed via ALB; all others are ClusterIP (cluster-internal only) |
| Startup ordering | docker-compose `depends_on` + healthchecks | Kubernetes `initContainer` with `nc -z` port check |
| Angular dev mode | `ng serve` with `proxy.conf.json` OR Docker Compose | Always Docker Compose / Kubernetes (no dev server) |
| Download URL base | `http://localhost:3000` (bypasses Angular dev proxy) | Empty string (nginx handles `/api/download/file`) |
