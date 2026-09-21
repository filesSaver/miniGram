# miniGram — Telegram Read Service Deep Dive

**Location:** `/services/telegram-read-service/`
**Port:** 3002
**Docker image:** `sauravmehta/content-scrapper-telegram-read-service:latest`

---

## 1. Purpose

The telegram-read-service is the read-only Telegram data access layer of the miniGram application. Its sole job is to authenticate as a real Telegram user (using that user's own API credentials and stored session), connect to Telegram's MTProto API, and expose all of that user's Telegram data through a clean HTTP REST/SSE API.

It answers questions like:
- What groups and channels am I a member of?
- What is the metadata for this group (member count, description, photo)?
- What topics/threads does this forum group have?
- What messages and media has been posted in this group or topic?
- How many videos, audios, images, PDFs, and text messages are in here?

It does **not** download actual binary file bytes (that is telegram-download-service). It does **not** handle authentication (that is auth-service). It is a pure reader.

**Why it exists as a separate microservice:**

- It establishes MTProto connections and iterates potentially tens of thousands of messages — isolating this protects other services from the latency and failure modes of long-running Telegram operations.
- Some operations (full message scans) can take minutes. Decoupling them means the rest of the API stack stays responsive.
- Each user has their own Telegram session with their own API credentials. This service is the single place that manages the lifecycle of those per-user connections.

---

## 2. Tech Stack

### express 5.2.1
The HTTP server framework. Version 5 makes async route handlers automatically propagate unhandled promise rejections to the error handler. All routes in this service wrap logic in explicit `try/catch`, so the v5 behaviour is available but not relied upon.

### jsonwebtoken 9.0.2
Used for verification only — not issuance. Every incoming request must carry a `Bearer` token. `jwt.verify()` checks the signature against `JWT_SECRET` and decodes the payload in one step. The `sub` claim becomes `req.userId`, which is then used to look up Telegram credentials from db-service.

### telegram 2.26.22 (GramJS)
The full Telegram MTProto client library for Node.js. GramJS implements Telegram's binary protocol — the same protocol used by official Telegram apps. It can access private groups, read message history, and perform every action a real Telegram user can perform.

Key GramJS capabilities used:
- `TelegramClient` — the main client class. Takes a session, an api_id, and an api_hash. `client.connect()` performs the MTProto handshake.
- `StringSession` — serialises and deserialises an authenticated session as a plain string stored in the database.
- `Api` — the full Telegram TL (Type Language) schema. Every object type (`Api.Channel`, `Api.Chat`, `Api.Message`) and every RPC method (`Api.channels.GetForumTopics`, `Api.messages.GetHistory`) lives here.
- `client.getDialogs()` — fetches the complete list of conversations the user participates in.
- `client.iterMessages()` — an async generator that paginates through all messages in a conversation, handling Telegram's 100-messages-per-page limit internally.
- `client.downloadProfilePhoto()` — downloads a group or user photo as a Node.js Buffer.
- `client.invoke()` — the low-level escape hatch for raw RPC calls.

**Why GramJS over the Bot API?** The Bot API (Telegram's official REST API) is intentionally limited: bots cannot list full message history, cannot access private groups unless they are members, and cannot act as a real user. GramJS uses a real user account session, which is required for everything miniGram does.

### nodemon 3.1.14 (devDependency only)
File-watcher for local development (`npm run dev`). Not in the production image.

### Node.js built-in `fetch`
Used to call db-service over the internal Docker/Kubernetes network. Available natively in Node.js 18+.

---

## 3. File by File

### `.dockerignore`

```
node_modules
npm-debug.log*
.env
.env.*
!.env.example
```

Prevents `node_modules` and secrets from entering the Docker build context. The `!.env.example` exception allows a non-secret template file through if it exists.

### `Dockerfile`

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev
COPY . .

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
EXPOSE 3002
USER node
CMD ["node", "server.js"]
```

The `apk add python3 make g++` in the builder stage is required because GramJS has cryptographic native add-ons (`@cryptography/aes`, `bigint-buffer`) that must be compiled from C++ source on Alpine Linux. Alpine uses `musl libc` rather than `glibc`, which means pre-built binaries do not work. The build tools are present only in the builder stage — the runtime stage copies only the compiled binaries. `USER node` drops privileges before starting the process.

### `package.json`

`"type": "commonjs"` — all files use `require()`/`module.exports`. `"main": "server.js"`. Three production dependencies: `express`, `jsonwebtoken`, `telegram`.

### `server.js` — The Entire Service

**Imports (lines 1–4):**
```js
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const jwt = require('jsonwebtoken');
```

`StringSession` is imported from a subpath rather than the top-level export for reliability across GramJS versions.

**Bootstrap (lines 6–13):**
```js
const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://db-service:3006';

if (!JWT_SECRET) {
  console.error('[telegram-read-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}
app.use(express.json());
```

`process.exit(1)` is a fail-fast guard — if `JWT_SECRET` is missing, no request can ever be authenticated, so there is no point running. The `DB_SERVICE_URL` default uses Docker's internal DNS name for the db-service container.

**`getUserConfig(userId)` helper:**
```js
async function getUserConfig(userId) {
  const res = await fetch(`${DB_SERVICE_URL}/users/${userId}`);
  if (!res.ok) throw Object.assign(new Error(`db-service fetch failed: ${res.status}`), { code: 503 });
  return res.json();
}
```

Calls db-service to fetch the user row containing `api_id`, `api_hash`, and `session_string`. The error is augmented with `code: 503` so the catch block can set the correct HTTP status.

**`getClientForUser(userId)` — the most important function:**
```js
async function getClientForUser(userId) {
  const config = await getUserConfig(userId);
  if (!config.api_id || !config.api_hash || !config.session_string) {
    throw Object.assign(new Error('Telegram not configured or not logged in'), { code: 428 });
  }
  const client = new TelegramClient(
    new StringSession(config.session_string),
    parseInt(config.api_id),
    config.api_hash,
    { connectionRetries: 2, useWSS: true }
  );
  await client.connect();
  return client;
}
```

1. Fetches user credentials from db-service.
2. Validates all three Telegram fields exist. Returns 428 (Precondition Required) if not — signalling to the frontend that the user must complete Telegram setup.
3. Creates a `TelegramClient` with the stored session string. `useWSS: true` forces WebSocket Secure connections, which work reliably in Docker environments where raw TCP on Telegram's ports may be firewalled. `connectionRetries: 2` makes the service fail fast rather than hang.
4. `client.connect()` performs the full MTProto handshake and resumes the authenticated session.
5. Returns the ready client.

A new `TelegramClient` is created for every request. There is no singleton or pool in the read service. This is a deliberate simplicity trade-off — each request is stateless from the service's perspective. The downside is that every request pays the MTProto handshake cost (~100–300ms). The message cache compensates for the heavier scan operations.

**`requireAuth` and `requireAuthSSE` middleware:**

`requireAuth` is standard Bearer token middleware: reads the `Authorization` header, verifies the JWT, sets `req.userId = payload.sub`.

`requireAuthSSE` is a variant for Server-Sent Events and `<img src>` endpoints. The browser's `EventSource` API and `<img>` tags cannot send custom headers. The solution is to also accept the token as a query parameter (`?token=...`). `requireAuthSSE` checks the `Authorization` header first (normal API clients), then falls back to `req.query.token`.

**`buildGroupInfo(entity)` — data mapper:**
Converts a raw GramJS `Api.Channel` or `Api.Chat` object into a clean JSON shape. Key decisions:
- `id` is stringified because Telegram IDs are BigInts and JavaScript cannot safely represent all 64-bit integers as numbers.
- `type` distinguishes channels from groups: both are `Api.Channel` in Telegram's schema, but `megagroup === false` means a broadcast channel while `megagroup === true` means a supergroup.
- `about` is always `null` in the list endpoint — the full description requires a separate `GetFullChannel` RPC, done only in the detail endpoint.

**`categorize(msg)`, `getFileName(msg)`, `mapMessage(msg)` — content type helpers:**

`categorize()` inspects `msg.media` and returns one of: `'image'`, `'video'`, `'audio'`, `'pdf'`, `'chat'`, `'other'`.
- No media → `'chat'` (plain text message).
- `MessageMediaPhoto` → `'image'`.
- `MessageMediaDocument` → determined by the document's `mimeType` field.

`getFileName()` walks the document's `attributes` array looking for `DocumentAttributeFilename`. Telegram attaches a heterogeneous array of attribute objects to documents (filename, video dimensions, duration, sticker info, etc.).

`mapMessage()` assembles the final message shape: `id` (stringified), `type`, `text`, `date` (ISO string), `fileName`, `fileSize` (cast to `Number()` because GramJS returns file sizes as BigInt), and `mimeType`.

**In-memory cache and deduplication:**
```js
const messageCache = new Map();   // groupId → { items, ts }
const scanInProgress = new Map(); // groupId → Promise
```

`messageCache` stores the result of a full message scan keyed by group ID (or `groupId:topicId` for topic-level scans). Once loaded, subsequent requests for the same group return instantly from cache without hitting Telegram.

`scanInProgress` is a deduplication map. If two simultaneous requests arrive for the same group's content scan, without this map both would start independent `iterMessages` loops. The second request instead gets the same Promise the first is already awaiting. When the scan completes, both resolve together.

`getOrScanMessages(groupId, entity, client)`:
1. If cache has the result, return it immediately.
2. If a scan is in progress, return that existing Promise (deduplication).
3. Otherwise, create a new async function that iterates all messages, populates items, stores in cache, removes itself from `scanInProgress`, and resolves. Store this Promise and return it.

`limit: undefined` passed to `iterMessages` means "no limit" — fetch all pages until exhausted.

The guard `if (msg.message === undefined) continue` skips service messages (join/leave notifications, pinned message events) which have `message === undefined` rather than an empty string.

---

## 4. Telegram Connection: MTProto, Session Strings, Client Lifecycle

### MTProto Protocol

Telegram does not use HTTP or REST. It uses MTProto — a custom binary protocol with its own TLS-like encryption. MTProto 2.0 uses 256-bit AES-IGE for message encryption plus a Diffie-Hellman key exchange for session establishment. GramJS implements this entirely in JavaScript, with `@cryptography/aes` handling the cryptographic primitives.

When `client.connect()` is called, GramJS:
1. Opens a WebSocket to a Telegram Data Centre.
2. Performs the `req_pq_multi` / `res_pq` / `set_client_DH_params` handshake.
3. Sends `auth.importAuthorization` to resume the existing session via the `StringSession`.

### Session Strings

A Telegram session string contains the data centre ID, the symmetric AES auth key negotiated during login, the user's account ID, and other metadata. GramJS's `StringSession` serialises all of this to Base64. After the user first logs in via auth-service (which handles the OTP flow), this string is stored in the database. All subsequent connections by any service use `new StringSession(storedString)` — no new login or OTP required.

### No Client Pool in the Read Service

Every request creates a fresh `TelegramClient` and disconnects in the `finally` block. There is no singleton or connection pool. The `.disconnect()` calls are always in `finally` blocks with `.catch(() => {})` to silently ignore disconnect errors.

**Pro:** Completely stateless per request, no resource leaks if a request crashes.
**Con:** Every request pays the MTProto handshake cost (~100–300ms). For heavy operations like scanning 10,000 messages, this cost is negligible. For light operations like fetching a group list, it adds real overhead.

---

## 5. API Endpoints

### `GET /health`
No auth. Returns `{ status: 'ok', service: 'telegram-read-service' }`.

---

### `GET /groups?limit=N&offset=N`
Auth: Bearer JWT.
**Telegram calls:** `client.getDialogs({})` — fetches the complete dialog list.
**Logic:** Filters to only `Api.Chat` and `Api.Channel` instances (excludes direct messages, saved messages, bots). Maps each to `buildGroupInfo`. Separates into groups vs channels for counts. Paginates with `limit`/`offset` (in-memory slice, not server-side pagination).
**Response:**
```json
{
  "groups": [...],
  "total": 47,
  "groupCount": 30,
  "channelCount": 17,
  "offset": 0,
  "limit": 10
}
```

---

### `GET /groups/:id`
Auth: Bearer JWT.
**Telegram calls:** `client.getDialogs()` to locate the entity, then `Api.channels.GetFullChannel` or `Api.messages.GetFullChat` for the `about` description.
**Logic:** Finds the matching dialog by comparing stringified entity IDs. The full-channel call is in a separate `try/catch` — if it fails (e.g. the user lacks admin rights), `about` stays `null` and the rest of the response still returns.

---

### `GET /groups/:id/photo`
Auth: `requireAuthSSE` (accepts `?token=` query param for direct `<img src>` usage).
**Telegram calls:** `client.downloadProfilePhoto(entity)`.
**Response:** Raw `image/jpeg` bytes with `Cache-Control: public, max-age=86400` (24-hour cache). Returns 404 if the group has no photo.

---

### `GET /groups/:id/stats`
Auth: Bearer JWT.
**Telegram calls:** `Api.messages.GetHistory` with `limit: 1`.
**Logic:** Fetching one message from `GetHistory` returns a `.count` field with the total message count for the chat — the cheapest way to get this number without a full scan.
**Response:** `{ "total": 12847 }`

---

### `GET /groups/:id/breakdown`
Auth: Bearer JWT.
**Telegram calls:** Full `iterMessages` scan (via `getOrScanMessages`, cached).
**Response:** `{ "video": 234, "audio": 12, "image": 4521, "pdf": 88, "chat": 7992, "other": 3 }`

---

### `GET /groups/:id/breakdown/stream` (SSE)
Auth: `requireAuthSSE`.
**Telegram calls:** `Api.messages.GetHistory` (limit 1, for total count), then full `iterMessages` scan.
**Logic:**
1. Sets SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
2. The `X-Accel-Buffering: no` header tells nginx not to buffer the response — essential for SSE through a reverse proxy.
3. Calls `res.flushHeaders()` immediately to send HTTP 200 and headers before scanning begins, establishing the stream in the browser.
4. Pre-fetches the total message count for the progress bar.
5. Iterates all messages. Every 100 processed, emits a progress event:
   ```
   data: {"processed":100,"total":12847,"counts":{"video":5,...},"done":false}
   ```
6. On completion, emits a final event with `done: true`.
7. Calls `res.end()`.

If cached data exists, skips the scan entirely and sends one final event instantly.

---

### `GET /groups/:id/content?type=all&limit=10&offset=0`
Auth: Bearer JWT.
**Telegram calls:** Full `iterMessages` scan (via cache).
**Logic:** After scanning, filters by `type` if provided (`video`, `audio`, `image`, `pdf`, `chat`, `other`, or `all`). Paginates the filtered list with limit/offset.
**Response:** `{ "items": [...], "total": 4521, "offset": 0, "limit": 10 }`

---

### `GET /groups/:id/content/range?from=1000&to=1050`
Auth: Bearer JWT.
**Telegram calls:** `iterMessages` with `minId: fromId-1, maxId: toId+1`.
**Logic:** Fetches a specific Telegram message ID range directly, without a full scan. Telegram message IDs are monotonically increasing integers within a chat.

---

### `GET /groups/:id/topics`
Auth: Bearer JWT.
**Telegram calls:** `client.getDialogs()`, then `Api.channels.GetForumTopics`.
**Logic:** Checks `dialog.entity.forum` — only forum-enabled supergroups have topics. If `forum === false`, returns an empty array immediately without calling `GetForumTopics`.
**Response:**
```json
{
  "topics": [
    {
      "id": 1,
      "title": "General",
      "topMessage": 42,
      "unreadCount": 0,
      "closed": false,
      "pinned": true,
      "iconEmoji": "5395444773011016863"
    }
  ]
}
```

`iconEmoji` is a custom emoji BigInt ID — stringified to avoid precision loss.

---

### `GET /groups/:id/topics/:topicId/breakdown/stream` (SSE)
Auth: `requireAuthSSE`.
**Telegram calls:** `iterMessages` with `replyTo: topicId`.
**Logic:** Same SSE pattern as the group-level stream, but scoped to a specific topic. In Telegram's forum model, all messages in a topic are stored as replies to the topic's root message. Passing `replyTo: topicId` to `iterMessages` filters to only those messages. Cache key is `groupId:topicId`.

---

### `GET /groups/:id/topics/:topicId/content?type=all`
Auth: Bearer JWT. Topic-scoped content items, using `replyTo: topicId` filtering.

### `GET /groups/:id/topics/:topicId/content/range?from=N&to=N`
Auth: Bearer JWT. Message ID range fetch scoped to a forum topic.

---

## 6. SSE Streaming: The Breakdown Stream in Detail

The SSE streaming endpoints are the most complex part of the service. Full flow for `GET /groups/:id/breakdown/stream`:

**Step 1: Headers and flush**
The service sets four SSE-required headers and calls `res.flushHeaders()`. This sends the HTTP 200 response line and headers to the client before any data. Without it, the browser would see a connection timeout while waiting for the first `data:` event.

**Step 2: Pre-fetch total count**
`Api.messages.GetHistory` with `limit: 1` returns the `.count` field — the approximate total message count — at essentially zero cost. Sent with every progress event so the frontend can show a percentage progress bar.

**Step 3: Async iteration with progress events**
```js
for await (const msg of c.iterMessages(entity, { limit: undefined })) {
  categorize(msg) and tally...
  processed++;
  if (processed % 100 === 0) {
    send({ processed, total, counts, done: false });
  }
}
```
The `for await...of` loop processes one message at a time. Every 100 messages, a progress SSE event is written.

**SSE event format:**
```
data: {"processed":200,"total":12847,"counts":{"video":10,...},"done":false}\n\n
```
The two trailing newlines terminate the SSE event. The browser's `EventSource` API fires a `message` event for each.

**Step 4: Cache and final event**
After exhausting messages, results are stored in `messageCache` and a final event with `done: true` is sent. `res.end()` closes the HTTP response.

**Cache hit path:** If the cache has data, counts are computed in a single in-memory pass and one event with `done: true` is sent immediately. This path completes in milliseconds.

**The `X-Accel-Buffering: no` header** tells nginx to disable response buffering for this specific response, even if `proxy_buffering on` is set globally. Without it, nginx would accumulate SSE events in a buffer and only forward them when the buffer fills — breaking incremental delivery.

---

## 7. Local Build and Run

From `docker-compose.yml`:
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

`depends_on: auth-service: condition: service_healthy` means docker-compose will not start this service until auth-service passes its healthcheck. auth-service itself depends on `db-service: service_healthy`. The startup order enforced is: postgres → db-service → auth-service → telegram-read-service.

Note: telegram-read-service itself has no `healthcheck` defined. The api-gateway depends on it with `condition: service_started` (not `service_healthy`), so it only waits for the container process to start.

**Running locally for development:**
```bash
cd services/telegram-read-service
npm install
JWT_SECRET=dev-secret DB_SERVICE_URL=http://localhost:3006 npm run dev
```

---

## 8. Gotchas

### Telegram FloodWait Errors

When Telegram's rate limits are exceeded, the server returns `FLOOD_WAIT_X` where X is the wait time in seconds. GramJS throws this as an error with a message like `FLOOD_WAIT_420`. The current code does not catch `FLOOD_WAIT` specifically — it falls through to the generic 500 handler. A production service should catch this and return a `429 Too Many Requests` with a `Retry-After` header.

The most common trigger is `iterMessages` on a large channel — hundreds of sequential `getHistory` calls in a short time.

### Session Invalidation

Session strings become invalid if the user revokes the session from their Telegram app, changes their Telegram password, or if the account is banned. `client.connect()` will throw `SESSION_REVOKED` or `AUTH_KEY_UNREGISTERED`. The current code surfaces these as 500 errors. The correct fix is to catch these, clear `session_string` in the database, and return 401 instructing the user to re-authenticate.

### No Client Pool — Performance Implications

Creating a new Telegram connection per request means the ~200ms MTProto handshake cost is paid on every request. For the SSE scan endpoints this is acceptable. For quick endpoints like the group list, it adds real overhead. A per-user connection pool keyed by `userId` with idle-timeout cleanup would substantially improve throughput.

### In-Memory Cache Has No Expiry

`messageCache` never evicts entries. In a long-running process, every scanned group accumulates in memory indefinitely. A TTL-based eviction (entries older than N minutes are re-fetched on next access) should be added for production use.

### Cache Is Not Per-User

The cache key is `groupId` (or `groupId:topicId`). If two different users share access to the same Telegram group, the first user's scan result is served to the second user. This is an architectural flaw — the cache should be keyed by `userId:groupId`.

### `getDialogs` Re-Fetched on Every Request

Every endpoint calls `client.getDialogs({})` to find the entity object for the requested group ID. This is an extra RPC call on every single request. The entity could be cached alongside the messages to avoid this round-trip.

### `useWSS: true` Behaviour

WebSocket Secure connections work in Docker environments where outbound TCP on port 443 is open. Some corporate or cloud network environments intercept TLS. If the service cannot connect, check firewall rules and TLS inspection settings. The raw MTProto TCP transport would be faster but is less universally supported.

### Forum Topic `replyTo` Filtering

When calling `iterMessages` with `replyTo: topicId`, GramJS passes this as the `replyTo` filter in `messages.getHistory`. The General topic typically has ID 1; subsequent topics have higher IDs. Passing the wrong `topicId` returns an empty result silently.

### Message Count Discrepancy

The `GetHistory` limit-1 prefetch reads the total count at a point in time. As the `iterMessages` scan runs (which can take minutes for large groups), new messages may arrive or old ones be deleted. The `processed` count in the final SSE event is authoritative; the `total` prefetch is only for the progress display.

### The `msg.message === undefined` Guard

Service messages (system notifications like "Alice joined the group") have `message === undefined`, not `message === null` or `message === ''`. The guard `if (msg.message === undefined) continue` is specifically checking for this. If it were `if (!msg.message)` it would also skip valid media-only messages whose text is an empty string.
