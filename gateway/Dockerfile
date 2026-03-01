FROM node:20-alpine AS build

WORKDIR /app

RUN npm i -g pnpm

COPY package.json tsconfig.json vitest.config.ts eslint.config.js ./
RUN pnpm install --no-frozen-lockfile

COPY src ./src
COPY test ./test
COPY README.md ./README.md

RUN pnpm build
RUN pnpm prune --prod

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["dist/src/server.js"]
