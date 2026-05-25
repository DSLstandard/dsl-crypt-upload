FROM node:22-alpine AS builder

WORKDIR /app

# Build deps (needed for better-sqlite3 native compilation)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies (frozen lockfile ensures reproducibility)
RUN corepack enable && pnpm install --frozen-lockfile

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc --noEmit && npx tsc

# ── Runtime image ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# dumb-init ensures proper signal handling (PID 1)
RUN apk add --no-cache dumb-init

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Data directory — mounted as a volume in docker-compose.
RUN mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main-production.js", "/app/config.json"]
