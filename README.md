# miniGram

## Live Application

> **URL is updated automatically after each deployment.**

| | |
|---|---|
| **App URL** | http://k8s-minigram-minigram-3e16dfc8d5-768189416.us-east-1.elb.amazonaws.com |
| **Status** | Deployed on AWS EKS (us-east-1) via GitHub Actions |

---

## Docker Hub Images

All service images are public on Docker Hub under `sauravmehta/content-scrapper-*`:

| Image | Link |
|---|---|
| auth-service | [sauravmehta/content-scrapper-auth-service](https://hub.docker.com/r/sauravmehta/content-scrapper-auth-service) |
| telegram-read-service | [sauravmehta/content-scrapper-telegram-read-service](https://hub.docker.com/r/sauravmehta/content-scrapper-telegram-read-service) |
| telegram-download-service | [sauravmehta/content-scrapper-telegram-download-service](https://hub.docker.com/r/sauravmehta/content-scrapper-telegram-download-service) |
| google-upload-service | [sauravmehta/content-scrapper-google-upload-service](https://hub.docker.com/r/sauravmehta/content-scrapper-google-upload-service) |
| google-download-service | [sauravmehta/content-scrapper-google-download-service](https://hub.docker.com/r/sauravmehta/content-scrapper-google-download-service) |
| api-gateway | [sauravmehta/content-scrapper-api-gateway](https://hub.docker.com/r/sauravmehta/content-scrapper-api-gateway) |
| ui-service | [sauravmehta/content-scrapper-ui-service](https://hub.docker.com/r/sauravmehta/content-scrapper-ui-service) |

---

## What We're Building

miniGram is a self-hosted tool for browsing and downloading media from private Telegram groups you are a member of. The backend is split into independent microservices (auth, read, download, gateway, UI) deployed on AWS EKS, with a CI/CD pipeline on GitHub Actions that builds platform-correct Docker images and provisions a fresh EKS cluster on every run. The goal is to understand real-world microservices architecture, container orchestration on Kubernetes, and cloud deployment end-to-end — from a local Docker Compose setup all the way to a production-grade AWS deployment.

---

## Dev Journal

Full engineering documentation — architecture, service deep-dives, infrastructure setup, and every bug with its root cause — lives in the dev journal:

**[dev-journal/INDEX.md](./dev-journal/INDEX.md)**

| Doc | What it covers |
|---|---|
| [01 — Overview](./dev-journal/01-overview.md) | System architecture, tech choices, request flow |
| [02 — High Level Design](./dev-journal/02-high-level-design.md) | Components, data flow diagrams, security model |
| [03 — Low Level Design](./dev-journal/03-low-level-design.md) | Every API endpoint, DB schema, nginx logic, K8s resources |
| [04 — API Gateway](./dev-journal/04-service-api-gateway.md) | Routing table, path rewriting, streaming timeouts |
| [05 — Auth Service](./dev-journal/05-service-auth.md) | Telegram OTP, 2FA, JWT, bcrypt, session state |
| [06 — DB Service](./dev-journal/06-service-db.md) | PostgreSQL schema, queries, connection pool, inline migrations |
| [07 — Telegram Read Service](./dev-journal/07-service-telegram-read.md) | GramJS MTProto, SSE streaming, in-memory cache |
| [08 — Telegram Download Service](./dev-journal/08-service-telegram-download.md) | Binary streaming, backpressure, download queue |
| [09 — UI Service](./dev-journal/09-service-ui.md) | Angular components, auth state machine, nginx config |
| [10 — Local Infra](./dev-journal/10-infra-local.md) | Docker Compose setup, env vars, service networking |
| [11 — AWS Infra](./dev-journal/11-infra-aws.md) | EKS cluster, ALB controller, Helm chart, deploy sequence |
| [12 — Bugs & Fixes](./dev-journal/12-bugs-and-fixes.md) | Every bug encountered with root cause and fix |
| [Deploy Log](./dev-journal/DEPLOY-LOG.md) | Session-by-session record of every deployment: commands run, outputs, errors, and fixes |

---

## Screenshots

<p align="center">
  <img src="resources/image.png" width="32%" />
  <img src="resources/image-1.png" width="32%" />
  <img src="resources/image-2.png" width="32%" />
</p>

---

## Features

### Telegram Authentication

* Phone number based login
* OTP verification
* Telegram 2FA / password support
* Persistent session (no re-login after restart)
* Automatic detection of existing sessions

### Telegram Groups & Channels

* Fetches the user's groups and channels
* Displays group/channel profile photos
* Pagination support
* Navigate from list to detailed content view

### Content Browsing

View content shared inside a group/channel, filtered by type:

* Videos
* Images
* PDFs
* Chat / Messages
* Other files
* All content

### Content Selection & Download

* Select individual items or bulk-select
* Load more content without replacing existing results
* Download selected Telegram media files to a local directory

### Telegram URL Input

The home page includes a URL input for `t.me/...` links.

---

## Architecture

The project is split into **7 independent Docker services** that communicate over an internal network. The browser only ever talks to the UI and API Gateway — all backend services are isolated.

```
┌─────────────────────────────────┐
│       Browser / Angular UI      │
│          localhost:4200          │
└──────────────┬──────────────────┘
               │ HTTP /api/*
               ▼
┌─────────────────────────────────┐
│           API Gateway           │
│          localhost:3000          │
└──┬──────┬──────┬──────┬─────────┘
   │      │      │      │
   ▼      ▼      ▼      ▼
auth  tg-read  tg-dl  g-upload/download
:3001  :3002   :3003   :3004 / :3005
```

### Services

| Service | Port | Responsibility |
| --- | --- | --- |
| `auth-service` | 3001 | Telegram login, OTP, 2FA, session |
| `telegram-read-service` | 3002 | Groups, messages, profile photos |
| `telegram-download-service` | 3003 | Media file downloads |
| `google-upload-service` | 3004 | Upload files to Google Drive |
| `google-download-service` | 3005 | Download files from Google Drive |
| `api-gateway` | 3000 | Route external traffic; no business logic |
| `ui-service` | 4200 | Angular app compiled to static files, served by nginx |

### Request Flow

```
Browser
   │
   ▼
Angular UI (nginx :80 → :4200)
   │
   ▼
API Gateway (:3000)
   │
   ├── /auth/*    → auth-service :3001
   ├── /groups/*  → telegram-read-service :3002
   ├── /download  → telegram-download-service :3003
   ├── /google/upload   → google-upload-service :3004
   └── /google/download → google-download-service :3005
```

---

## Project Structure

```
telegram-content-download/
│
├── docker-compose.yml          ← starts all 7 services
├── Makefile                    ← build / push / save shortcuts
├── .env.example                ← copy to .env and fill in credentials
├── package.json                ← root dev scripts (npm run dev, etc.)
│
├── services/
│   ├── auth-service/
│   │   ├── Dockerfile
│   │   ├── server.js
│   │   └── package.json
│   ├── telegram-read-service/
│   ├── telegram-download-service/
│   ├── google-upload-service/
│   ├── google-download-service/
│   ├── api-gateway/
│   └── ui-service/             ← Angular app + nginx config
│
├── downloads/
│   └── Custom/                 ← default local download folder
│
├── resources/                  ← README screenshots
└── dev-journals/               ← build journal & technical deep-dives
```

---

## Getting Started

### Prerequisites

* Docker Desktop (with Compose v2+)
* Telegram API credentials from [my.telegram.org](https://my.telegram.org)

### 1. Create your `.env` file

```bash
cp .env.example .env
# Fill in API_ID and API_HASH
```

### 2. Start all services

```bash
npm run dev
# or: make up
```

Docker builds all 7 images and starts the full stack. First run takes 3–5 minutes; subsequent runs use the layer cache and are much faster.

### 3. Open the app

Navigate to [http://localhost:4200](http://localhost:4200) — log in with your Telegram phone number and follow the on-screen steps.

---

## npm Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Build images and start all services (blocking) |
| `npm run dev:detached` | Same, but runs in the background |
| `npm run stop` | Stop all containers |
| `npm run logs` | Tail logs from all services |
| `npm run build` | Build Docker images without starting |

## Makefile Targets

| Target | What it does |
| --- | --- |
| `make up` | Start stack in the background |
| `make down` | Stop stack |
| `make build` | Build all Docker images |
| `make push REGISTRY=you` | Push all images to Docker Hub |
| `make save` | Export images to `./docker-images/*.tar` |
| `make load` | Import `.tar` files back into Docker |
| `make logs` | Tail all logs |
| `make clean` | Remove all built images |

---

## API Endpoints

All routes go through the API Gateway at `:3000`.

### Auth

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/auth/status` | Check if a Telegram session is active |
| `POST` | `/auth/send-code` | Send OTP to phone number |
| `POST` | `/auth/sign-in` | Verify OTP and sign in |
| `POST` | `/auth/2fa` | Submit 2FA password |

### Groups & Content

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/groups` | List user's groups and channels |
| `GET` | `/groups/:id/photo` | Get group/channel profile photo |
| `GET` | `/groups/:id/content` | Get paginated content from a group |

### Download

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/download` | Download Telegram media to local folder |

### Health

Every service exposes `GET /health` → `{"status":"ok","service":"<name>"}`.

---

## Environment Variables

```env
# Telegram API credentials (required) — get from https://my.telegram.org
API_ID=your_api_id_here
API_HASH=your_api_hash_here

# Telegram session string — populated automatically after first login
SESSION_STRING=

# Service ports (optional — services have built-in defaults)
AUTH_SERVICE_PORT=3001
READ_SERVICE_PORT=3002
DOWNLOAD_SERVICE_PORT=3003
GUPLOAD_SERVICE_PORT=3004
GDOWNLOAD_SERVICE_PORT=3005
GATEWAY_PORT=3000
UI_PORT=4200

# Docker registry (your Docker Hub username)
REGISTRY=your-dockerhub-username
```

> **Never commit `.env` or Telegram credentials to Git.**

---

## Download Destinations

The `telegram-download-service` can write files to three locations, configured via environment variables in `docker-compose.yml`:

| Env Var | Default mount | Purpose |
| --- | --- | --- |
| `DOWNLOADS_DESKTOP` | `~/Desktop` | Save to Mac/Windows desktop |
| `DOWNLOADS_DOWNLOADS` | `~/Downloads` | Save to Downloads folder |
| `DOWNLOADS_CUSTOM` | `./downloads/Custom` | Repo-local custom folder |

---

## Current Status

| Feature | Status |
| --- | :---: |
| Telegram authentication | ✅ |
| OTP login | ✅ |
| Telegram 2FA | ✅ |
| Persistent session | ✅ |
| Group / channel listing | ✅ |
| Group profile photos | ✅ |
| Content retrieval | ✅ |
| Content categorization | ✅ |
| Content filtering by type | ✅ |
| Pagination | ✅ |
| Load more | ✅ |
| Content selection | ✅ |
| Telegram media download | ✅ |
| Microservices / Docker | ✅ |
| API Gateway | ✅ |
| Google Drive upload | 🟡 In progress |
| Google Drive download | 🟡 In progress |
| Telegram URL input | 🟡 Partial |
| Bulk download | ❌ |
| Download progress indicators | ❌ |
| API authentication / security | ❌ |

---

## Planned Improvements

* [ ] Complete Google Drive upload and download integration
* [ ] Implement bulk downloads
* [ ] Support `t.me/...` URL-based downloads
* [ ] Add download progress indicators
* [ ] Add download history
* [ ] Add API authentication (JWT / API key)
* [ ] Secure session storage
* [ ] Add rate limiting
* [ ] Improve error handling
* [ ] Production deployment configuration (HTTPS, env secrets)

---

## Security Notice

The backend API currently has **no authentication or authorization**. Anyone who can reach the Node.js gateway at port 3000 can access the Telegram data available through the API.

Before exposing this in a production or publicly accessible environment, implement:

* API authentication (JWT or API keys)
* Authorization middleware
* HTTPS / SSL termination
* Rate limiting
* Input validation
* Proper CORS configuration
* Secure environment variable management (secrets manager)

---

## Dev Journals

Detailed notes on architecture decisions, errors encountered, and Docker deep-dives are in [`dev-journals/`](./dev-journals/):

* **Build Journal** — every error hit during the microservices migration and exactly how each was fixed
* **Microservices & Docker Deep Dive** — first-principles guide to Docker, multi-stage builds, networking, and the API gateway

---

## Important

This project is intended for accessing content from Telegram accounts the authenticated user is authorized to access. Users are responsible for complying with Telegram's terms of service, applicable laws, and the rights of content owners.

---

## License

MIT License

---

## Development

Contributions, improvements, and suggestions are welcome. If you find a bug or have a feature idea, open an issue or submit a pull request.
