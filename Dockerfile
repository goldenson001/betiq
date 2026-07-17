# ─────────────────────────────────────────────────────────────────────────────
# BetIQ — multi-stage Dockerfile
#   1. deps    — install production deps
#   2. builder — compile Next.js standalone output + generate Prisma client
#   3. runner  — minimal runtime image
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json bun.lock* package-lock.json* yarn.lock* ./
# Install with npm (fallback) — bun.lock is supported too if bun is installed
RUN if [ -f bun.lock ]; then \
      npm install -g bun && bun install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client (needs schema)
RUN npx prisma generate
# Build Next.js standalone output
RUN npm run build

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl tini

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV TZ=Europe/Brussels

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# Copy standalone Next.js output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Copy Prisma schema + migrations so we can `prisma db push` on boot
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Persistent volume for SQLite (ignored when DATABASE_URL points to PostgreSQL)
RUN mkdir -p /app/db && chown -R nextjs:nodejs /app/db
VOLUME ["/app/db"]

USER nextjs
EXPOSE 3000

# tini handles signals properly for the scheduler's setInterval
ENTRYPOINT ["/sbin/tini", "--"]

# Apply schema (idempotent) then boot Next.js
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
