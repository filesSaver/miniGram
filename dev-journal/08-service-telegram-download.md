# miniGram — Telegram Download Service Deep Dive

**Location:** `/services/telegram-download-service/`
**Port:** 3003
**Docker image:** `sauravmehta/content-scrapper-telegram-download-service:latest`

---

## 1. Purpose

The telegram-download-service is a dedicated Node.js HTTP server whose sole responsibility is to stream binary media files out of Telegram and directly into a user's browser over a standard HTTP response.

It handles one route: `GET /download/file`.

### Why a Separate Microservice?

The read service's job is metadata — small JSON payloads with short request lifetimes (typically under a second). Downloading a file is the exact opposite: a single request can run for minutes and move hundreds of megabytes of binary data. Mixing these two patterns in one process creates serious problems:

**Event loop starvation.** Large streaming downloads at high throughput leave very little space for the read service to answer its own incoming requests. Keeping them separate means each process's event loop does one kind of work.

**Concurrency isolation.** The download service has a per-user queue (capped at 3 concurrent downloads). If this logic lived in the read service, queuing would interact with read requests in unpredictable ways.

**Connection pool isolation.** Each service maintains its own `Map` of live Telegram `TelegramClient` objects keyed by `userId`. A crashed download connection cannot disrupt the read service's live clients.

**Timeout profiles.** The download service sets `socket.setTimeout(0)` — sockets never time out. The read service can keep its default timeouts. They cannot share the same HTTP server configuration.

---

## 2. Tech Stack

### express 5.2.1
The HTTP framework. Two routes: `/health` and `/download/file`. Express 5 properly supports async route handlers without manual `next(err)` forwarding.

### telegram 2.26.22 (GramJS)
The Telegram MTProto client library. Key capabilities:
- `TelegramClient` — full Telegram client. Connects as a real user using API credentials and a session string.
- `StringSession` — deserialises a stored MTProto session from a base64 string. Used to resume login without re-authentication.
- `iterDownload` — an async generator that yields binary chunks from a Telegram media object, 512KB at a time.
- `Api.PeerChannel` / `Api.PeerChat` — MTProto type wrappers for addressing Telegram groups.

**Why GramJS over the Bot API?** The Bot API limits file downloads to 20MB for bots. GramJS operates as a full user client with no such restriction and can access private group media.

### jsonwebtoken 9.0.2
Used for verification only. `jwt.verify()` checks signature and expiry. The `sub` (subject) field from the JWT payload is used as `userId` throughout the request lifecycle.

### Node.js built-in `fetch`
Used to call db-service: once to read user credentials, once to log completed downloads.

### nodemon 3.1.14 (devDependency only)
For local development only. Not in the production Docker image.

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

Prevents `node_modules` (platform-specific native binaries) and secret files from entering the Docker build context.

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
RUN mkdir -p /app/downloads && chown -R node:node /app
EXPOSE 3003
USER node
CMD ["node", "server.js"]
```

`python3 make g++` are required because GramJS depends on `bigint-buffer`, a native C++ add-on. Alpine Linux uses `musl libc`, so pre-built binaries do not work — the package must be compiled from source using `node-gyp` (which needs Python, make, and a C++ compiler). The build tools exist only in the builder stage; only compiled binaries are copied to the final image. The `/app/downloads` directory is created for potential future disk-based caching (current code is fully in-memory). `USER node` drops privileges before starting.

### `package.json`

`"type": "commonjs"`. `"main": "server.js"`. Three production dependencies: `express`, `jsonwebtoken`, `telegram`.

### `server.js` — The Entire Service

**Imports (lines 1–5):**
```js
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { iterDownload } = require('telegram/client/downloads');
const jwt = require('jsonwebtoken');
```

`iterDownload` is imported from a specific subpath (`telegram/client/downloads`) because it is not re-exported from the top-level `telegram` module in all GramJS versions. Direct subpath import is safer.

**Startup and environment validation (lines 7–17):**
```js
const app = express();
const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://db-service:3006';

if (!JWT_SECRET) {
  console.error('[telegram-download-service] FATAL: JWT_SECRET is not set');
  process.exit(1);
}
app.use(express.json());
```

`process.exit(1)` fires at startup — not lazily on the first request — if `JWT_SECRET` is absent. This fail-fast pattern surfaces deployment misconfiguration immediately rather than silently accepting requests that will all fail with JWT library errors.

**`getUserConfig(userId)` helper:**
```js
async function getUserConfig(userId) {
  const res = await fetch(`${DB_SERVICE_URL}/users/${userId}`);
  if (!res.ok) throw Object.assign(new Error(`db-service fetch failed: ${res.status}`), { code: 503 });
  return res.json();
}
```

The only place the service reads from the database. Fetches `api_id`, `api_hash`, and `session_string` needed to create a Telegram client. The `code: 503` property allows the catch block to forward it as an HTTP 503 status.

---

## 4. Download Flow: How Bytes Travel from Telegram to the Browser

```
Telegram's servers
      │  MTProto encrypted binary (WebSocket)
      ▼
GramJS TelegramClient (in-process)
      │  iterDownload() yields Buffer chunks (~512KB each)
      ▼
download handler  →  res.write(chunk) with backpressure drain
      │  HTTP streaming response
      ▼
api-gateway  (proxyTimeout:0, no buffering)
      │
      ▼
nginx (proxy_buffering off, proxy_read_timeout 3600s)
      │
      ▼
Browser (receives the file in download manager)
```

### `iterDownload` in Detail

`iterDownload` is an async generator. Unlike downloading the whole file into memory first, it asks Telegram's servers for one chunk at a time and yields each as a Node.js `Buffer`. The handler processes one chunk per iteration:

```js
for await (const chunk of iterDownload(client, { file: msg.media })) {
  if (aborted) break;
  // ... skip logic for resume ...
  const ok = res.write(data);
  if (!ok) await new Promise(resolve => res.once('drain', resolve));
}
```

`res.write(data)` returns `true` if the socket buffer still has room, and `false` if the buffer is full (the browser is reading slower than Telegram is delivering). When it returns `false`, continuing to call `res.write()` would fill Node.js's in-memory buffer without bound — potentially exhausting RAM. The `drain` event pattern pauses the generator until the browser has consumed enough data to empty the socket buffer. This is **backpressure** — the receiver signals the sender to slow down.

Each chunk from `iterDownload` is approximately 512KB (`CHUNK_SIZE = 512 * 1024`). Telegram enforces that file parts must be multiples of 4KB and at most 512KB. GramJS handles this internally.

Because the generator yields one 512KB chunk at a time and pauses on `drain`, memory usage for a single download is bounded at roughly 1–2 chunks (~512KB–1MB) regardless of file size. A 4GB file uses the same peak memory as a 4KB file.

---

## 5. Range/Resume Support

When a file download is interrupted midway, HTTP/1.1 allows the browser to request only the missing portion by sending a `Range: bytes=N-` header, where N is the number of bytes already received.

### Parsing the Range Header

```js
const rangeHeader = req.headers['range'];
let startByte = 0;
if (rangeHeader && fileSize > 0) {
  const match = rangeHeader.match(/bytes=(\d+)-/);
  if (match) startByte = parseInt(match[1], 10);
}
```

The regex `/bytes=(\d+)-/` matches the standard `Range: bytes=N-` format. If `fileSize` is unknown (0), Range is ignored because a proper `Content-Range` response requires knowing the total size.

### Sending the Correct Response Status

Three cases:
- `startByte > 0 and fileSize > 0`: Send HTTP `206 Partial Content` with `Content-Range: bytes N-END/TOTAL` and `Content-Length: TOTAL - N`.
- `fileSize > 0, startByte == 0`: Send HTTP `200 OK` with `Content-Length`.
- `fileSize == 0` (photos, or documents where Telegram didn't report a size): Send `Transfer-Encoding: chunked` — the browser accepts data until the connection closes.

### The `X-Accel-Buffering: no` Header

```js
res.setHeader('X-Accel-Buffering', 'no');
```

This header is specifically understood by nginx's proxy subsystem. When set on an upstream response, nginx immediately disables response buffering for that response — even if `proxy_buffering on` is set globally. Without this, nginx would buffer the entire file in memory before forwarding any bytes to the browser. For large files, nginx's buffer limits would be exceeded, truncating or corrupting the response.

### Skipping Already-Downloaded Chunks (Resume)

`iterDownload` always starts from the beginning of the file — there is no GramJS API to start at an arbitrary byte offset. The resume logic manually skips chunks:

```js
const CHUNK_SIZE = 512 * 1024;
const skipChunks = Math.floor(startByte / CHUNK_SIZE);
const skipBytesInChunk = startByte % CHUNK_SIZE;
```

`skipChunks` is how many complete 512KB chunks to discard. `skipBytesInChunk` handles the case where the resume point falls mid-chunk — for example, resuming at 800KB with 512KB chunks means skipping 1 full chunk and trimming the first 288KB of the next.

**Limitation:** The skipped chunks still travel over MTProto from Telegram's servers to the Node.js process before being discarded. For very large files, resuming from deep within the file means downloading and throwing away the preceding content. A proper fix would require passing an offset directly to the MTProto `upload.getFile` call, which GramJS's current `iterDownload` API does not expose.

---

## 6. Client Pool: Per-User Telegram Client Pooling

### The Problem

Creating a new `TelegramClient` and calling `client.connect()` is expensive:
1. TCP/WebSocket connection to a Telegram Data Centre.
2. MTProto Diffie-Hellman handshake.
3. Sending the serialised session to resume the existing auth.

This takes roughly 1–3 seconds under good conditions. Doing this on every download request would be unacceptable.

### The Solution

```js
const clientPool = new Map(); // userId → TelegramClient
```

One `TelegramClient` is kept alive per `userId` and reused across all requests from that user.

**Reconnection handling (three-tier strategy):**
```js
const existing = clientPool.get(userId);
if (existing) {
  try {
    if (!existing.connected) {
      await existing.connect();  // attempt reconnect in place
    }
    return existing;
  } catch (e) {
    clientPool.delete(userId);  // fall through to create new
  }
}
```

1. Return the cached client if it is connected.
2. If the WebSocket dropped (idle timeout, network blip), attempt `existing.connect()` in place.
3. Only if reconnection throws does it create a completely new client and replace the pool entry.

**Client creation:**
```js
const client = new TelegramClient(
  new StringSession(config.session_string),
  Number.parseInt(config.api_id),
  config.api_hash,
  { connectionRetries: 5, useWSS: true }
);
```

`connectionRetries: 5` allows GramJS to automatically retry the connection 5 times before giving up. `useWSS: true` forces WebSocket Secure connections, which work universally across network environments.

**Memory consideration:** The pool grows unboundedly — there is no TTL or LRU eviction policy. For the current single-user scale of miniGram this is fine. A production deployment with many users would need an LRU cache with a maximum size.

---

## 7. Download Queue: Per-User Concurrency Limiting

### Why Limit Concurrent Downloads

Telegram's MTProto protocol enforces per-account rate limits. When a single Telegram account makes too many simultaneous file download requests, Telegram returns `FLOOD_WAIT_N`, terminating all in-flight downloads. The queue prevents this by ensuring no user ever has more than 3 simultaneous downloads.

### The Queue Implementation

```js
const MAX_CONCURRENT = 3;
const userQueues = new Map(); // userId → { active: number, queue: Array<fn> }
```

```js
function enqueueDownload(userId, fn) {
  if (!userQueues.has(userId)) userQueues.set(userId, { active: 0, queue: [] });
  const q = userQueues.get(userId);
  return new Promise((resolve, reject) => {
    const wrapped = async () => {
      q.active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        q.active--;
        if (q.queue.length > 0) q.queue.shift()();
      }
    };
    if (q.active < MAX_CONCURRENT) wrapped();
    else q.queue.push(wrapped);
  });
}
```

Each call wraps the provided function `fn` in a `wrapped` closure that: increments `q.active` before running, resolves or rejects the outer Promise based on result, then decrements `q.active` in `finally`. If the queue has pending functions, the next one is immediately invoked. The outer `return new Promise(...)` means `enqueueDownload` returns a Promise that resolves when `fn` completes, so the route handler can `await` it.

The queue is FIFO (first-in, first-out). Queue depth is unbounded — this is acceptable for the expected usage pattern.

---

## 8. DB Logging: When and How Downloads Are Recorded

```js
if (startByte + totalBytes >= fileSize * 0.99) {
  fetch(`${DB_SERVICE_URL}/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: req.userId, groupId, messageId, fileName, fileSize: fileSize || totalBytes }),
  }).catch(() => {});
}
```

**When it fires:** Only when the download is considered complete — defined as having received at least 99% of the expected file size. The 1% tolerance exists because the final chunk arithmetic may leave a tiny discrepancy between bytes streamed and the declared file size for some document types.

If the user disconnects early (`aborted === true`), `res.end()` is not called and this block is skipped — partial downloads are never logged.

**Why fire-and-forget (`.catch(() => {})`):** The download has already completed from the user's perspective. Failing to write a database log is a metrics concern, not a user-facing error. Throwing at this point would be confusing (the download succeeded) and could leave the response in a bad state.

**What is logged:** `userId`, `groupId`, `messageId`, `fileName`, and `fileSize`. The UI polls `GET /download/counts-db` (routed to db-service) to display per-group download badges, and polls `GET /download/log-db` (also db-service) to show green checkmarks on already-downloaded items.

---

## 9. Local Build and Run

From `docker-compose.yml`:
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

The `depends_on: auth-service: condition: service_healthy` creates a transitive dependency chain: postgres → db-service → auth-service → telegram-download-service.

**Socket timeout disabled on the HTTP server:**
```js
app.listen(PORT, () => {
  console.log(`[telegram-download-service] running on port ${PORT}`);
}).on('connection', socket => {
  socket.setTimeout(0);
});
```

By listening to the `connection` event and calling `socket.setTimeout(0)` for every incoming connection, the service disables TCP-level timeouts entirely. Node.js HTTP servers have a default socket idle timeout. For file downloads that may take 30+ minutes, any default timeout would silently kill the connection midway. Setting to `0` means only explicit errors or client disconnects end the transfer.

**Running locally for development:**
```bash
cd services/telegram-download-service
npm install
JWT_SECRET=dev-secret DB_SERVICE_URL=http://localhost:3006 npm run dev
```

The download endpoint is then reachable at:
```
http://localhost:3003/download/file?groupId=-1001234567890&messageId=9876&token=<JWT>
```

---

## 10. Gotchas

### Binary Streaming: Nothing Must Touch the Response Body

The response carries raw binary bytes. Any middleware that assumes the body is text — a compressor, a response logger that tries to JSON-parse the body — will corrupt the file. The service correctly has no such middleware. The catch block calls `res.destroy()` (not `res.json(...)`) when `res.headersSent` is `true` — writing a JSON error into the middle of a binary stream would produce a corrupted file.

### The `startByte` Resume Limitation

Chunks skipped for resume still travel over MTProto from Telegram's servers to the Node.js process. For a 2GB file being resumed at 1.8GB, this means 1.8GB of data flows over MTProto only to be discarded. For typical resumes (a few seconds after a network dropout, usually within the last few MB), this is acceptable. A proper fix requires exposing an offset parameter in GramJS's internal `upload.getFile` call.

### Telegram MTProto Decryption CPU Cost

Every byte from Telegram is AES-IGE encrypted at the MTProto level. GramJS decrypts each message before yielding the chunk via `iterDownload`. The `@cryptography/aes` package handles the actual AES operations. On a CPU-constrained container, this can become the bottleneck before the network bandwidth is saturated.

### Disconnect Detection Lag

`req.on('close', ...)` fires when the browser disconnects. The `aborted = true` flag is set and the `for await` loop breaks on the next iteration. There is a one-chunk lag — up to 512KB of additional data may be read from Telegram and discarded after the browser disconnects.

### Session String Security

The `session_string` stored in the database is a complete Telegram authentication session. Anyone with this string can authenticate as the user to Telegram with full read/write access. It must be stored encrypted at rest in a production deployment. The current architecture mitigates this by keeping db-service on the internal network only (ClusterIP in Kubernetes, internal Docker network locally), but the data is not encrypted at rest.

### Client Pool Grows Without Bound

The `clientPool` Map never evicts entries. In a deployment with many users, this eventually holds hundreds of long-lived WebSocket connections. An LRU eviction policy keyed by last-access time should be added for production scale.

### `proxyTimeout: 0` and `timeout: 0` in the Gateway

The api-gateway sets these to zero for all `/download/*` routes, meaning the gateway never times out connections to or from the download service. This is correct for large files but also applies to any misbehaving request that stalls — those connections must be managed at the OS level or by the ALB's idle timeout rather than by the application.
