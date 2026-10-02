# One image for all three front ends (Phase 16). Which one is built is a
# build argument, because they differ in their entry point and nothing
# else: same toolchain, same design system, same output shape.
#
#   docker build -f apps/Dockerfile --build-arg APP=web-consumer -t fn-consumer .
#
# The result is static files behind nginx. These apps have no server of
# their own — they call /api, which nginx forwards — so there is no Node
# process in the final image at all.

FROM node:22-alpine AS build
ARG APP=web-consumer
ARG VITE_APP_NAME="FinTech Network"
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV VITE_APP_NAME=$VITE_APP_NAME
RUN corepack enable

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
RUN pnpm --filter "$APP" build && cp -r "apps/$APP/dist" /dist

FROM nginx:1.27-alpine AS runtime
# The nginx image runs envsubst over anything in templates/ at start-up,
# so where the API lives is set per environment rather than baked in.
ENV API_UPSTREAM=http://api:3000
COPY --from=build /dist /usr/share/nginx/html
COPY infra/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
