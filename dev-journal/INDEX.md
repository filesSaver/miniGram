# miniGram Dev Journal — Navigation Index

This directory contains the complete engineering documentation for the miniGram project:
a self-hosted tool for browsing and downloading media from private Telegram groups.

---

## Documents

| File | What it covers |
|------|----------------|
| [01-overview.md](01-overview.md) | What miniGram is, the full system architecture diagram, technology choices, end-to-end request flow, and local vs production environment differences |
| [02-high-level-design.md](02-high-level-design.md) | System components and responsibilities, inter-service communication patterns, data flow diagrams for login / group browse / file download, the rationale for microservices, database design overview, and the security model |
| [03-low-level-design.md](03-low-level-design.md) | Every API endpoint across all services, the full database schema, nginx location block logic, JWT payload and verification flow, Telegram MTProto connection lifecycle, Docker multi-stage build strategy, and Kubernetes resource definitions |
| [04-service-api-gateway.md](04-service-api-gateway.md) | Deep dive into the API gateway: purpose, routing table, path rewriting rules, CORS configuration, timeout configuration for large file streaming, Docker build, docker-compose wiring, and gotchas |
| [05-service-auth.md](05-service-auth.md) | Deep dive into the auth service: application login/register flow, Telegram OTP flow, 2FA handling, JWT signing, bcrypt password hashing, in-memory pending-auth state, and security considerations |
| [06-service-db.md](06-service-db.md) | Deep dive into the db service: why it exists as a separate service, the full PostgreSQL schema, every SQL query, the inline migration strategy, connection pooling, startup ordering, and gotchas |
| [07-service-telegram-read.md](07-service-telegram-read.md) | Deep dive into the telegram-read service: GramJS MTProto connections, session strings, group/channel enumeration, message scanning, in-memory caching, Server-Sent Events (SSE) streaming, and per-user client lifecycle |
| [08-service-telegram-download.md](08-service-telegram-download.md) | Deep dive into the telegram-download service: binary streaming with backpressure, HTTP Range / resume support, per-user Telegram client pool, per-user download queue, download logging, and known limitations |
| [09-service-ui.md](09-service-ui.md) | Deep dive into the Angular UI service: component architecture, auth state machine, JWT interceptor, download flow via anchor-click, group photo loading, SSE progress bars, batch download queue, nginx config, and the multi-stage Docker build |
| [10-infra-local.md](10-infra-local.md) | Local development guide: docker-compose topology, required environment variables, startup ordering, how services reach each other, building images, pushing to DockerHub, and common issues |
| [11-infra-aws.md](11-infra-aws.md) | AWS EKS deployment guide: cluster creation with eksctl, IAM and OIDC setup (including the Pluralsight sandbox workaround), ALB controller installation, Helm chart structure, full deploy sequence, standard redeploy commands, and known AWS issues |
| [12-bugs-and-fixes.md](12-bugs-and-fixes.md) | Every bug encountered with root cause analysis and the fix applied: download corruption from missing `/api/` prefix, nginx buffering, ARM vs amd64 exec format error, Helm 5-minute timeout, OIDC disabled in sandbox, docker login required, and JWT_SECRET missing |

---

## Legacy Document

| File | Note |
|------|------|
| [06-local-docker-setup.md](06-local-docker-setup.md) | Earlier, more detailed walkthrough of the Docker Compose setup written during the EKS deployment phase. Covers ARM vs AMD64, buildx, and the Docker DNS model in depth. Superseded by `10-infra-local.md` for new readers, but retained for its detailed narrative style. |
