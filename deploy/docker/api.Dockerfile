# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
RUN npm install --global npm@12.0.1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/panel/package.json apps/panel/package.json
RUN npm ci --workspace @atendon/backend --include-workspace-root

FROM dependencies AS build
COPY apps/backend/tsconfig.json apps/backend/tsconfig.build.json apps/backend/
COPY apps/backend/src apps/backend/src
RUN npm run build -w @atendon/backend \
    && npm prune --omit=dev --workspace @atendon/backend --include-workspace-root

FROM node:22-bookworm-slim AS runtime
RUN npm install --global npm@12.0.1
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json changelog.json ./
COPY --chown=node:node apps/backend/package.json apps/backend/package.json
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/apps/backend/dist apps/backend/dist
USER node
EXPOSE 3110
CMD ["node", "--enable-source-maps", "apps/backend/dist/server.js"]
