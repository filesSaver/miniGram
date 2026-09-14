# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── Stage 2: Build Angular app ─────────────────────────────────────────────────
# ng build compiles TypeScript → JavaScript and bundles everything into /app/dist
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Stage 3: Serve with nginx ──────────────────────────────────────────────────
# nginx:alpine is ~25MB. It serves static files extremely fast.
# Node is completely absent from this final image.
FROM nginx:alpine

# Copy the compiled Angular output into nginx's default serving directory.
# Angular outputs to dist/<project-name>/browser for Angular 17+.
COPY --from=builder /app/dist/ui/browser /usr/share/nginx/html

# Custom nginx config to support Angular's client-side routing:
# Without this, refreshing /some-route returns 404 because nginx looks
# for a file called "some-route" which doesn't exist.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
