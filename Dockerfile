# Multi-stage build for the AnyHook backend services
# (subscription-management, subscription-connector, webhook-dispatcher).
# All three run from this single image; docker-compose picks the entry
# point per-service via `command:`.

# ---- deps: install full deps (incl. dev) ------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Use npm ci so the lockfile is authoritative and the build is reproducible.
# `npm install` would resolve fresh and could pull in unintended versions.
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: copy sources, prune to production deps ------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Drop devDependencies for a slim runtime image. There's no compile step
# here -- the source is plain JS -- so prune is the only "build".
RUN npm prune --omit=dev

# ---- runner: minimal runtime image, non-root ---------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Drop privileges. The previous image ran node as root, which means a
# container escape (or just a misconfigured volume mount) had full host
# access. The dashboard image already follows this pattern.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --shell /bin/false anyhook

COPY --from=builder --chown=anyhook:nodejs /app/node_modules ./node_modules
COPY --chown=anyhook:nodejs package.json package-lock.json ./
COPY --chown=anyhook:nodejs ./src ./src
COPY --chown=anyhook:nodejs ./migrations ./migrations
# scripts/ is occasionally invoked by ops (npm run kafka:alter-partitions);
# include it so an exec-into-container session can run it.
COPY --chown=anyhook:nodejs ./scripts ./scripts

USER anyhook

# Default command — docker-compose overrides per service. Listed here
# so `docker run` without a command does the right thing for the API.
CMD ["node", "/app/src/subscription-management/index.js"]
