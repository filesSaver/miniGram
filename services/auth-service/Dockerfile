# ── Stage 1: Install dependencies ────────────────────────────────────────────
# We use a full Node image here because we need npm.
# node:20-alpine is Alpine Linux — tiny (~5MB base), no bloat.
FROM node:20-alpine AS builder

WORKDIR /app

# Copy ONLY the package files first.
# Docker caches this layer. If package.json hasn't changed, npm install
# is skipped on the next build — saves minutes.
COPY package*.json ./
# bufferutil (telegram dependency) is a native addon — needs python3 + build tools to compile
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev

# Now copy source. This layer busts only when code changes, not dependencies.
COPY . .

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
# Start fresh from the same slim base. No npm, no build cache — just the app.
FROM node:20-alpine

WORKDIR /app

# Copy only what we need from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./

# Document which port this service listens on (informational, not binding)
EXPOSE 3001
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "server.js"]
