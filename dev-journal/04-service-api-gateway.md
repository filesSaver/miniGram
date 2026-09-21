# miniGram — API Gateway Deep Dive

**Location:** `/services/api-gateway/`
**Port:** 3000
**Docker image:** `sauravmehta/content-scrapper-api-gateway:latest`

---

## 1. Purpose

The API gateway is the single entry point for all HTTP traffic destined for miniGram's backend microservices. Without it, the Angular frontend would need to know the internal address and port of every service — and direct connections across origins would require each service to configure its own CORS headers.

The gateway provides three concrete benefits:

**Single CORS policy.** One place configures what origins are allowed to call the backend. Services behind the gateway never need to think about CORS.

**Path abstraction.** The public URL shape (`/auth/login`) is decoupled from the internal URL shape (`/login` on auth-service). Services can be renamed, moved to different ports, or split into smaller services without changing the frontend's URLs.

**Streaming pass-through.** The gateway is configured with `timeout: 0` and `proxyTimeout: 0` specifically so large Telegram file downloads are never interrupted by a timeout, regardless of how long the transfer takes.

---

## 2. Tech Stack

### express 5.2.1
The HTTP framework. In the gateway, Express is used at its most minimal: `app.use('/path', middleware)` to register each proxy. Express 5 adds native async error propagation, but the gateway contains no async route handlers — it is forward-compatible.

### http-proxy-middleware 3.0.7
The core library. It wraps Node.js's `http-proxy` (node-http-proxy) in an Express-compatible middleware interface. When a request matches a route, the middleware:
1. Opens a new HTTP connection to the configured `target`.
2. Forwards the incoming request (method, headers, body) to the target.
3. Pipes the target's response back to the original caller.

The gateway uses the named export `legacyCreateProxyMiddleware` (aliased as `proxy`). The "legacy" variant preserves Express 4-era error handling behaviour where proxy errors call `next(err)` rather than throwing. This is the stable path for standard use cases.

### cors 2.8.6
Attaches `Access-Control-Allow-*` headers to every response. Without CORS headers, browsers refuse cross-origin requests — the Angular dev server on `localhost:4200` could not call `localhost:3000`.

### dotenv 17.4.2
Listed as a production dependency for loading a `.env` file into `process.env`. However, `require('dotenv').config()` is never called in `server.js`. In Docker Compose and Kubernetes, environment variables are injected directly, so the omission does not matter. To use `.env` for local development outside Docker, add `require('dotenv').config()` as the first line of `server.js`.

### nodemon 3.1.14 (devDependency)
Hot-reload for local development. Only used via `npm run dev`. Excluded from the Docker image by `npm ci --omit=dev`.

---

## 3. server.js — Line by Line

```js
const express = require('express');
const cors = require('cors');
const { legacyCreateProxyMiddleware: proxy } = require('http-proxy-middleware');
```
Three imports. The destructuring `{ legacyCreateProxyMiddleware: proxy }` pulls the named export and assigns it the alias `proxy` for brevity at each call site.

```js
const app = express();
const PORT = process.env.PORT || 3000;
```
Creates the Express app. Port defaults to 3000 if not set — allows running locally without any configuration.

```js
app.use(cors({
  origin: ['http://localhost:4200', /^https?:\/\/localhost(:\d+)?$/],
  credentials: true,
}));
```
CORS middleware registered before all routes. Every response gets CORS headers.

- `origin` allows the Angular CLI dev server (`localhost:4200`) and any other localhost port (regex matches `http://localhost:*` or `https://localhost:*`).
- `credentials: true` allows the browser to include cookies and `Authorization` headers in cross-origin requests. Requires that `origin` be an explicit value (not `*`).

The comment in the source explains why: Angular's built-in dev proxy (`proxy.conf.json`) can buffer or interfere with SSE and chunked streaming. Configuring CORS here lets the dev Angular app call the gateway directly on port 3000, bypassing the dev proxy for streaming cases.

```js
const AUTH_URL     = process.env.AUTH_SERVICE_URL     || 'http://localhost:3001';
const READ_URL     = process.env.READ_SERVICE_URL     || 'http://localhost:3002';
const DOWNLOAD_URL = process.env.DOWNLOAD_SERVICE_URL || 'http://localhost:3003';
const GUP_URL      = process.env.GUPLOAD_SERVICE_URL  || 'http://localhost:3004';
const GDWN_URL     = process.env.GDOWNLOAD_SERVICE_URL || 'http://localhost:3005';
const DB_URL       = process.env.DB_SERVICE_URL        || 'http://localhost:3006';
```
Six downstream service URLs read from the environment. In Docker Compose and Kubernetes, these are the internal DNS hostnames (e.g. `http://auth-service:3001`). Locally without Docker, they fall back to `localhost:*`. This is the 12-factor app pattern: all configuration from environment, no hardcoded addresses.

```js
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));
```
A direct Express route — not proxied. Returns immediately. Used by Docker Compose's `depends_on: condition: service_healthy` for the ui-service and any future Kubernetes liveness probes.

```js
app.use('/auth', proxy({ target: AUTH_URL, changeOrigin: true, pathRewrite: { '^/auth': '' } }));
```
Matches any request starting with `/auth`. Forwards to `auth-service:3001`. The `pathRewrite` strips the `/auth` prefix: `POST /auth/login` arrives at auth-service as `POST /login`. This decouples the public URL shape from the service's internal routing.

`changeOrigin: true` rewrites the outgoing `Host` header to match the target hostname (`auth-service` instead of `api-gateway`). Without this, downstream services that do virtual-host routing or log the `Host` header would see the gateway's hostname.

```js
app.use('/groups', proxy({ target: READ_URL, changeOrigin: true }));
```
Matches `/groups` and all sub-paths. No `pathRewrite` — `/groups/123` is forwarded as `/groups/123`. This means telegram-read-service must define its routes with the `/groups` prefix.

```js
app.use('/download/log-db', proxy({ target: DB_URL, changeOrigin: true, pathRewrite: { '^/download/log-db': '/downloads' } }));
app.use('/download/counts-db', proxy({ target: DB_URL, changeOrigin: true, pathRewrite: { '^/download/counts-db': '/downloads/counts' } }));
```
These two routes bypass telegram-download-service and go directly to db-service. They must appear before the `/download` catch-all rule below. Express matches routes in registration order — if `/download` were registered first, it would intercept these specific paths.

- `/download/log-db/*` → `http://db-service:3006/downloads/*` — reads the download history for a user/group
- `/download/counts-db/*` → `http://db-service:3006/downloads/counts/*` — reads per-group download counts for home screen badges

```js
app.use('/download', proxy({
  target: DOWNLOAD_URL,
  changeOrigin: true,
  proxyTimeout: 0,
  timeout: 0,
}));
```
The most nuanced route. Matches all `/download/*` paths not caught by the two specific rules above.

- `proxyTimeout: 0` — sets the socket inactivity timeout on the connection *to* telegram-download-service to infinity. Without this, a download taking more than 2 minutes (the default) would be cut off mid-stream.
- `timeout: 0` — sets `socket.setTimeout(0)` on the incoming client's socket. Without this, Node.js's idle-socket timer would close the client's connection during a long download.

Both settings are required together. One governs the upstream socket (to the download service); the other governs the downstream socket (to the browser via nginx).

```js
app.use('/google/upload', proxy({ target: GUP_URL, changeOrigin: true, pathRewrite: { '^/google/upload': '/upload' } }));
app.use('/google/download', proxy({ target: GDWN_URL, changeOrigin: true, pathRewrite: { '^/google/download': '/download' } }));
```
Routes for the future Google Drive services. Currently stubbed. The gateway routes are already wired and functional — they will return errors until the actual services are implemented.

```js
app.listen(PORT, () => console.log(`[api-gateway] running on port ${PORT}`));
```
Binds Express to all network interfaces on `PORT`. In Docker, stdout is captured by the Docker logging driver and visible via `docker compose logs api-gateway`.

---

## 4. Routing Table

| Public path | Downstream target | Path at target | Special config |
|------------|------------------|----------------|----------------|
| `GET /health` | (local) | — | Immediate response |
| `/auth/*` | `http://auth-service:3001` | `/*` (prefix stripped) | — |
| `/groups/*` | `http://telegram-read-service:3002` | `/groups/*` (unchanged) | — |
| `/download/log-db/*` | `http://db-service:3006` | `/downloads/*` | Must precede `/download` |
| `/download/counts-db/*` | `http://db-service:3006` | `/downloads/counts/*` | Must precede `/download` |
| `/download/*` | `http://telegram-download-service:3003` | `/download/*` (unchanged) | `timeout:0`, `proxyTimeout:0` |
| `/google/upload/*` | `http://google-upload-service:3004` | `/upload/*` | Stub service |
| `/google/download/*` | `http://google-download-service:3005` | `/download/*` | Stub service |

**Headers added by `changeOrigin: true` on every proxied request:**
- `Host` is rewritten to the target hostname
- `X-Forwarded-For` is set to the client's IP
- `X-Forwarded-Host` is set to the original `Host` header
- `X-Forwarded-Proto` is set to the original protocol

---

## 5. Docker Build

Two-stage Dockerfile. The key difference from the auth/read/download services is that the api-gateway has no native addon dependencies — no `python3 make g++` is needed, making the build faster.

Stage 1:
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev    # no build tools needed
COPY . .
```

Stage 2 (runtime):
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
EXPOSE 3000
USER node
CMD ["node", "server.js"]
```

Only `server.js` and `node_modules` are in the final image. No `package.json`, no `.dockerignore`, no source files beyond the one that is actually needed.

---

## 6. docker-compose Wiring

```yaml
api-gateway:
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
```

`auth-service: condition: service_healthy` — the gateway waits until auth-service passes its `wget` healthcheck before starting. The other services use `service_started` (just needs to be running, not necessarily serving requests yet).

There is no `depends_on` for `db-service` or `postgres` because the gateway proxies to those only for specific routes — it does not need them to boot successfully.

No healthcheck is defined for the gateway in docker-compose, although the `/health` endpoint exists. The ui-service depends on the api-gateway with `condition: service_started` (the default), so no healthcheck polling is needed.

---

## 7. Gotchas

### Route ordering is critical and invisible

Express matches routes in registration order. The `/download/log-db` and `/download/counts-db` specific routes must appear before the generic `/download` catch-all. If the order is reversed, both specific routes match the catch-all and are forwarded to telegram-download-service instead of db-service. No error is thrown. Requests silently go to the wrong service and return 404 or unexpected data.

Any future developer adding a new `/download/sub-route` must register it before the generic `/download` proxy.

### dotenv is installed but never called

`require('dotenv').config()` is not in `server.js`. The package is installed as a production dependency but non-functional. In Docker Compose and Kubernetes this is harmless (environment variables are injected directly). Running `node server.js` locally without Docker requires manually exporting the six service URL variables in the shell.

### No JWT verification at the gateway layer

The gateway forwards requests regardless of whether they carry a valid JWT. Authentication is enforced by each downstream service. A bug in one service's auth middleware could allow unauthenticated requests through for that service's routes. A more hardened design would have the gateway verify JWTs on protected routes before proxying.

### No rate limiting

There is no request rate limiting or body size cap. In production, `express-rate-limit` would be appropriate for the `/auth/*` routes (to limit login attempts) and a body-size cap would be appropriate for JSON API routes (though explicitly not for the `/download` streaming route).

### `timeout: 0` and `proxyTimeout: 0` apply to all `/download` requests

The infinite timeout is intentional for file downloads but also applies to any non-file request under `/download` that is not caught by the specific sub-rules. If telegram-download-service hangs on any such request, that connection stays open until the OS closes it.

### Google services are stubs

Requests to `/google/upload` and `/google/download` reach the placeholder services which return stub responses. The gateway starts and runs correctly. The routes are ready — no gateway changes are needed when the actual services are implemented, only the target services need to be built.
