# miniGram — High-Level Design

## System Components and Their Responsibilities

miniGram consists of eight services. Each owns a well-defined slice of behaviour with no overlap.

### ui-service
**What it owns:** Everything the browser sees.

The ui-service is a compiled Angular application served by nginx. It renders the login screen, the group list, the content browser, and the download controls. It knows nothing about Telegram — it calls the API gateway and displays what comes back. nginx also acts as a reverse proxy, forwarding all `/api/*` requests to the gateway, which means the browser only ever speaks to one origin, eliminating CORS complexity at the browser level.

### api-gateway
**What it owns:** The single public HTTP entry point for all backend traffic.

The gateway is a stateless Express proxy. Its only job is to receive a request, look at the URL path, and forward it to the correct internal service. It enforces a CORS policy (for local development) and configures zero-timeout proxying for the file download route. It does not validate JWTs — that is left to individual services.

### auth-service
**What it owns:** Identity and Telegram session establishment.

The auth-service handles two completely separate concerns. First, miniGram application authentication: user registration with bcrypt-hashed passwords, and login with JWT issuance. Second, Telegram session establishment: driving the MTProto OTP login ceremony (request code → submit code → handle 2FA), storing the resulting session string in the database, and serving as the place that knows whether a user's Telegram session is still valid.

### telegram-read-service
**What it owns:** All read-only Telegram data access.

This service connects to Telegram as the user, fetches group/channel lists, scans message history, categorises media by type, and streams progress updates to the browser via Server-Sent Events. It maintains an in-memory cache of scanned messages and a per-group deduplication guard to prevent redundant scans. It never downloads actual file bytes.

### telegram-download-service
**What it owns:** Binary file streaming from Telegram to the browser.

This service handles the entire download path: accepting an HTTP request with a group ID, message ID, and JWT token; resolving the media object from Telegram; streaming the encrypted binary chunks from Telegram's servers through the service to the browser using backpressure-aware streaming; supporting HTTP Range headers for resume; and logging completed downloads to the database.

### db-service
**What it owns:** All PostgreSQL access.

The db-service is the only process with a database connection. Every other service that needs persistent state calls the db-service's HTTP API. This centralises the schema, query logic, and connection pool in one place and prevents database credentials from being distributed across services.

### google-upload-service / google-download-service
**What they own:** Future Google Drive integration (not yet implemented).

These are placeholder services that start successfully but contain no real logic. Routes are already wired in the gateway and they appear in the docker-compose and Kubernetes configurations, ready for implementation.

---

## Inter-Service Communication Patterns

### Pattern 1: HTTP Proxy Chain (Standard API requests)

```
Browser
  → nginx (ui-service)   — strips /api prefix
  → api-gateway          — rewrites path, strips service prefix
  → target service       — executes business logic
  → db-service           — reads/writes PostgreSQL
```

All communication uses plain HTTP over the Docker bridge network (locally) or Kubernetes cluster network (production). No gRPC, no message queues. Services are called synchronously: the caller awaits the response before continuing.

### Pattern 2: Server-Sent Events (SSE) for progress streaming

```
Browser opens EventSource("/api/groups/:id/breakdown/stream?token=...")
  → nginx (proxy_buffering off, keep-alive)
  → api-gateway (forwarded as-is)
  → telegram-read-service

telegram-read-service:
  - sets headers: Content-Type: text/event-stream
  - calls res.flushHeaders() immediately (browser receives HTTP 200 + headers now)
  - begins iterating messages from Telegram (may take minutes)
  - every 100 messages: res.write("data: {...}\n\n")
  - browser's EventSource fires a 'message' event for each
  - when done: sends final event with done:true, calls res.end()
```

Three things must be true for SSE to work end-to-end:
1. `proxy_buffering off` in nginx — otherwise nginx holds bytes until the connection closes
2. `X-Accel-Buffering: no` header in the response — instructs nginx to respect the upstream's streaming intent
3. `Connection: keep-alive` and HTTP/1.1 on the nginx-to-gateway leg — prevents the proxy from closing the connection prematurely

### Pattern 3: JWT Authentication

All services that need to identify the caller share a single `JWT_SECRET` environment variable. The auth-service signs tokens; telegram-read-service and telegram-download-service verify them. Verification uses the `jsonwebtoken` library's `jwt.verify()` which checks both the signature and the expiry claim atomically. The gateway does not verify tokens — it forwards the `Authorization` header downstream as-is.

For file downloads, the token is passed as a `?token=` query parameter because the browser's download mechanism (anchor-click) cannot set custom headers.

### Pattern 4: Service-to-Service fetch (db-service calls)

All services call the db-service using the Node.js 20 native `fetch` API. Calls look like:
```js
const res = await fetch(`http://db-service:3006/users/${userId}`);
const user = await res.json();
```

This is synchronous-looking (via await) but non-blocking. Errors are detected by checking `res.ok` and throwing with a custom `code` property that the catch block uses to set the HTTP response status.

---

## Data Flow Diagrams

### Login Flow

```
Browser                    nginx              api-gateway         auth-service         db-service
   │                         │                    │                   │                    │
   │ POST /api/auth/login     │                    │                   │                    │
   │ {username, password}     │                    │                   │                    │
   ├────────────────────────>│                    │                   │                    │
   │                         │ POST /auth/login   │                   │                    │
   │                         ├──────────────────>│                   │                    │
   │                         │                    │ POST /login        │                    │
   │                         │                    │ (path rewritten)   │                    │
   │                         │                    ├──────────────────>│                    │
   │                         │                    │                   │ GET /users/by-     │
   │                         │                    │                   │ username/:username │
   │                         │                    │                   ├──────────────────>│
   │                         │                    │                   │                   │ SELECT *
   │                         │                    │                   │                   │ FROM users
   │                         │                    │                   │<──────────────────┤
   │                         │                    │                   │ {id, password_hash,│
   │                         │                    │                   │  ...}              │
   │                         │                    │                   │                    │
   │                         │                    │                   │ bcrypt.compare()   │
   │                         │                    │                   │ jwt.sign()         │
   │                         │                    │<──────────────────┤                    │
   │                         │<───────────────────┤                   │                    │
   │<────────────────────────┤                    │                   │                    │
   │ 200 {token, username}    │                    │                   │                    │
```

### Group Browse Flow

```
Browser                    nginx              api-gateway      telegram-read-service    db-service
   │                         │                    │                   │                    │
   │ GET /api/groups?limit=..│                    │                   │                    │
   │ Authorization: Bearer..  │                    │                   │                    │
   ├────────────────────────>│                    │                   │                    │
   │                         │ GET /groups?...    │                   │                    │
   │                         ├──────────────────>│                   │                    │
   │                         │                    │ GET /groups?...   │                    │
   │                         │                    ├──────────────────>│                    │
   │                         │                    │                   │ jwt.verify()       │
   │                         │                    │                   │ extract userId      │
   │                         │                    │                   │                    │
   │                         │                    │                   │ GET /users/:id     │
   │                         │                    │                   ├──────────────────>│
   │                         │                    │                   │<──────────────────┤
   │                         │                    │                   │ {api_id, api_hash, │
   │                         │                    │                   │  session_string}   │
   │                         │                    │                   │                    │
   │                         │                    │                   │ TelegramClient     │
   │                         │                    │                   │ .connect()         │
   │                         │                    │                   │ .getDialogs()      │
   │                         │                    │                   │ (Telegram API)     │
   │                         │                    │<──────────────────┤                    │
   │                         │<───────────────────┤                   │                    │
   │<────────────────────────┤                    │                   │                    │
   │ 200 {groups:[...],total}│                    │                   │                    │
```

### File Download Flow

```
Browser              nginx (buffering off)    api-gateway (timeout:0)  telegram-download-svc    Telegram servers
   │                       │                        │                         │                       │
   │ GET /api/download/file │                        │                         │                       │
   │ ?groupId=...           │                        │                         │                       │
   │ &messageId=...         │                        │                         │                       │
   │ &token=...             │                        │                         │                       │
   ├──────────────────────>│                        │                         │                       │
   │                       │ GET /download/file?... │                         │                       │
   │                       ├──────────────────────>│                         │                       │
   │                       │                        │ GET /download/file?...  │                       │
   │                       │                        ├───────────────────────>│                       │
   │                       │                        │                         │ jwt.verify(token)     │
   │                       │                        │                         │ fetch db-service      │
   │                       │                        │                         │ get api credentials   │
   │                       │                        │                         │                       │
   │                       │                        │                         │ MTProto connect       │
   │                       │                        │                         ├──────────────────────>│
   │                       │                        │                         │                       │
   │                       │                        │                         │ iterDownload() yields │
   │◄──────────────────────┤◄───────────────────────┤◄────────────────────── │ 512KB chunks          │
   │  chunk 1 (512KB)      │  chunk 1               │  chunk 1               │◄──────────────────────┤
   │◄──────────────────────┤◄───────────────────────┤◄───────────────────────┤  upload.getFile RPC   │
   │  chunk 2 (512KB)      │                        │                         │                       │
   │  ...                  │                        │                         │                       │
   │◄──────────────────────┤◄───────────────────────┤◄───────────────────────┤  last chunk           │
   │  HTTP 200 / 206 end   │                        │                         │                       │
   │                       │                        │                         │ POST /downloads       │
   │                       │                        │                         │ (log to db-service)   │
```

---

## Why Microservices?

miniGram did not start as a microservices project for team-scale reasons (it is a single-developer project). The architecture was chosen for specific technical reasons that each service boundary solves:

**Download service isolation:** A file download request can run for 30+ minutes and stream gigabytes of data. If this code lived in the read service, every long-running download would occupy an event loop slot in the same process that needs to answer group-list requests in under a second. Separating them means each process's event loop is only doing one kind of work.

**Auth service isolation:** The Telegram OTP flow involves a live, stateful MTProto client connection held in memory between the "send code" and "sign in" calls. This stateful object does not belong in a stateless request-handler process. Auth also issues JWTs — the signing key needs to live somewhere with a clear security boundary.

**DB service isolation:** Connection pooling, credential isolation, and schema ownership all argue for a single process that owns the database. Distributing `pg.Pool` instances across five services means five sets of database credentials, five places where SQL lives, and five sources of connection pool exhaustion.

**Read service isolation:** Message scanning is the most Telegram-heavy operation. Scanning a channel with 50,000 messages issues 500 sequential MTProto RPCs. The in-memory cache for scan results is large and should not interfere with other services' memory profiles.

The cost of this architecture is operational complexity: eight processes instead of one, eight Dockerfiles, eight Kubernetes deployments. For a single-developer project, that cost is justified by the clean separation of concerns.

---

## Database Design Overview

Two tables. No ORM. All queries are parameterised SQL.

### users
Stores miniGram application accounts and their associated Telegram credentials. A user row starts with just `username` and `password_hash` at registration. The `api_id`, `api_hash`, and `phone` columns are populated when the user completes the Telegram setup step. The `session_string` is populated after they complete the OTP login. This staged population is by design — the application guides the user through each step.

### downloads
An audit log and "already downloaded" index. Every time a file is successfully downloaded, a row is upserted into this table. The `UNIQUE(user_id, group_id, message_id)` constraint ensures each file is tracked once per user. The UI reads this table to show green checkmarks on already-downloaded items and per-group download counts as badge numbers.

The schema is intentionally minimal. There are no foreign keys from downloads to a groups table (groups are not persisted — they are always fetched live from Telegram). There is no messages table (message metadata is fetched live and cached in memory, not stored in PostgreSQL).

---

## Security Model

### Application Authentication (miniGram accounts)
Passwords are hashed with bcrypt at cost factor 12 (4,096 internal rounds, ~250ms per hash). The hash is stored; plaintext never leaves the browser. Login returns a JWT signed with HS256 using a shared secret (`JWT_SECRET`). Tokens expire after 7 days. There is no refresh-token mechanism.

Username enumeration is prevented: both "user not found" and "wrong password" return `401 { error: "Invalid credentials" }` with no distinguishing information.

### JWT Verification
`JWT_SECRET` is an environment variable injected at container startup. The auth-service, telegram-read-service, and telegram-download-service all share the same value. Each of those services calls `jwt.verify()` on every protected request. The api-gateway does not hold the secret and does not verify tokens — it forwards headers downstream. If `JWT_SECRET` is absent at startup, any service that needs it calls `process.exit(1)` immediately rather than operating in a broken state.

### Telegram Session Strings
A Telegram `session_string` is the most sensitive value in the system. It is a serialised MTProto session — anyone who holds it can authenticate as the user to Telegram with full account access. It is stored in plaintext in the PostgreSQL `users` table. The mitigations are:
- The `postgres` container has no published host port — it is only reachable from within the Docker bridge network / Kubernetes cluster network.
- The `db-service` has no authentication of its own, but is also not publicly reachable (ClusterIP service in Kubernetes, internal Docker network locally).
- Telegram sessions can be revoked from Telegram's "Active Sessions" settings page.

The known gap is encryption at rest: session strings are not encrypted before storage. This is a future improvement.

### Network Isolation
In Docker Compose, all containers share `app-network` (a bridge network). The `postgres` container has no `ports:` mapping — its port 5432 is only accessible to other containers on the same network. Similarly, `db-service` is accessible from the host on port 3006 for debugging, but in a production Kubernetes deployment it should be a ClusterIP service with no external exposure.

In Kubernetes, all services except `ui-service` are ClusterIP by default. Only the ALB Ingress creates a publicly routable endpoint, and it routes all traffic to `ui-service` first, which controls what reaches the backend via its nginx proxy configuration.

### Container Security
All Dockerfiles use `USER node` to run the Node.js process as the unprivileged `node` user (UID 1000) rather than root. This limits the blast radius of a hypothetical remote code execution exploit — an attacker who achieves command execution lands as a non-root user without write access to most of the filesystem.
