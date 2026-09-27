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
COPY apps/proposal-renderer/package.json apps/proposal-renderer/package.json
RUN npm ci --workspace @atendon/backend --include-workspace-root

FROM dependencies AS build
COPY apps/proposal-renderer/tsconfig.json apps/proposal-renderer/tsconfig.json
COPY apps/proposal-renderer/scripts apps/proposal-renderer/scripts
COPY apps/proposal-renderer/src apps/proposal-renderer/src
RUN npm run build -w @atendon/proposal-renderer \
    && npm run build -w @atendon/backend \
    && npm prune --omit=dev --workspace @atendon/backend --include-workspace-root

FROM node:22-bookworm-slim AS runtime
# Chromium p/ render de PDF das propostas (playwright baixa o build exato que o
# playwright-core 1.61 espera) + ffmpeg para mídia de conversas.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && npm install --global npm@12.0.1 \
    && npx -y playwright@1.61.1 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json changelog.json ./
COPY --chown=node:node apps/backend/package.json apps/backend/package.json
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/backend/dist apps/backend/dist
COPY --chown=node:node apps/backend/src/db/migrations apps/backend/dist/db/migrations
COPY --chown=node:node --from=build /app/apps/proposal-renderer/dist apps/proposal-renderer/dist
COPY --chown=node:node apps/proposal-renderer/package.json apps/proposal-renderer/package.json
COPY --chown=node:node apps/proposal-renderer/assets apps/proposal-renderer/assets
# O symlink do workspace não sobrevive ao COPY: recria @atendon/proposal-renderer
# apontando para o diretório real dentro da imagem.
RUN mkdir -p node_modules/@atendon \
    && ln -sfn ../../apps/proposal-renderer node_modules/@atendon/proposal-renderer
USER node
EXPOSE 3110
CMD ["node", "--enable-source-maps", "apps/backend/dist/server.js"]
