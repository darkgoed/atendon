# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
RUN npm install --global npm@12.0.1
WORKDIR /app
# xlsx 0.20.x só existe no CDN da SheetJS (tarball remoto); o npm 12 bloqueia
# remotes por padrão (allow-remote=none). "root" libera apenas URLs declaradas
# no package.json do projeto.
ENV NPM_CONFIG_ALLOW_REMOTE=root
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/panel/package.json apps/panel/package.json
RUN npm ci --workspace @atendon/panel --include-workspace-root

FROM dependencies AS build
ARG BACKEND_URL=http://atendon-api:3110
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV BACKEND_URL=${BACKEND_URL}
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
COPY apps/panel apps/panel
RUN npm run build:ci -w @atendon/panel

FROM node:22-bookworm-slim AS runtime
RUN npm install --global npm@12.0.1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3200
WORKDIR /app
COPY --chown=node:node --from=build /app/apps/panel/.next/standalone ./
COPY --chown=node:node --from=build /app/apps/panel/.next/static ./apps/panel/.next/static
COPY --chown=node:node --from=build /app/apps/panel/public ./apps/panel/public
USER node
EXPOSE 3200
CMD ["node", "apps/panel/server.js"]
