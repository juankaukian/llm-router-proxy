FROM node:20-alpine AS build

WORKDIR /app

RUN npm i -g pnpm

COPY package.json tsconfig.json vitest.config.ts eslint.config.js ./
RUN pnpm install --no-frozen-lockfile

COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY eval ./eval
COPY config ./config
COPY README.md ./README.md

RUN pnpm build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN npm i -g pnpm

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/eval ./eval
COPY --from=build /app/config ./config

EXPOSE 8080
CMD ["node", "dist/src/server.js"]
