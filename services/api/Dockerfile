# The API, built for a deployment rather than a laptop (Phase 16).
#
# Multi-stage: the build stage installs everything and compiles
# TypeScript; the runtime stage gets the result with the development
# dependencies pruned away, so no compiler, no test runner and no
# Playwright ship to production.
#
# Why it copies the whole workspace rather than deploying one package
# out of it: pnpm links workspace packages by symlink, and this repo's
# shared packages are consumed as TypeScript source. Copying the tree
# with those links intact is boring and works; extracting one package
# is clever and breaks the day someone adds a runtime import to a
# shared package.
#
# Build from the repo root:
#   docker build -f services/api/Dockerfile -t fintech-network-api .

FROM node:22-alpine AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first, so editing source code doesn't invalidate the
# dependency layer. This is most of what makes a rebuild quick.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/design-system/package.json packages/design-system/
COPY packages/app-kit/package.json packages/app-kit/
COPY apps/web-consumer/package.json apps/web-consumer/
COPY apps/web-merchant/package.json apps/web-merchant/
COPY apps/web-admin/package.json apps/web-admin/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @fintech-network/api build \
 && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# A managed PostgreSQL on AWS presents a certificate signed by Amazon's
# RDS authority, which isn't in Node's built-in list. Adding it lets the
# connection be verified (sslmode=verify-full) rather than merely
# encrypted to whoever answered. It changes nothing for a database that
# doesn't use TLS, such as the one in docker-compose.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/services/api
# Node's own unprivileged user. A process that never writes to its own
# image has no business running as root.
USER node

EXPOSE 3000
# Liveness, not readiness: this asks whether the process is alive. An
# orchestrator restarting every instance over a database blip is the
# failure mode that distinction exists to avoid (docs/deployment).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are applied by the deploy, not by the process starting —
# see docs/deployment/README.md. Running them here would mean every
# replica racing to migrate the same database at once.
CMD ["node", "dist/index.js"]
