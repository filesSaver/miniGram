# miniGram — Auth Service Deep Dive

**Location:** `/services/auth-service/`
**Port:** 3001
**Docker image:** `sauravmehta/content-scrapper-auth-service:latest`

---

## 1. Purpose

The auth-service is the identity and session-management gateway for the entire miniGram platform. It handles two completely separate authentication concerns in one process:

**Concern A — Application-level identity.** When a user wants to use miniGram, they register with a username and password. The auth-service hashes the password, stores it via the db-service, and later issues a signed JWT when credentials are verified. This JWT is the credential every other microservice uses to identify the caller.

**Concern B — Telegram session establishment.** miniGram's core feature requires reading content from private Telegram groups. Telegram's MTProto API requires a real user account — not a bot token, but a full user account session. The user provides their personal Telegram API credentials (`api_id` and `api_hash` from my.telegram.org) and their phone number. The auth-service drives the complete Telegram sign-in ceremony: requesting an OTP to the user's phone, accepting the code, handling optional 2FA, and storing the resulting session string in the database. From that point forward, the telegram-read-service and telegram-download-service load that session string and act as the user inside Telegram.

---

## 2. Tech Stack

### express 5.2.1
HTTP framework. `express.json()` middleware automatically parses JSON request bodies.

### bcryptjs 2.4.3
Password hashing. The pure-JavaScript reimplementation of bcrypt — chosen over native `bcrypt` because Alpine Linux containers avoid native compilation at runtime (no `python3 make g++` needed just for bcrypt). The trade-off is slightly slower hashing (~300ms vs ~200ms), which only increases brute-force protection.

Cost factor 12 means 2^12 = 4,096 internal rounds. At ~300ms per hash, a GPU farm doing dictionary attacks faces ~300ms per guess attempt per hash — impractical against even moderately complex passwords.

### jsonwebtoken 9.0.2
JWT signing and verification. `jwt.sign()` creates the bearer token; `jwt.verify()` checks signature and expiry atomically. Algorithm: `HS256` (HMAC-SHA256). Expiry: 7 days, hardcoded as the constant `JWT_EXPIRY = '7d'`.

### telegram (GramJS) 2.26.22
The full Telegram MTProto client library. Used here specifically for the OTP login ceremony — not for reading messages (that is the read service's job). GramJS handles the complete Diffie-Hellman key exchange, OTP submission, and SRP (Secure Remote Password) protocol for 2FA.

The `bufferutil` native addon (a GramJS transitive dependency) requires compilation from C++ source on Alpine, which is why the Dockerfile installs `python3 make g++` in the build stage.

### Node.js built-in `fetch`
Used for all HTTP calls to db-service. Available natively in Node.js 18+. No `axios` or `node-fetch` needed.

### nodemon 3.1.14 (devDependency)
Hot-reload for local development. Excluded from the Docker image.

---

## 3. API Endpoints

### `GET /health`
No auth. Returns `{"status":"ok","service":"auth-service"}`. Docker Compose healthcheck uses `wget -qO- http://localhost:3001/health`. The api-gateway, telegram-read-service, and telegram-download-service all `depends_on: auth-service: condition: service_healthy` — they wait until this endpoint returns 200.

### `POST /register`
No auth. Body: `{username, password}`.

1. Validates `username` against `/^[a-zA-Z0-9_]{3,30}$/` — letters, digits, underscores, 3–30 characters.
2. Validates `password` length >= 8.
3. `await bcrypt.hash(password, 12)` — ~300ms CPU-intensive operation. Returns the 60-character bcrypt string containing algorithm identifier, cost factor, embedded salt, and hash.
4. Calls `POST http://db-service:3006/users` with `{username, hash}`.
5. On db-service `409` response (username already taken): returns `409 {"error":"Username already taken"}`.
6. On success: returns `201 {"message":"User created"}`. No token issued — the user must log in separately.

### `POST /login`
No auth. Body: `{username, password}`.

1. Calls `GET http://db-service:3006/users/by-username/:username`.
2. If user not found: returns `401 {"error":"Invalid credentials"}` — same message as wrong password to prevent username enumeration.
3. `await bcrypt.compare(password, user.password_hash)` — ~300ms. If mismatch: `401 {"error":"Invalid credentials"}`.
4. On success: `jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' })`.
5. Returns `200 {token, username}`.

### `POST /setup` — requires JWT
Body: `{api_id, api_hash, phone}`.

1. Validates `api_id` with `parseInt` — rejects 0 or NaN.
2. Calls `PATCH http://db-service:3006/users/:userId/setup` to store the Telegram API credentials for this user.
3. Returns `200 {"message":"Setup saved"}`.

These credentials are per-developer-application at my.telegram.org. `api_id` identifies which developer application Telegram treats this as; `api_hash` is the corresponding secret. `phone` is the phone number associated with the Telegram account where the OTP will be sent.

### `POST /send-code` — requires JWT
No body.

1. Fetches the user's full record from db-service to confirm `api_id`, `api_hash`, and `phone` are present.
2. If any is missing: returns `428 {"setupRequired":true}` — HTTP 428 Precondition Required. The frontend interprets this as "go to setup first".
3. If there is already a `pendingAuth` entry for this user (called `/send-code` twice): disconnects the old GramJS client and discards it.
4. Creates a new `TelegramClient` with an empty `StringSession` (no existing session), `connectionRetries: 2`, `useWSS: true`.
5. `await client.connect()` — MTProto handshake with Telegram's servers.
6. `await client.sendCode(...)` — sends the `auth.sendCode` MTProto RPC. Telegram sends an OTP (SMS or in-app notification) to the user's phone and returns a `phoneCodeHash` nonce.
7. Stores `{client, phoneCodeHash, phone}` in the in-memory `pendingAuth` Map, keyed by `req.userId`.
8. Returns `200 {"message":"Code sent"}`.

### `POST /sign-in` — requires JWT
Body: `{code}` (the 5-digit OTP from Telegram).

1. Reads `pendingAuth.get(req.userId)`. If absent: `400 {"error":"No pending login — call send-code first"}`.
2. `await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }))`.
3. **Happy path:** Telegram accepts the code and returns the authenticated user object.
   - `client.session.save()` serialises the MTProto session to a base64 string.
   - `client.disconnect()`.
   - Calls `PATCH http://db-service:3006/users/:userId/session` to persist the session string.
   - Deletes the `pendingAuth` entry.
   - Returns `200 {"message":"Signed in"}`.
4. **2FA path:** If the account has Two-Factor Authentication, Telegram rejects with `SESSION_PASSWORD_NEEDED` error.
   - Returns `403 {"require2FA":true}` — signals the frontend to prompt for the cloud password.

### `POST /2fa` — requires JWT
Body: `{password}` (the Telegram cloud password, not the miniGram password).

1. Reads `pendingAuth.get(req.userId)` — the same live client from `/send-code` must still be alive.
2. Fetches user record for `api_id` and `api_hash`.
3. `await client.signInWithPassword({ apiId, apiHash }, { password })` — GramJS handles the full SRP challenge-response protocol internally. The password never leaves in cleartext.
4. Session string saved, client disconnected, `pendingAuth` entry deleted.
5. Returns `200 {"message":"Signed in"}`.

### `GET /status` — requires JWT
No body.

1. Fetches user record.
2. `hasSetup`: true if `api_id`, `api_hash`, and `phone` are all present.
3. `authorized`: true if `session_string` is present AND a live GramJS check passes (`client.isUserAuthorized()`). This makes a real network round-trip to Telegram.
4. Returns `200 {hasSetup, authorized}`.

Used by the Angular app's root component `ngOnInit` to decide which authentication step to show.

---

## 4. JWT Design

### Payload
```json
{
  "sub": 42,
  "username": "alice",
  "iat": 1700000000,
  "exp": 1700604800
}
```

`sub` (subject) is the user's database integer ID. `iat` (issued at) and `exp` (expiry) are standard JWT claims added automatically by `jsonwebtoken`.

### Algorithm and secret
`HS256` — HMAC-SHA256, symmetric. The same `JWT_SECRET` is used to sign and verify. `JWT_SECRET` is an environment variable. If it is absent at startup, the service calls `process.exit(1)` immediately.

### Expiry
7 days, hardcoded as `JWT_EXPIRY = '7d'`. No refresh token mechanism. After 7 days, the user must log in again. Tokens cannot be revoked before expiry — there is no token blacklist.

### Which services receive JWT_SECRET
- `auth-service` — signs and verifies tokens
- `telegram-read-service` — verifies tokens on all protected routes
- `telegram-download-service` — verifies tokens on the download route

The api-gateway does NOT have `JWT_SECRET` and does not verify tokens. It forwards the `Authorization` header downstream as-is.

---

## 5. In-Memory State: `pendingAuth` Map

```js
const pendingAuth = new Map();
// userId → { client: TelegramClient, phoneCodeHash: string, phone: string }
```

This map holds live, in-flight Telegram authentication sessions. It exists because the Telegram OTP flow is a multi-step stateful ceremony: the `client.connect()` and `client.sendCode()` calls in `/send-code` establish a live MTProto connection that must remain open until the user submits the code via `/sign-in`. The `phoneCodeHash` nonce ties the code submission back to the specific OTP request.

**Critical implications:**

1. **Service restarts lose all pending logins.** If the auth-service container crashes or is redeployed between a user calling `/send-code` and `/sign-in`, the entry is gone. The user must call `/send-code` again to get a new OTP.

2. **The service cannot be horizontally scaled.** If two auth-service replicas run behind a load balancer, a request to `/send-code` might hit replica A and a request to `/sign-in` might hit replica B. Replica B has no `pendingAuth` entry and returns an error. The `values.yaml` comment explicitly notes `KEEP replicas: 1`. To fix this, the in-memory state would need to be externalised to Redis or a database-backed session store.

3. **Memory leak protection.** Calling `/send-code` twice for the same user disconnects and discards the old client before creating a new one. Without this, stale GramJS clients with open WebSocket connections would accumulate.

---

## 6. Security Considerations

### bcrypt timing safety
`bcrypt.compare()` is inherently timing-safe because the comparison happens after a fixed-duration computation (the bcrypt hash rounds). Both "user not found" (where no hash comparison runs) and "wrong password" return the same message and the same HTTP status. This prevents both username enumeration and timing-based attacks.

### Username validation regex
`/^[a-zA-Z0-9_]{3,30}$/` serves two purposes:
1. Prevents control characters and Unicode lookalikes that could be used for impersonation (`аlice` with a Cyrillic `а` vs `alice` with a Latin `a`).
2. Length bounds (3–30) prevent extremely short or extremely long usernames that might cause storage or display issues.

### session_string is the most sensitive value
The Telegram `session_string` stored in the database is a complete Telegram session credential. Anyone with this string can instantiate a GramJS client and have full read/write access to the user's Telegram account. It is stored in plaintext. Recommended future improvement: encrypt at rest using a key held separately from the database.

### api_hash stored in plaintext
The `api_hash` from my.telegram.org is also plaintext. It is not per-user (it identifies the developer application) but leaking it would allow someone to impersonate the miniGram application when connecting to Telegram.

### No rate limiting
No rate limiting on `/login` (dictionary attack vector), `/send-code` (OTP spam vector to third parties' phones), or any other endpoint. Telegram has its own rate limiting on OTP sends, but there is nothing at the application layer.

---

## 7. Docker Build

The Dockerfile adds `python3 make g++` build tools before `npm ci` because GramJS's transitive dependency `bufferutil` requires C++ compilation on Alpine Linux. Alpine uses `musl libc` (not `glibc`), so pre-built npm binary packages do not work — compilation from source is required. The compiled `.node` binary is produced in the builder stage and copied to the runtime stage along with `node_modules`.

The runtime stage has no build tools — smaller image and smaller attack surface.

---

## 8. docker-compose Wiring

```yaml
auth-service:
  environment:
    PORT: 3001
    DB_SERVICE_URL: http://db-service:3006
    JWT_SECRET: ${JWT_SECRET}
  ports:
    - "3001:3001"
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

The dependency chain enforced by `depends_on`:
```
postgres healthy → db-service healthy → auth-service starts → auth-service healthy → telegram-read/download start
```

`JWT_SECRET: ${JWT_SECRET}` — Docker Compose interpolates this from the `.env` file in the project root. If absent, Docker Compose sets it to an empty string, which triggers the `process.exit(1)` guard.

---

## 9. Gotchas

### pendingAuth is lost on restart
See section 5. Any deployment, crash, or Docker restart between `/send-code` and `/sign-in` loses all pending logins. Users must restart the OTP flow.

### JWT_EXPIRY is hardcoded, not an environment variable
Changing the token lifetime requires a code change and redeploy. There is no token revocation. A compromised or deleted user's JWT remains valid until `exp` passes.

### GramJS `connectionRetries: 2`
Only 2 retry attempts before giving up. Transient network issues during OTP send will surface as 500 errors. The default is 5. The trade-off is faster failure (fewer seconds of waiting) at the cost of reduced tolerance for momentary network hiccups.

### Express 5 surfaces unhandled async errors in responses
If an error escapes a `try/catch` block in any async route handler, Express 5 returns a 500 with the error message in the response body. In development this is useful. In production, error messages may expose internal details (db-service URLs, GramJS stack traces). Sanitise error responses before a public deployment.

### db-service returns the full user row including sensitive fields
Every `GET /users/:id` and `GET /users/by-username/:username` response includes `password_hash`, `session_string`, and all other columns. The auth-service receives these sensitive values over the internal network and discards most of them. If any service logs HTTP responses for debugging, session strings and password hashes will appear in logs.

### Phone number is not validated
The `/setup` endpoint stores whatever string is provided as `phone` without any format validation. GramJS requires E.164 format (`+14155552671`). Providing a phone number without the `+` country code prefix, or with spaces, will cause the `sendCode` RPC to fail with a Telegram error that surfaces as a 500 response.
