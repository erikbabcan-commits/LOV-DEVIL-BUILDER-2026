# syntax=docker/dockerfile:1
# LOV-DEVIL backend (Hono + tsx) — behind reverse proxy (Caddy/platform).
# POZOR: NESMIE sa nastaviť NODE_ENV=production — server zámerne blokuje
# public deployment kým nie je auth + durable quotas (guard v server/index.ts).

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM node:26-alpine AS runtime
WORKDIR /app
# IPv6 v Alpine kontajneroch je nespoľahlivé — bind na všetky interfejsy.
ENV BIND=0.0.0.0 PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY scripts/check-cloud-github.ts scripts/link-cloud-identity.ts scripts/ai-usage-report.ts scripts/product-weekly-report.ts scripts/billing-preflight.ts scripts/auth-log-retention.ts ./scripts/
COPY deploy/ops/ai-cost-dashboard.template.html ./deploy/ops/
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8787/api/health || exit 1
CMD ["npx", "tsx", "server/index.ts"]
