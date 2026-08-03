# Build from the monorepo root:
# docker build -f apps/server/Dockerfile -t anagrams-server .
FROM node:22-bookworm-slim AS build
ENV COREPACK_HOME=/tmp/corepack
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
COPY database database
COPY packages/game-engine packages/game-engine
COPY packages/shared-types packages/shared-types
RUN pnpm --filter @anagrams/game-engine build \
 && pnpm --filter @anagrams/shared-types build \
 && pnpm --filter @anagrams/web build \
 && pnpm --filter @anagrams/server build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /workspace
RUN groupadd --system anagrams && useradd --system --gid anagrams --home /nonexistent anagrams
COPY --from=build --chown=anagrams:anagrams /workspace/node_modules ./node_modules
COPY --from=build --chown=anagrams:anagrams /workspace/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=anagrams:anagrams /workspace/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=anagrams:anagrams /workspace/apps/server/dist ./apps/server/dist
COPY --from=build --chown=anagrams:anagrams /workspace/apps/web/dist ./apps/web/dist
COPY --from=build --chown=anagrams:anagrams /workspace/database/migrations ./database/migrations
COPY --from=build --chown=anagrams:anagrams /workspace/packages/game-engine/package.json ./packages/game-engine/package.json
COPY --from=build --chown=anagrams:anagrams /workspace/packages/game-engine/dist ./packages/game-engine/dist
COPY --from=build --chown=anagrams:anagrams /workspace/packages/game-engine/dictionary ./packages/game-engine/dictionary
COPY --from=build --chown=anagrams:anagrams /workspace/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build --chown=anagrams:anagrams /workspace/packages/shared-types/dist ./packages/shared-types/dist
USER anagrams
EXPOSE 3001
CMD ["node", "apps/server/dist/main.js"]
