# miniGram — Low-Level Design

## Every API Endpoint Across All Services

### api-gateway (port 3000)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | None | Returns `{"status":"ok","service":"api-gateway"}` directly — not proxied |
| * | `/auth/*` | Forwarded | Proxied to auth-service:3001, `/auth` prefix stripped |
| * | `/groups/*` | Forwarded | Proxied to telegram-read-service:3002, path unchanged |
| * | `/download/log-db/*` | Forwarded | Proxied to db-service:3006, rewritten to `/downloads/*` |
| * | `/download/counts-db/*` | Forwarded | Proxied to db-service:3006, rewritten to `/downloads/counts/*` |
| * | `/download/*` | Forwarded | Proxied to telegram-download-service:3003, `timeout:0`, `proxyTimeout:0` |
| * | `/google/upload/*` | Forwarded | Proxied to google-upload-service:3004, prefix rewritten to `/upload/*` |
| * | `/google/download/*` | Forwarded | Proxied to google-download-service:3005, prefix rewritten to `/download/*` |

---

### auth-service (port 3001)

All requests below that are marked "JWT" require `Authorization: Bearer <token>` header. The `requireAuth` middleware extracts the user ID from `payload.sub` and sets `req.userId`.

| Method | Path | Auth | Request Body | Response | Description |
|--------|------|------|-------------|----------|-------------|
| GET | `/health` | None | — | `{"status":"ok","service":"auth-service"}` | Liveness probe |
| POST | `/register` | None | `{username, password}` | `201 {message}` or `409 {error}` | Register a new miniGram account. Password hashed with bcrypt cost 12. |
| POST | `/login` | None | `{username, password}` | `200 {token, username}` or `401 {error}` | Verify credentials and issue a 7-day JWT. |
| POST | `/setup` | JWT | `{api_id, api_hash, phone}` | `200 {message}` | Save Telegram API credentials for the current user. |
| POST | `/send-code` | JWT | — | `200 {message}` or `428 {setupRequired}` | Send Telegram OTP to the user's phone. Starts a live MTProto session held in memory. |
| POST | `/sign-in` | JWT | `{code}` | `200 {message}` or `403 {require2FA}` or `400/500` | Submit the OTP code. On success, saves the session string. On 2FA account, returns 403. |
| POST | `/2fa` | JWT | `{password}` | `200 {message}` or `400/500` | Submit the Telegram 2FA cloud password. Saves session string on success. |
| GET | `/status` | JWT | — | `200 {hasSetup, authorized}` | Check if Telegram is configured and session is still valid. Makes a live network check. |

---

### db-service (port 3006)

No authentication — relies entirely on network isolation (not publicly reachable).

| Method | Path | Request Body / Params | Response | SQL |
|--------|------|----------------------|----------|-----|
| GET | `/health` | — | `{"status":"ok","service":"db-service"}` | None |
| POST | `/users` | `{username, password_hash}` | `201 {id, username}` | `INSERT INTO users ... RETURNING id, username` |
| GET | `/users/by-username/:username` | — | `200 {full user row}` or `404` | `SELECT * FROM users WHERE username=$1` |
| GET | `/users/:id` | — | `200 {full user row}` or `400/404` | `SELECT * FROM users WHERE id=$1` |
| PATCH | `/users/:id/setup` | `{api_id, api_hash, phone}` | `200 {message}` | `UPDATE users SET api_id=$1, api_hash=$2, phone=$3 WHERE id=$4` |
| PATCH | `/users/:id/session` | `{session_string}` | `200 {message}` | `UPDATE users SET session_string=$1 WHERE id=$2` |
| POST | `/downloads` | `{userId, groupId, messageId, fileName?, fileSize?}` | `201 {ok:true}` | `INSERT ... ON CONFLICT DO UPDATE SET ...` |
| GET | `/downloads/counts/:userId` | — | `200 {groupId: count, ...}` | `SELECT group_id, COUNT(*)::int FROM downloads WHERE user_id=$1 GROUP BY group_id` |
| GET | `/downloads/:groupId?userId=<id>` | query: `userId` | `200 [{message_id, file_name, file_size, ts}, ...]` | `SELECT message_id, file_name, file_size, ts FROM downloads WHERE user_id=$1 AND group_id=$2` |

---

### telegram-read-service (port 3002)

All endpoints except `/health` require JWT. The `requireAuthSSE` variant also accepts `?token=...` for SSE and `<img>` endpoints.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Liveness probe |
| GET | `/groups?limit=N&offset=N` | JWT | List all groups/channels for the authenticated Telegram user |
| GET | `/groups/:id` | JWT | Get metadata for one group (includes `about` text from a second RPC) |
| GET | `/groups/:id/photo` | JWT (SSE) | Download the group profile photo as `image/jpeg` |
| GET | `/groups/:id/stats` | JWT | Get total message count for the group |
| GET | `/groups/:id/breakdown` | JWT | Get per-type message counts (uses full scan, cached) |
| GET | `/groups/:id/breakdown/stream` | JWT (SSE) | SSE stream of scan progress events, then final counts |
| GET | `/groups/:id/content?type=X&limit=N&offset=N` | JWT | Paginated content items filtered by type |
| GET | `/groups/:id/content/range?from=N&to=N` | JWT | Content items within a Telegram message ID range |
| GET | `/groups/:id/topics` | JWT | List forum topics for a forum-enabled supergroup |
| GET | `/groups/:id/topics/:topicId/breakdown/stream` | JWT (SSE) | SSE scan progress for a specific topic |
| GET | `/groups/:id/topics/:topicId/content?type=X` | JWT | Content items for a specific topic |
| GET | `/groups/:id/topics/:topicId/content/range?from=N&to=N` | JWT | Content items by ID range within a topic |

---

### telegram-download-service (port 3003)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Liveness probe |
| GET | `/download/file?groupId=X&messageId=Y&token=Z` | JWT (query param) | Stream a Telegram file to the browser. Supports HTTP `Range` header for resume. |

---

## Database Schema

### Table: `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  api_id         INTEGER,          -- nullable until /setup is called
  api_hash       TEXT,             -- nullable until /setup is called
  phone          TEXT,             -- nullable until /setup is called
  session_string TEXT,             -- nullable until Telegram OTP login completes
  created_at     BIGINT NOT NULL DEFAULT extract(epoch from now())
);
```

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL` (auto-incrementing int starting at 1) | Becomes the `sub` claim in JWTs |
| `username` | `TEXT NOT NULL UNIQUE` | UNIQUE creates an implicit B-tree index. 3–30 chars, validated by auth-service regex. |
| `password_hash` | `TEXT NOT NULL` | bcrypt hash string: `$2a$12$<22-char-salt><31-char-hash>`. Always 60 chars. |
| `api_id` | `INTEGER nullable` | Numeric API ID from my.telegram.org/apps |
| `api_hash` | `TEXT nullable` | 32-char hex string from my.telegram.org/apps |
| `phone` | `TEXT nullable` | E.164 format phone number e.g. `+14155552671` |
| `session_string` | `TEXT nullable` | Serialised GramJS MTProto session. Base64-encoded, several hundred characters. The most sensitive column. |
| `created_at` | `BIGINT NOT NULL DEFAULT extract(epoch from now())` | Unix timestamp in seconds. BIGINT avoids Year 2038 problem. |

### Table: `downloads`

```sql
CREATE TABLE IF NOT EXISTS downloads (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_name  TEXT,
  file_size  BIGINT,
  ts         BIGINT NOT NULL DEFAULT extract(epoch from now()),
  UNIQUE(user_id, group_id, message_id)
);

CREATE INDEX IF NOT EXISTS downloads_user_group ON downloads(user_id, group_id);
```

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL` | Surrogate key, not used in application logic |
| `user_id` | `INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Foreign key. Cascade delete means removing a user also removes all their download records. |
| `group_id` | `TEXT NOT NULL` | Telegram channel/group ID. Large negative integers like `-1001234567890`. Stored as TEXT to avoid bigint edge cases. |
| `message_id` | `TEXT NOT NULL` | Telegram message ID within the group. Also TEXT for consistency. |
| `file_name` | `TEXT nullable` | Original filename from Telegram's DocumentAttributeFilename. Null for photos. |
| `file_size` | `BIGINT nullable` | Size in bytes. BIGINT because Telegram files can exceed 2GB (int32 max). Null when Telegram doesn't report size. |
| `ts` | `BIGINT NOT NULL DEFAULT extract(epoch from now())` | Unix timestamp of download. Updated on upsert. |

**Composite unique constraint:** `UNIQUE(user_id, group_id, message_id)` — enables the upsert pattern; one record per user per message.

**Index:** `downloads_user_group ON downloads(user_id, group_id)` — covers the most common query pattern (filter by user, then by group). The unique constraint creates a three-column index, but the two-column index is more efficient for the counts query which only filters by `user_id`.

---

## nginx Location Block Logic

The nginx config at `/services/ui-service/nginx.conf` applies to the running container at `/etc/nginx/conf.d/default.conf`. The static files are at `/usr/share/nginx/html/`.

nginx evaluates `location` blocks in this order: exact match (`=`) first, then longest prefix match, then first-matching regex (`~`). The prefix block `/api/download/file` (17 chars) is longer than `/api/` (5 chars), so it wins for that path without needing a regex.

```
Incoming request path                 Matched block
─────────────────────────────────────────────────────────
/api/download/file?...               → Block 1 (prefix, 17 chars): buffering off, 3600s timeout
/api/download/batch?...              → Block 3 (prefix, 18 chars): buffering off, 600s timeout
/api/groups/123/breakdown/stream     → Block 4 (regex): SSE settings, buffering off, 600s
/api/groups/123/topics/1/breakdown/stream → Block 5 (regex): SSE settings, buffering off, 600s
/api/groups/123/breakdown            → Block 6 (regex): 600s timeout (slow scan)
/api/groups/123/content/range        → Block 7 (regex): 600s timeout
/api/groups/123/topics/1/content/range → Block 8 (regex): 600s timeout
/api/auth/login                      → Block 2 (prefix /api/): strips /api, 60s timeout
/api/groups                          → Block 2 (prefix /api/): strips /api, 60s timeout
/index.html                          → Block 9 (catch-all /): try_files, serves static file
/group/123  (Angular route)          → Block 9 (catch-all /): no file found, serves index.html
```

**Why Block 1 must exist separately from Block 2:**
Block 2 (`location /api/`) with `proxy_pass http://api-gateway:3000/` would also match `/api/download/file` if Block 1 didn't exist. But Block 2 has no `proxy_buffering off` setting. Without buffering disabled, nginx accumulates the entire binary file response in its internal buffer (~1MB default), then fails or truncates when the buffer is exhausted for large files. Every download over ~1MB would be corrupted. Block 1 exists specifically to add `proxy_buffering off` for the download path.

**Why `proxy_http_version 1.1; proxy_set_header Connection ''` in streaming blocks:**
By default, nginx uses HTTP/1.0 when proxying. HTTP/1.0 does not support persistent connections — each request/response cycle closes the TCP connection. For SSE and large file streaming, a persistent connection is required. Setting `proxy_http_version 1.1` enables HTTP/1.1, and clearing the `Connection` header (`Connection ''`) removes the default `Connection: close` that nginx adds, allowing the connection to remain open for the entire duration of the stream.

**The `rewrite` directive in SSE blocks:**
```nginx
rewrite ^/api/(.*)$ /$1 break;
proxy_pass http://api-gateway:3000;
```
The SSE blocks use `rewrite` rather than `proxy_pass` with a trailing `/` to strip the `/api` prefix. The `break` flag stops further rewriting. This is equivalent to `proxy_pass http://api-gateway:3000/;` with a trailing slash but is necessary when `proxy_pass` is used without a URI component (just the host).

**The catch-all `try_files $uri $uri/ /index.html`:**
This is what makes Angular's client-side router work. When the browser navigates to `/group/123` and refreshes the page, nginx looks for a file named `group/123` (not found), then a directory named `group/123` (not found), then falls back to `index.html`. Angular boots, reads the URL, and the router renders the `GroupDetailComponent`. Without this, any Angular route that is not the root would return 404 on page refresh.

---

## JWT Payload Structure and Verification Flow

### Payload structure

```json
{
  "sub": 42,
  "username": "alice",
  "iat": 1700000000,
  "exp": 1700604800
}
```

- `sub`: The user's database integer ID (PostgreSQL `SERIAL`). This is the canonical user identifier used everywhere.
- `username`: Human-readable display name. Stored in the token as a convenience — services that need to display the username don't have to call db-service.
- `iat`: Issued-at timestamp (Unix seconds). Added automatically by `jsonwebtoken`.
- `exp`: Expiry timestamp = `iat + 7 days`. Added by `expiresIn: '7d'`.

### Signing
Algorithm: `HS256` (HMAC-SHA256). Symmetric — the same `JWT_SECRET` is used for both signing and verification. The token structure is `base64url(header) . base64url(payload) . HMAC-SHA256(header+payload, secret)`.

### Verification flow (in requireAuth middleware)
```
1. Read req.headers.authorization
2. If absent or doesn't start with "Bearer " → 401
3. Extract token = header.split(' ')[1]
4. jwt.verify(token, JWT_SECRET)
   ├─ If signature invalid → throws JsonWebTokenError → 401
   ├─ If expired → throws TokenExpiredError → 401
   └─ If valid → returns decoded payload
5. req.userId = payload.sub   (integer database ID)
6. req.username = payload.username
7. next() → route handler runs
```

### Client-side decode (no verification)
The Angular `AuthService.getUserId()` decodes the JWT payload without verifying it:
```ts
const payload = JSON.parse(atob(token.split('.')[1]));
return payload.sub;
```
This is intentionally not a security check — it's just reading the user's own ID out of their own token for convenience. The backend always re-verifies the full signature.

---

## Telegram MTProto Connection Lifecycle

### Connection establishment
1. `new TelegramClient(new StringSession(sessionString), apiId, apiHash, options)` — creates the client object. No network activity yet.
2. `client.connect()` — performs the full MTProto handshake:
   - Opens a WebSocket (because `useWSS: true`) to one of Telegram's data centre IP addresses.
   - Sends `req_pq_multi` to begin the Diffie-Hellman key exchange.
   - Completes the DH exchange to establish a shared 256-bit AES key.
   - Sends `auth.importAuthorization` to resume the existing session from the `session_string`.
   - If the session is valid, the client is authenticated and ready.
   - If the session was revoked (user logged out another device), throws `SESSION_REVOKED`.

### Telegram API calls (RPC)
All Telegram API calls go through the authenticated MTProto connection as RPC requests. Each RPC call:
1. Serialises a TL (Type Language) object (e.g. `Api.messages.GetHistory`) to binary.
2. Encrypts it with the session's AES-IGE key.
3. Sends it over the WebSocket.
4. Waits for a reply.
5. Decrypts and deserialises the response.

High-level helpers like `client.getDialogs()` and `client.iterMessages()` issue multiple RPCs internally, handling pagination transparently.

### Connection in the read service (per-request)
The telegram-read-service creates a new `TelegramClient` for every HTTP request and disconnects it in the `finally` block. This is stateless and simple but pays the handshake cost (~200ms) on every request.

### Connection in the download service (pooled)
The telegram-download-service maintains a `Map<userId, TelegramClient>` pool. It checks `client.connected` before reuse and reconnects if disconnected. This avoids the handshake cost on repeat downloads by the same user.

### Session storage
After the initial OTP login (in auth-service), `client.session.save()` serialises the session to a base64 string. This string is stored in the `users.session_string` column. All subsequent connections by any service use this stored string via `new StringSession(storedString)`, resuming the existing session without re-authentication.

---

## Docker Multi-Stage Build Strategy

All services use the same two-stage pattern:

```dockerfile
# Stage 1: builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./               # Copy manifests FIRST (layer cache optimisation)
RUN apk add ... && npm ci --omit=dev  # Install deps (cached if package*.json unchanged)
COPY . .                            # Copy source (this layer busts on code changes only)

# Stage 2: runtime
FROM node:20-alpine                 # Fresh base, no build tools
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules  # Copy compiled deps only
COPY --from=builder /app/server.js ./                 # Copy only what is needed at runtime
EXPOSE <port>
USER node                           # Drop from root to unprivileged user
CMD ["node", "server.js"]           # exec form: node is PID 1, receives OS signals directly
```

**Why copy `package*.json` before source files:**
Docker caches each `RUN` instruction as a layer keyed by the layer's inputs. By copying `package.json` and `package-lock.json` first and running `npm ci`, that layer is cached as long as neither file changes. On subsequent builds where only `server.js` changed, Docker reuses the cached `npm ci` layer and skips reinstalling hundreds of packages. This turns a 2-minute build into a 10-second build for most code changes.

**Why two stages:**
The builder stage installs compilation tools (`python3 make g++` for GramJS's native addons) and development tooling. None of these belong in the production image. The runtime stage starts from a clean Alpine base and receives only the compiled `node_modules` and source files. Result: a ~150MB production image instead of a ~600MB image that includes compilers.

**Why `CMD ["node", "server.js"]` (exec form) instead of `CMD node server.js` (shell form):**
Shell form wraps the command in `/bin/sh -c`. The shell becomes PID 1. When Docker sends `SIGTERM` to stop the container gracefully, the signal goes to the shell, which may not forward it to Node.js. Exec form makes `node` PID 1 directly, so signals are delivered to the application. This enables graceful shutdown.

**Auth-service and telegram-read-service additionally need build tools:**
The `bufferutil` package (a GramJS dependency) requires compilation from C++ source on Alpine Linux (which uses `musl libc`, not `glibc`, so pre-built binaries don't work). The build stage installs `python3 make g++` from Alpine's package repository to enable this compilation. The runtime stage copies only the resulting compiled binary — no compilers.

---

## Kubernetes Resource Definitions

### Namespace
```yaml
kind: Namespace
metadata:
  name: minigram
```
Groups all miniGram resources. Allows `kubectl get pods -n minigram` to show only this project's pods and `kubectl delete ns minigram` to remove everything at once.

### Secret
```yaml
kind: Secret
type: Opaque
data:
  JWT_SECRET: <base64>
  POSTGRES_USER: <base64>
  POSTGRES_PASSWORD: <base64>
  POSTGRES_DB: <base64>
  DATABASE_URL: <base64>
```
Stores sensitive values separately from the Helm `values.yaml`. Values are base64-encoded (NOT encrypted by default — Kubernetes Secrets are only base64 in etcd unless encryption at rest is configured). Pods reference secrets with `valueFrom.secretKeyRef` instead of hard-coding values in the deployment spec.

### Deployment (for stateless services)
```yaml
kind: Deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: <service-name>
  template:
    spec:
      initContainers:
        - name: wait-for-db-service
          image: busybox:1.36
          command: ["sh", "-c", "until nc -z db-service 3006; do sleep 2; done"]
      containers:
        - name: <service-name>
          image: <dockerhub-image>:latest
          readinessProbe:
            httpGet:
              path: /health
              port: <port>
          livenessProbe:
            httpGet:
              path: /health
              port: <port>
          resources:
            requests: { cpu: "150m", memory: "256Mi" }
            limits:   { cpu: "500m", memory: "512Mi" }
```
Used for: api-gateway, auth-service, db-service, telegram-read-service, telegram-download-service, google-*-service, ui-service.

Key points:
- `initContainers`: The `busybox nc -z` pattern checks if a TCP port is accepting connections. This replaces docker-compose's `depends_on: condition: service_healthy` — Kubernetes doesn't have that natively without a controller.
- `readinessProbe`: Kubernetes only routes traffic to a pod when readiness passes. During startup, the pod is excluded from the Service's endpoint list. This prevents "connecting to a pod that is still initialising" errors.
- `livenessProbe`: If this fails, Kubernetes restarts the pod. Set with a longer `initialDelaySeconds` than readiness to avoid restart loops during cold starts.
- `resources.requests`: Used by the Kubernetes scheduler to decide which node to place the pod on. Under-provisioning causes throttling; over-provisioning wastes node capacity.

### StatefulSet (for PostgreSQL)
```yaml
kind: StatefulSet
spec:
  serviceName: postgres
  replicas: 1
  volumeClaimTemplates:
    - metadata:
        name: pg-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp2
        resources:
          requests:
            storage: 20Gi
```
StatefulSet (not Deployment) is used because PostgreSQL stores data on disk. Two guarantees StatefulSets provide that Deployments do not:
1. Stable pod name (`postgres-0`) — the `DATABASE_URL` hostname never changes between pod restarts.
2. `volumeClaimTemplates` — automatically creates a PersistentVolumeClaim (which the EBS CSI driver fulfils by provisioning an actual EBS volume), and re-attaches the same EBS volume every time `postgres-0` restarts, even on a different node.

### Service (ClusterIP)
```yaml
kind: Service
spec:
  type: ClusterIP
  selector:
    app: <service-name>
  ports:
    - port: <port>
      targetPort: <port>
```
Creates a stable DNS name (`<service-name>.<namespace>.svc.cluster.local`, also usable as just `<service-name>` within the same namespace) that routes to any pod matching the selector. ClusterIP means the service is only reachable from within the cluster — no external access. This is correct for all services except `ui-service`, which is exposed through the Ingress.

### Ingress (ALB)
```yaml
kind: Ingress
metadata:
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=600
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ui-service
                port:
                  number: 80
```
The Ingress is the only resource that creates something public-facing in AWS. The `alb` ingress class tells the AWS Load Balancer Controller to provision a real AWS ALB. `scheme: internet-facing` makes it publicly reachable. `target-type: ip` routes traffic directly to pod IPs (requires VPC CNI add-on). The `idle_timeout.timeout_seconds=600` annotation extends the ALB's connection timeout from the default 60 seconds to 600 seconds, which is necessary for large Telegram file downloads and long SSE streams.

All traffic is routed to `ui-service:80`. The nginx inside ui-service then handles routing to api-gateway internally — this keeps all the streaming/SSE/timeout configuration in the Docker image (nginx.conf) rather than split across ALB listener rules.
