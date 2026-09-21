# miniGram — UI Service Deep Dive

**Location:** `/services/ui-service/`
**Port:** 80 (nginx)
**Docker image:** `sauravmehta/content-scrapper-ui-service:latest`

---

## 1. Purpose

The ui-service is the browser-facing half of miniGram. It is a compiled Angular single-page application (SPA) served by nginx. It communicates exclusively with the `api-gateway` on the backend. The user never talks to Telegram directly — the gateway handles that through the Telegram MTProto services.

nginx serves two roles:
1. **Static file server** — serves the compiled Angular JavaScript bundles and assets at wire speed.
2. **Reverse proxy** — forwards all `/api/*` requests to the api-gateway, so the browser only ever speaks to one origin, eliminating CORS complexity.

---

## 2. Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Angular | 21.2.x | Component framework with TypeScript, dependency injection, built-in HTTP client, and signals-based reactivity |
| Angular Router | 21.2.x | Client-side routing with `withComponentInputBinding()` — route params become typed `input()` signals |
| Angular HttpClient | 21.2.x | Typed Observables for API calls; interceptor support for automatic JWT attachment |
| RxJS | 7.8.x | `tap`, `map`, `of` operators used with `HttpClient` |
| TypeScript | 5.9.x | Type safety for all API response shapes and service method signatures |
| nginx | alpine | ~25MB image; serves static files, handles reverse proxying, supports unbuffered streaming |
| Node 20 alpine | build-time only | Used to compile TypeScript with `ng build`; not in the final production image |

No state management library (NgRx, Akita) was added. Angular 21 signals (`signal()`, `computed()`) are sufficient for all reactive state.

---

## 3. Angular Application Architecture

### Entry Point: `src/main.ts`

```ts
bootstrapApplication(App, appConfig)
```

Angular 17+ standalone bootstrap — no `AppModule` class needed. Every component, service, and interceptor is declared directly or provided via the config object.

### App Config: `src/app/app.config.ts`

Three providers registered at the application level:

- `provideBrowserGlobalErrorListeners()` — registers uncaught error and unhandled promise rejection listeners that pipe errors to Angular's error handler.
- `provideRouter(routes, withComponentInputBinding())` — sets up routing. `withComponentInputBinding()` is critical: it allows route parameters like `:groupId` to be injected directly as `input<string>('groupId')` signals on components instead of requiring `ActivatedRoute` injection.
- `provideHttpClient(withInterceptors([authInterceptor]))` — sets up the HTTP client and registers the JWT interceptor in the functional interceptor pipeline.

### Routes: `src/app/app.routes.ts`

| URL pattern | Component | Renders |
|-------------|-----------|---------|
| `` (empty) | `HomeComponent` | List of all groups and channels |
| `group/:groupId` | `GroupDetailComponent` | Content of one group with tabs |
| `group/:groupId/topic/:topicId` | `TopicDetailComponent` | Content of one forum topic |

Routes are eagerly loaded — no lazy loading. The app is small enough that code splitting would add more latency from extra HTTP requests than it would save.

### Root Component: `src/app/app.ts`

The root component (`App`) is an authentication shell. It never renders actual page content — it renders one of several auth screens, or, when auth is complete, `<router-outlet />` which renders the matched route.

**Auth state machine:**

The `step` signal is typed as a union literal: `'checking' | 'app-login' | 'app-register' | 'setup' | 'phone' | 'otp' | 'two-fa' | 'done'`.

```
checking ──── no token in localStorage ──────► app-login
    │                                               │
    │── has token, GET /api/auth/status             │ login succeeds
    │       hasSetup=false ──────────────► setup    │
    │       authorized=false ────────────► phone ◄──┘
    │       authorized=true ─────────────► done
                                           │
                                    <router-outlet>
                                    (home / group / topic)
```

**Step details:**

- **app-login:** `POST /api/auth/login` → receives JWT → calls `setToken()` → re-runs `ngOnInit` to advance.
- **app-register:** `POST /api/auth/register` → switches to `app-login`.
- **setup:** Saves `api_id`, `api_hash`, and phone number via `PATCH /api/auth/setup`.
- **phone:** Triggers OTP delivery via `POST /api/auth/send-code`.
- **otp:** Submits the 5-digit code via `POST /api/auth/sign-in`. On 2FA account, the backend returns `403 { require2FA: true }`, and the UI advances to `two-fa`.
- **two-fa:** Submits the Telegram cloud password via `POST /api/auth/2fa`.
- **done:** All auth complete. `<router-outlet>` renders.

All form field values, `loading`, and `error` are Angular signals. Setting a signal (`this.loading.set(true)`) immediately updates any template that reads it without a change detection tick.

---

## 4. Auth Flow: JWT Storage and Automatic Attachment

### Storage

After a successful login, `authService.setToken(res.token)` writes the JWT to `localStorage` under the key `mg_jwt`. The token persists across browser sessions — closing and reopening the browser remains authenticated.

### Automatic Attachment: `src/app/auth.interceptor.ts`

```ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();
  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next(req);
};
```

This interceptor runs on every `HttpClient` request before it reaches the network. `inject(AuthService)` works here despite being outside a component tree — functional interceptors support DI via `inject()`. `req.clone(...)` creates a new immutable request object with the Authorization header added (HTTP requests in Angular are immutable — you can only clone-with-changes). If no token exists, the request passes through unmodified.

### Client-side JWT Decode

`authService.getUserId()` decodes the JWT payload without verifying the signature:
```ts
const payload = JSON.parse(atob(token.split('.')[1]));
return payload.sub;
```

This is a read-only convenience (reading the user's own ID from their own token). The backend always re-verifies the full signature on every request.

### Logout

`authService.logout()` clears the JWT, clears every in-memory cache, revokes all blob URLs (`URL.revokeObjectURL()`), and removes the groups cache from localStorage. `window.location.reload()` in `HomeComponent.logout()` forces a hard page reload because clearing signals alone does not fully reset all service state.

---

## 5. Download Flow: How `downloadFile()` Works

### The Core Problem

File downloads must trigger the browser's built-in download manager (the save-file dialog). If binary data were fetched with `HttpClient`, the entire file would load into JavaScript memory first — crashing the browser for large files. The standard approach is to let the browser fetch the file directly by navigating to the URL. But the auth interceptor only works with `HttpClient`, not with direct URL navigation.

### The Solution: Token in Query Parameter

```ts
downloadFile(groupId: string, messageId: string | number, fileName: string): void {
  const token = this.getToken();
  const params = new URLSearchParams({ groupId, messageId: String(messageId), token: token ?? '' });
  const a = document.createElement('a');
  a.href = `${BASE_DIRECT}/api/download/file?${params}`;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
```

1. `URLSearchParams` encodes `groupId`, `messageId`, and the JWT `token` into a query string.
2. A hidden `<a>` element is created. The `download` attribute tells the browser this is a download and provides the suggested filename.
3. The element is appended to the DOM (required for Firefox — it does not fire click events on detached elements), clicked programmatically, then removed.
4. The browser initiates a GET request directly (bypassing Angular's HTTP client). The backend reads the `?token=` parameter and validates it.

### `BASE_DIRECT` and the Dev/Production Split

```ts
const BASE_DIRECT = (typeof window !== 'undefined' && window.location.port === '4200')
  ? 'http://localhost:3000'
  : '';
```

**In production** (`BASE_DIRECT = ''`): The href becomes `/api/download/file?...`. nginx receives this and matches it to the download-specific `location` block with `proxy_buffering off`. The file streams correctly.

**In development** (`BASE_DIRECT = 'http://localhost:3000'`): The href goes directly to the gateway at port 3000, bypassing Angular's dev proxy entirely. This is necessary because Angular's dev proxy buffers entire responses into memory before forwarding them — for large binary files this causes memory issues and corrupted downloads.

### Polling for Completion

After the `<a>` click there is no JavaScript Promise or Observable to indicate when the download finishes. The component polls `getGroupDownloadLog(groupId)` every 5 seconds. When the response includes this `messageId`, the download is confirmed complete in the database, and the UI transitions from the spinning "Downloading..." state to a green checkmark.

### The Download Queue

The component serialises downloads one at a time:
```
downloadQueue: ContentItem[]   // items waiting
queueRunning: boolean          // mutex flag
```

`downloadItem(item)` pushes to the queue and calls `runQueue()`. `runQueue()` is an `async` function processing one item at a time with `await triggerDownload(item)`. Sequential processing prevents multiple browser save-file dialogs from appearing simultaneously.

---

## 6. Service: `src/app/services/auth.service.ts`

The central service for all API communication and client-side caching. `providedIn: 'root'` means exactly one instance exists for the entire application lifetime.

### Key Constants

```ts
const BASE = '/api';
const TOKEN_KEY = 'mg_jwt';
const GROUPS_CACHE_KEY = 'mg_groups_cache';
```

`BASE = '/api'` is the prefix for all API calls. In production, nginx strips `/api` and forwards to the gateway. In development, `proxy.conf.json` does the same.

### In-Memory Cache Strategy

| Cache Map | Key | Value |
|-----------|-----|-------|
| `_groupsCache` | (single object) | Groups list, total, groupCount, channelCount |
| `_groupCache` | `groupId` | Single `Group` object |
| `_topicsCache` | `groupId` | `Topic[]` array |
| `_breakdownCache` | `groupId` | `GroupBreakdown` (per-type counts) |
| `_topicBreakdownCache` | `"groupId:topicId"` | `GroupBreakdown` for a topic |
| `_itemsCache` | `groupId` or `"groupId:topicId"` | `ContentItem[]` array |
| `_photoCache` | `groupId` | Blob object URL string |

Strategy: always check the in-memory cache first. Return an `Observable<T>` wrapping a synchronous value with `of(cached)` on cache hit. On cache miss, make the HTTP call and populate the cache in the `tap` operator. This means navigating back to a previously visited group is instant.

### Type Interfaces (exported from `auth.service.ts`)

```ts
interface Group {
  id: string; name: string; type: 'group' | 'channel';
  memberCount: number; createdAt: string; about: string | null;
  scam: boolean; fake: boolean; restricted: boolean; verified: boolean;
  forum: boolean; megagroup: boolean; gigagroup: boolean; broadcast: boolean;
  // ... other Telegram flags
}

interface Topic {
  id: number; title: string; topMessage: number;
  unreadCount: number; closed: boolean; pinned: boolean; iconEmoji: string | null;
}

interface GroupBreakdown {
  video: number; audio: number; image: number;
  pdf: number; chat: number; other: number;
}

interface ContentItem {
  id: string; type: string; text: string | null; date: string;
  fileName: string | null; fileSize: number | null; mimeType: string | null;
}

interface DownloadEntry { message_id: string; file_name: string | null; file_size: number | null; ts: number; }
```

---

## 7. Components

### HomeComponent (`src/app/home/`)

Rendered at `/`. Shows all groups and channels.

**State signals:**
- `groups: signal<Group[]>` — the full list.
- `loadingGroups: signal<boolean>`.
- `totalGroups, groupCount, channelCount: signal<number>`.
- `searchQuery: signal<string>` — text in the search box.
- `downloadCounts: signal<Record<string, number>>` — per-group badge numbers.
- `photoStates: signal<Record<string, 'loading' | 'loaded' | 'error'>>`.
- `photoUrls: signal<Record<string, string>>` — blob URLs for loaded photos.

**`filteredGroups` computed signal:**
```ts
filteredGroups = computed(() => {
  const q = this.searchQuery().toLowerCase().trim();
  if (!q) return this.groups();
  return this.groups().filter(g =>
    g.name.toLowerCase().includes(q) ||
    (g.username ?? '').toLowerCase().includes(q)
  );
});
```

Automatically recomputes whenever `searchQuery` or `groups` changes.

**`ngOnInit` does four things:**
1. Busts the groups cache (so the home page always shows fresh data).
2. Calls `getGroups(9999, 0)` — fetches all groups in one call.
3. Calls `getDownloadCounts()` to populate per-group download badges.
4. Calls `_loadPhotosBatched` to start loading profile photos in batches.

**Batched photo loading:** Groups are loaded in batches of 10 with a 2,000ms gap between batches. Within each batch, photos load concurrently (`Promise.all`). This prevents flooding the gateway with hundreds of simultaneous photo requests. Timers are stored in `_retryTimers` and cleared in `ngOnDestroy`.

**Photo rendering:** `authService.fetchGroupPhoto(groupId)` uses `HttpClient` with `responseType: 'blob'`. The JWT is attached by the interceptor. `URL.createObjectURL(blob)` creates an in-memory URL usable as `<img src>`. If no photo exists, the template shows a letter initial using the group name's first character.

### GroupDetailComponent (`src/app/group-detail/`)

The most complex component. Rendered at `/group/:groupId`. Receives `groupId` as `input<string>('')` via `withComponentInputBinding()`.

**Tab system:** Seven tabs — All, Videos, Images, PDFs, Chat, Other, Range. `TAB_TYPE_MAP` maps tab keys to API `type` parameter values (`videos → 'video'`).

**Forum groups:** If the group has `g.forum === true`, the tab bar is hidden and topics are shown instead as clickable cards that navigate to `/group/:groupId/topic/:topicId`.

**The SSE breakdown scan:**
```
First load (no cache):
  1. Open EventSource at /api/groups/:id/breakdown/stream?token=...
  2. Receive progress events: { processed: N, total: M, done: false }
  3. Show progress bar
  4. When done: true arrives, store counts in breakdown cache, close EventSource
  5. Fetch all content items

Subsequent loads (cached):
  1. Use cached breakdown immediately
  2. Use cached items immediately
  → No SSE connection opened
```

**The all-items cache strategy:** After the SSE scan completes, `getGroupContent(gid, 'all', 999999, 0)` fetches every content item in the group. This is stored in `allItemsCache`. Switching tabs filters this in-memory array client-side — tab switching is instant with no additional API calls.

**Selection system:**
```ts
selectedIds = signal<Set<string>>(new Set());
isSelected = (id: string) => computed(() => this.selectedIds().has(id));
selectedCount = computed(() => this.selectedIds().size);
```

The "select all" checkbox gets `[indeterminate]="someSelected()"` which renders the checkbox in the partially-selected state when some but not all items are selected.

**Total selected size:**
`totalSelectedSize` and `totalSelectedSizePartial` are computed signals that calculate the total byte size of selected items, de-duplicating across `filteredItems`, `rangeItems`, and `allItemsCache`. `totalSelectedSizePartial` is `true` if any selected item has a null `fileSize`, in which case the template shows a `~` prefix.

**Range tab:** Lets the user enter raw Telegram message ID bounds (e.g. "from 5000 to 6000") and fetch only that slice. Useful when the user knows the approximate location of the files they want within a large channel.

**`formatSize(bytes)`:** Converts bytes to B/KB/MB/GB/TB using powers of 1024.

### TopicDetailComponent (`src/app/topic-detail/`)

Rendered at `/group/:groupId/topic/:topicId`. Structurally nearly identical to `GroupDetailComponent` but scoped to a single forum topic thread.

**Key differences:**
- Receives both `groupId` and `topicId` as route input signals.
- Cache key is `"${gid}:${tid}"`.
- SSE stream URL is `/api/groups/:gid/topics/:tid/breakdown/stream`.
- `topicId` is a string route param but Telegram topic IDs are numbers — converted with `Number(this.topicId())` where needed.
- Download log polling uses `getGroupDownloadLog(groupId)` (group-level, not topic-scoped) because the download log records at the group level.

**CSS reuse:** `topic-detail.css` imports `group-detail.css` entirely:
```css
@import '../group-detail/group-detail.css';
```
Only adds two extra rules for the topic-specific breadcrumb elements.

---

## 8. nginx Configuration

**File:** `/services/ui-service/nginx.conf`
**Applied as:** `/etc/nginx/conf.d/default.conf` in the container.

nginx listens on port 80. `server_name _` matches any hostname.

### Location Block Evaluation Order

nginx evaluates locations: exact match (`=`) → longest prefix match → first-matching regex (`~`). The prefix `/api/download/file` (17 chars) beats `/api/` (5 chars) for requests starting with `/api/download/file` without needing a regex.

### Block 1: `/api/download/file` — Single File Downloads

```nginx
location /api/download/file {
    proxy_pass http://api-gateway:3000/download/file;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**The most critical block.** `proxy_buffering off` disables nginx's default behaviour of buffering the entire proxied response before forwarding. Without this, nginx would accumulate a multi-gigabyte file in memory (or its temp buffer files), exceed buffer limits, and send a truncated or corrupted response. This block exists specifically to set this flag for the download path — the general `/api/` block (Block 2) does not have it.

`proxy_http_version 1.1; proxy_set_header Connection ''` enables persistent HTTP connections between nginx and the gateway, preventing premature connection teardown on long-running transfers. `proxy_read_timeout 3600s` allows one hour for a download to complete.

### Block 2: `/api/` — General API Proxy

```nginx
location /api/ {
    proxy_pass http://api-gateway:3000/;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

The trailing slash on both sides is critical. With `proxy_pass http://api-gateway:3000/`, nginx replaces the matched prefix (`/api/`) with `/`, so `GET /api/auth/login` becomes `GET /auth/login` at the gateway. Without the trailing slash, the full path including `/api/` would be forwarded, causing 404 errors.

### Blocks 4 and 5: SSE Streams

```nginx
location ~ ^/api/groups/[^/]+/breakdown/stream$ {
    rewrite ^/api/(.*)$ /$1 break;
    proxy_pass http://api-gateway:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
}
```

SSE requires `proxy_buffering off` for the same reason as downloads — nginx must forward each `data:` event immediately instead of accumulating them. `proxy_cache off` prevents nginx from trying to cache what looks like a never-ending response. `Connection ''` with HTTP/1.1 keeps the connection open for minutes. The `rewrite ... break` strips the `/api/` prefix.

Block 5 covers topic-level SSE with an additional `[^/]+` segment for `topicId`.

### Other Timeout Blocks (6–8)

Regex blocks for `/api/groups/[^/]+/breakdown$`, `/api/groups/[^/]+/content/range$`, and the topic equivalents. These endpoints can be slow (a full message scan), so they get 600-second timeouts. No special buffering settings needed because they return regular JSON responses.

### Block 9: Catch-All `location /`

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

This is what makes Angular's client-side router work on page refresh. When the browser loads `/group/123`, nginx looks for a file at `$uri` (none), then a directory at `$uri/` (none), then falls back to serving `index.html`. Angular boots, reads `window.location`, and the router renders `GroupDetailComponent`. Without this, any Angular route that is not the root would return 404 on refresh.

---

## 9. Dockerfile: Three-Stage Build

```dockerfile
# Stage 1: install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

# Stage 2: compile TypeScript to JavaScript
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: nginx serving the compiled output
FROM nginx:alpine
COPY --from=builder /app/dist/ui/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**Stage 1 (`deps`):** Copies `package.json` and `package-lock.json` first (Docker layer-caching optimisation — if neither changes, `npm install` is skipped on subsequent builds). Installs all dependencies including devDependencies (Angular CLI is a devDependency).

**Stage 2 (`builder`):** Copies node_modules from deps stage. Copies all source. Runs `ng build`, which compiles TypeScript, tree-shakes, minifies, and generates cache-busted filenames. Output goes to `dist/ui/browser/` (the `ui` comes from `"name": "ui"` in `package.json`; the `browser/` subdirectory is Angular 17+ convention).

**Stage 3 (nginx):** No Node.js. Only nginx (~25MB) and the compiled static files. `daemon off` runs nginx in the foreground, required for Docker containers — if nginx daemonised, the container process would exit immediately.

**Final image size:** Under 30MB versus over 1GB if Node had been included.

---

## 10. Local Development: `proxy.conf.json`

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "secure": false,
    "pathRewrite": { "^/api": "" }
  }
}
```

When running `ng serve` (Angular dev server on port 4200), all `HttpClient` calls to `/api/*` are forwarded to `http://localhost:3000` with the `/api` prefix stripped. This mirrors what nginx does in production and prevents CORS errors during development. Configured in `angular.json` under `"proxyConfig": "proxy.conf.json"`.

File downloads bypass this proxy via the `BASE_DIRECT` mechanism (see Section 5).

---

## 11. Gotchas

### The Missing `/api/` Prefix Bug (Fixed)

At one point the `downloadFile()` method built the URL without the `/api/` prefix:
```ts
// Broken:
a.href = `${BASE_DIRECT}/download/file?${params}`;
```

In production (`BASE_DIRECT = ''`), this produced `/download/file?...`. nginx matched this to `location /` (the catch-all) and served `index.html`. The browser saved the HTML content as a file — a corrupted "video.mp4" that actually contained `<!doctype html>...`.

The fix was adding `/api/`:
```ts
// Fixed:
a.href = `${BASE_DIRECT}/api/download/file?${params}`;
```

This bug was invisible in local development because `BASE_DIRECT` pointed directly to `localhost:3000`, which has a `/download/file` route. The missing `/api/` only manifested in the nginx-mediated production flow.

### The `app.spec.ts` Test Always Fails

The only test file contains a scaffold test from `ng new` that checks for `<h1>Hello, ui</h1>`. This element no longer exists. Running `ng test` will produce a failing test suite. This has no impact on the production build but should be cleaned up.

### Groups Cache Persists Across Logins

`_groupsCache` is persisted to `localStorage`. If two users share a browser, User B may briefly see User A's group list before `bustGroupsCache()` runs in `ngOnInit`. Acceptable for a personal-use tool.

### SSE Connections Leak on Mid-Scan Navigation

`ngOnDestroy` calls `this.sseSource?.close()`, but if the user navigates away during an active SSE scan, the scan result is lost. Re-visiting the group restarts the scan from the beginning.

### Photo Blob URLs Accumulate During a Session

Blob URLs are only revoked on logout (`URL.revokeObjectURL(url)`). During a session with hundreds of loaded group photos, the memory from those blobs accumulates. No LRU eviction is implemented.

### `window.location.reload()` After Logout

`HomeComponent.logout()` calls `window.location.reload()` — a hard page reload rather than Angular navigation. This ensures complete cleanup of service state that would otherwise persist across Angular navigation. It causes a visible page flash but is functionally correct.
