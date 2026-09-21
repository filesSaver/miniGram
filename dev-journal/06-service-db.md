# miniGram — DB Service Deep Dive

**Location:** `/services/db-service/`
**Port:** 3006
**Docker image:** `sauravmehta/content-scrapper-db-service:latest`

---

## 1. Purpose

The db-service is a **data access layer microservice** — its sole job is to own and expose the PostgreSQL database over HTTP. Every other service in miniGram that needs persistent storage (auth-service, telegram-read-service, telegram-download-service, api-gateway) talks to the database exclusively through this service's REST API. No other service holds a `pg` connection pool or a database password.

### Why a Separate DB Service Instead of Direct DB Access?

In a monolith, every module imports a database client and connects directly. In this microservices architecture, that pattern creates problems this service solves:

**Single point of truth for the schema.** Every SQL query lives in one file. The schema, the migration logic, and the access patterns are documented together.

**Connection pooling owned by one process.** PostgreSQL has a finite number of allowed concurrent connections (default 100). If five Node processes each maintained a `Pool` of 10 connections, you would exhaust the limit quickly, especially when Kubernetes runs multiple replicas. By routing all queries through one process, the entire cluster uses exactly one pool.

**Credential isolation.** Only db-service needs `DATABASE_URL` in its environment. auth-service, telegram-read-service, and telegram-download-service never see the database password. A compromised auth-service cannot run arbitrary SQL.

**Deployable independently.** The database access layer can be updated — indexes added, query shapes changed, a new column backfilled — without touching the other services, as long as the HTTP contract stays compatible.

**Network-enforced security.** The `postgres` container does not publish its port 5432 to the host machine. Only services on `app-network` can reach it, and only db-service ever uses that access in practice.

---

## 2. Tech Stack

### Node.js 20 (Alpine)

Node 20 is the current LTS line. It ships native `fetch` (used by all calling services), which is why those services do not need `axios` or `node-fetch` as dependencies.

### express 5.2.1

Express is the HTTP framework. Version 5 brings automatic async error handling: if an `async` route handler throws, Express 5 catches it and passes it to the error handler without needing an explicit `try/catch` in every route. This project still uses explicit `try/catch` per route, so the v5 benefit is available but not yet exploited.

`express.json()` is registered as global middleware. It parses incoming requests with `Content-Type: application/json` and populates `req.body`. Without it, `req.body` would be `undefined` on POST/PATCH routes.

### pg 8.13.3 (node-postgres)

The canonical Node.js PostgreSQL client. The service uses the `Pool` class rather than the lower-level `Client`. A `Pool` manages a set of reusable TCP connections to PostgreSQL. When a query arrives, the pool lends an idle connection, runs the query, and returns the connection. This is far more efficient than opening a new TCP connection per HTTP request.

`Pool` is constructed with `{ connectionString: process.env.DATABASE_URL }`. The connection string encodes host, port, database name, username, and password in a single `postgresql://user:pass@host:port/dbname` URI.

All queries use parameterised form: `pool.query('SELECT … WHERE id = $1', [id])`. The `$1`, `$2`, … placeholders are PostgreSQL's native parameter syntax. The `pg` driver sends parameter values separately from query text — the database never interpolates user input into raw SQL. This eliminates SQL injection at the driver level.

### nodemon 3.1.14 (devDependency only)

nodemon watches `server.js` for file changes and restarts the process automatically during development (`npm run dev`). It is excluded from the production Docker image via `npm ci --omit=dev`.

---

## 3. File by File

### `.dockerignore`

```
node_modules
npm-debug.log
```

Excludes `node_modules` from the Docker build context. Without this, the build context would include the entire `node_modules` directory (potentially hundreds of megabytes), slowing down every build. The Dockerfile reinstalls dependencies fresh inside the container anyway.

### `Dockerfile`

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
EXPOSE 3006
USER node
CMD ["node", "server.js"]
```

**Two-stage build:**

Stage 1 (`builder`): Copies `package.json` and `package-lock.json` first, then runs `npm ci --omit=dev`. This is a Docker layer-caching optimisation — if neither file changes between builds, the `npm ci` layer is reused from cache and dependency installation is skipped entirely. `npm ci` installs exact locked versions from `package-lock.json`; `--omit=dev` skips `nodemon`.

Stage 2 (runtime): Starts fresh from the same base image with no build tools. Only `node_modules` and `server.js` are copied. `EXPOSE 3006` documents the port (actual binding happens in docker-compose). `USER node` drops privileges from root to the built-in `node` user — a security best practice that limits damage from a hypothetical remote code execution exploit. `CMD ["node", "server.js"]` uses exec form (JSON array) so `node` is PID 1 and receives OS signals directly.

### `package.json`

`"type": "commonjs"` means all `require()` calls use CommonJS resolution. `"main": "server.js"` is the entry point. No compile step needed — the service is plain JavaScript.

### `server.js` — The Entire Application (174 lines)

**Lines 1–5: Imports and app setup**

```js
const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json());
```

Only `Pool` is destructured from `pg` — the `Client` class and other exports are unused.

**Lines 7–12: Port and fail-fast guard**

```js
const PORT = process.env.PORT || 3006;

if (!process.env.DATABASE_URL) {
  console.error('[db-service] FATAL: DATABASE_URL is not set');
  process.exit(1);
}
```

The `process.exit(1)` guard is a **fail-fast** pattern. Rather than starting up and then crashing five minutes later on the first query, the process immediately exits with a non-zero code if the critical credential is absent. Docker and Kubernetes will restart the container and surface the error in logs instantly.

**Line 14: Pool creation**

```js
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

Created at module load time. `pg` opens connections lazily on first use, not immediately. Default pool size: 10 concurrent connections.

**Lines 16–43: `initDb()` function**

The schema migration function. Called once at startup before the HTTP server accepts requests. Uses PostgreSQL's `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` DDL statements — idempotent, meaning they succeed on first run and silently no-op on subsequent restarts. This is a manual, code-driven migration strategy with no external migration framework.

**Line 47: Health check route**

```js
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'db-service' }));
```

Stateless and synchronous — returns immediately. Docker Compose uses `wget -qO- http://localhost:3006/health` in the `healthcheck` stanza. Note: the health check does not verify the database connection, only that the HTTP server is running.

**Lines 171–173: Startup sequence**

```js
initDb()
  .then(() => app.listen(PORT, () => console.log(`[db-service] running on port ${PORT}`)))
  .catch(err => { console.error('[db-service] DB init failed:', err.message); process.exit(1); });
```

`initDb()` runs first. Only after the DDL statements complete successfully does `app.listen()` open the port. If the database is unreachable, `process.exit(1)` fires and Docker restarts the container. By the time the health check at `/health` returns `ok`, the schema is guaranteed to exist.

---

## 4. Database Schema

### Table: `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  api_id         INTEGER,
  api_hash       TEXT,
  phone          TEXT,
  session_string TEXT,
  created_at     BIGINT NOT NULL DEFAULT extract(epoch from now())
);
```

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `SERIAL` (auto-increment int starting at 1) | Surrogate key. Becomes the `sub` claim in JWTs. |
| `username` | `TEXT NOT NULL UNIQUE` | The miniGram login name. The `UNIQUE` constraint creates an implicit B-tree index. Validated against `/^[a-zA-Z0-9_]{3,30}$/` in auth-service before insert. |
| `password_hash` | `TEXT NOT NULL` | The bcrypt hash string produced by auth-service. Always 60 characters in format `$2a$12$<salt><hash>`. The plaintext password never enters this table. |
| `api_id` | `INTEGER nullable` | Telegram developer application ID from my.telegram.org. Null until the user completes the Telegram setup step. |
| `api_hash` | `TEXT nullable` | 32-character hex string from my.telegram.org. Null until setup. |
| `phone` | `TEXT nullable` | E.164 format phone number (e.g. `+14155552671`). Stored as TEXT to preserve the leading `+` and avoid numeric coercion. Null until setup. |
| `session_string` | `TEXT nullable` | The serialised MTProto session from GramJS. Several hundred characters, base64-encoded. Null until the user completes Telegram OTP login. **The most sensitive column** — see Security section. |
| `created_at` | `BIGINT NOT NULL DEFAULT extract(epoch from now())` | Unix timestamp in seconds. `BIGINT` avoids the Year 2038 problem inherent in 32-bit integers. The `DEFAULT` clause means the application never needs to pass a timestamp on insert. |

**Why no `updated_at`?** The schema uses targeted PATCH endpoints rather than general-purpose updates, and no current read path sorts or filters by last-modification time. This is a pragmatic omission.

**Why no email?** miniGram is Telegram-centric. Email is not part of the authentication or notification flow.

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

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `SERIAL` | Surrogate key. Not used in application logic. |
| `user_id` | `INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Foreign key. `ON DELETE CASCADE` means deleting a user row also deletes all their download records — no orphan rows. |
| `group_id` | `TEXT NOT NULL` | Telegram channel or group ID. Typically a large negative integer like `-1001234567890`. Stored as TEXT because Telegram's API returns these as strings in the frontend layer, avoiding sign/overflow edge cases with 64-bit integers. |
| `message_id` | `TEXT NOT NULL` | Telegram message ID within the group. Also TEXT for consistency. |
| `file_name` | `TEXT nullable` | Original filename from Telegram's `DocumentAttributeFilename`. Null for photos (which have no filename attribute). |
| `file_size` | `BIGINT nullable` | File size in bytes. `BIGINT` because Telegram allows files up to 4 GB, which exceeds the 32-bit integer max (~2.1 GB). Null when Telegram does not report a size. |
| `ts` | `BIGINT NOT NULL DEFAULT extract(epoch from now())` | Unix timestamp of when the download was recorded. Refreshed on every upsert. |

**Composite unique constraint:** `UNIQUE(user_id, group_id, message_id)` — business logic constraint: one download record per user per message. Enables the upsert in `POST /downloads`.

**Index:** `downloads_user_group ON downloads(user_id, group_id)` — B-tree index on the two most-filtered columns. Every query against `downloads` filters by `user_id` and often also by `group_id`. The unique constraint also creates an implicit three-column index, but the two-column index is more efficient for the counts query which only filters by `user_id`.

---

## 5. API Endpoints

### `GET /health`
Returns `{ "status": "ok", "service": "db-service" }`. Used by Docker Compose and Kubernetes health checks.

---

### `POST /users`
**Called by:** auth-service on registration.

**Request body:**
```json
{ "username": "alice", "password_hash": "$2a$12$..." }
```

**Response (201):**
```json
{ "id": 42, "username": "alice" }
```

**Response (400):** `{ "error": "username and password_hash are required" }` when either field is missing.

**Response (409):** `{ "error": "Username already taken" }` when `err.code === '23505'` (PostgreSQL unique constraint violation error code).

**SQL:**
```sql
INSERT INTO users (username, password_hash)
VALUES ($1, $2)
RETURNING id, username
```

The `RETURNING` clause eliminates a second SELECT round-trip to get the new row's ID.

---

### `GET /users/by-username/:username`
**Called by:** auth-service on login to retrieve the stored hash for bcrypt comparison.

**Must be registered before `GET /users/:id`** in Express's routing table. Express matches routes in registration order. If the `:id` route were first, then `/users/by-username/alice` would match `:id` with the value `"by-username"` and `parseInt("by-username")` would be `NaN`.

**Response (200):** The full user row including `password_hash`, `session_string`, etc.

**Response (404):** `{ "error": "User not found" }`

**SQL:**
```sql
SELECT * FROM users WHERE username = $1
```

`SELECT *` is intentional here — auth-service needs the full row for credential comparison.

---

### `GET /users/:id`
**Called by:** telegram-read-service and telegram-download-service to get `api_id`, `api_hash`, `phone`, and `session_string` for creating a Telegram client.

**Response (400):** `{ "error": "Invalid id" }` — when `parseInt(req.params.id)` is falsy (NaN or 0). Note: SERIAL starts at 1, so 0 is never a valid real row.

**SQL:**
```sql
SELECT * FROM users WHERE id = $1
```

---

### `PATCH /users/:id/setup`
**Called by:** auth-service after the user submits their Telegram credentials.

**Request body:**
```json
{ "api_id": 12345678, "api_hash": "abcdef1234567890", "phone": "+14155552671" }
```

**Response (200):** `{ "message": "Setup saved" }`

**SQL:**
```sql
UPDATE users SET api_id=$1, api_hash=$2, phone=$3 WHERE id=$4
```

---

### `PATCH /users/:id/session`
**Called by:** auth-service after GramJS completes the Telegram OTP or 2FA login and returns a session string.

**Request body:**
```json
{ "session_string": "1BVtsOKABu0TmI..." }
```

**Response (200):** `{ "message": "Session saved" }`

**SQL:**
```sql
UPDATE users SET session_string=$1 WHERE id=$2
```

---

### `POST /downloads`
**Called by:** telegram-download-service after every successful file download.

**Request body:**
```json
{
  "userId": 42,
  "groupId": "-1001234567890",
  "messageId": "9876",
  "fileName": "video.mp4",
  "fileSize": 83886080
}
```

`fileName` and `fileSize` are optional — they default to `null` via the `?? null` nullish-coalescing operator.

**Response (201):** `{ "ok": true }`

**SQL (upsert pattern):**
```sql
INSERT INTO downloads (user_id, group_id, message_id, file_name, file_size, ts)
VALUES ($1, $2, $3, $4, $5, extract(epoch from now()))
ON CONFLICT (user_id, group_id, message_id)
DO UPDATE SET file_name=$4, file_size=$5, ts=extract(epoch from now())
```

The `ON CONFLICT ... DO UPDATE` (upsert) ensures that re-downloading the same file refreshes the timestamp and metadata rather than creating a duplicate row.

---

### `GET /downloads/counts/:userId`
**Called by:** api-gateway (at `/download/counts-db`), indirectly by the UI for per-group badge numbers.

**Response (200):**
```json
{ "-1001234567890": 14, "-1009876543210": 3 }
```

An empty object `{}` if the user has no downloads.

**SQL:**
```sql
SELECT group_id, COUNT(*)::int AS count
FROM downloads
WHERE user_id=$1
GROUP BY group_id
```

The `::int` cast converts PostgreSQL's `bigint` COUNT result to a 32-bit integer. Without it, the value arrives in Node.js as a string, which causes JSON serialisation issues.

---

### `GET /downloads/:groupId?userId=<userId>`
**Called by:** telegram-download-service and the UI to check which messages are already downloaded.

**Query param:** `userId` (required).

**Response (200):**
```json
[
  { "message_id": "9876", "file_name": "video.mp4", "file_size": 83886080, "ts": 1718000000 },
  { "message_id": "9877", "file_name": "photo.jpg", "file_size": 204800, "ts": 1718000100 }
]
```

**SQL:**
```sql
SELECT message_id, file_name, file_size, ts
FROM downloads
WHERE user_id=$1 AND group_id=$2
```

---

## 6. Migration Strategy

The migration strategy is **inline DDL on startup** using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.

On every container start, `initDb()` runs three DDL statements. PostgreSQL executes them idempotently — if the table already exists, the statement succeeds silently with no changes.

**What this means in practice:**

- **First deployment:** Tables and indexes are created. Service becomes healthy. Normal.
- **Subsequent deployments (no schema change):** All three DDL statements are no-ops. No performance impact.
- **Additive schema changes (new column):** Add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to `initDb()` — still idempotent.
- **Destructive schema changes (rename column, change type):** Cannot be handled with this pattern without a more careful migration step. There is no migration history, rollback, or version tracking.

**Why no migration framework (Flyway, Knex migrations, db-migrate)?** The project has two tables. A migration framework adds complexity and a separate run step. For this scale, inline DDL is pragmatic. The trade-off is that schema evolution becomes harder as the schema grows.

**Startup ordering guarantee:** `initDb()` resolves before `app.listen()` is called. The Docker Compose `depends_on: postgres: condition: service_healthy` ensures PostgreSQL has passed its own health check (`pg_isready`) before db-service starts. By the time any calling service receives a healthy response from db-service's `/health` endpoint, the schema is guaranteed to exist.

---

## 7. Local Build and Run

### Docker Compose Wiring

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
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
    interval: 10s
    timeout: 5s
    retries: 5

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

**Startup sequence:**

1. Docker Compose starts `postgres` first.
2. Every 10 seconds, Docker runs `pg_isready -U ${POSTGRES_USER}` inside the postgres container. Once it succeeds, postgres is marked healthy.
3. `db-service` starts (because `depends_on: postgres: condition: service_healthy`).
4. `server.js` checks for `DATABASE_URL` — present in environment, continues.
5. Creates a `pg.Pool` (no connections yet — lazy).
6. Calls `initDb()`, which opens a connection and runs 3 DDL queries.
7. `app.listen(3006)` opens the HTTP port.
8. Docker runs `wget -qO- http://localhost:3006/health` every 10 seconds. Once it returns 200, db-service is marked healthy.
9. auth-service, telegram-read-service, and telegram-download-service all `depends_on: db-service: condition: service_healthy` — they start only after step 8.

**Important: `DATABASE_URL` hostname must be `postgres`, not `localhost`**

```
DATABASE_URL=postgresql://minigram:password@postgres:5432/minigram
```

Within the Docker network, `postgres` resolves to the postgres container's IP via Docker's internal DNS. `localhost` inside the db-service container refers to the db-service container itself, not the postgres container. Using `localhost` causes `ECONNREFUSED 127.0.0.1:5432`.

**The named volume `pg-data`** maps to `/var/lib/postgresql/data` inside the postgres container — PostgreSQL's data directory. Data persists across `docker-compose down` but is destroyed by `docker-compose down -v`.

**The postgres container's port 5432 is NOT published to the host.** There is no `ports:` stanza under the `postgres` service. It is only accessible from within `app-network`.

**Running locally without Docker:**

```bash
cd services/db-service
npm install
DATABASE_URL=postgresql://admin:secret@localhost:5432/minigram npm run dev
```

This requires a local PostgreSQL instance at `localhost:5432`.

---

## 8. Gotchas

### 1. Route ordering for `/users/by-username/:username` vs `/users/:id`

`GET /users/by-username/:username` must be registered before `GET /users/:id`. If the `:id` route comes first, a request to `/users/by-username/alice` would match `:id` with the value `"by-username"` and `parseInt("by-username")` would return `NaN`, causing a 400 error. The current ordering is correct; any developer adding new user sub-routes must place them before line 76.

### 2. The health check does not verify the database connection

`GET /health` returns `{ "status": "ok" }` regardless of whether the pool can reach PostgreSQL. If PostgreSQL goes down after startup, the health check will still report healthy, downstream services will still route requests to db-service, and those requests will fail with 500 errors. A more robust health check would run `pool.query('SELECT 1')` and return 503 if it fails.

### 3. No authentication on the HTTP API

Any service (or any person, if port 3006 is accidentally exposed publicly) can call any endpoint. There is no API key, JWT verification, or IP allowlist on db-service itself. Security relies entirely on network-level isolation. In Docker Compose, only `app-network` members can reach port 3006. On EKS, the service should be a `ClusterIP` (the default) — if the Kubernetes service type is misconfigured to `LoadBalancer`, the entire database API would be publicly exposed.

### 4. `SELECT *` returns sensitive fields to all callers

`GET /users/by-username/:username` and `GET /users/:id` both return all columns, including `password_hash`, `api_hash`, and `session_string`. Any service that logs the full response body for debugging would expose these sensitive values in logs. Consider returning explicit column projections for endpoints whose callers do not need the full row.

### 5. No connection pool exhaustion handling

The `pg.Pool` default size is 10 connections. Under high concurrency (many simultaneous HTTP requests all awaiting a pool connection), excess requests queue inside the pool. There is no `connectionTimeoutMillis` configured — a request could theoretically wait indefinitely if the pool is saturated. For production scale, set `connectionTimeoutMillis` on the Pool constructor.

### 6. Inline migrations cannot handle destructive changes safely

If a future change needs to rename `password_hash` to `hashed_password` or change `group_id` from TEXT to BIGINT, the `IF NOT EXISTS` DDL approach does not handle this. Any destructive migration requires extending the pattern with a schema version table or replacing it with a proper migration tool.

### 7. The `start_period` on the healthcheck

`start_period: 10s` means Docker does not count failed health checks against the retry budget during the first 10 seconds of startup. This window accommodates the time `initDb()` takes to run DDL against a cold PostgreSQL instance. If `initDb()` takes longer than ~10 seconds, health checks begin counting retries. After 5 failures (50 seconds later), the container is marked unhealthy.
