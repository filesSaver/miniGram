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
EXPOSE 9231
USER node
CMD ["node", "--inspect=0.0.0.0:9231", "server.js"]
