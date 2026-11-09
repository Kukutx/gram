FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS builder
ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.21.0
COPY package.json pnpm-lock.yaml .npmrc ./
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM builder AS migrations
CMD ["pnpm", "db:deploy"]

FROM builder AS production-deps
RUN pnpm prune --prod

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime
ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd --system app && useradd --system --gid app app
COPY --from=builder /app/dist ./dist
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
