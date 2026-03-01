FROM node:20-alpine

WORKDIR /app

RUN npm i -g pnpm

COPY package.json tsconfig.json vitest.config.ts eslint.config.js ./
RUN pnpm install --no-frozen-lockfile

COPY src ./src
COPY test ./test
COPY README.md ./README.md

RUN pnpm build

EXPOSE 8080
CMD ["pnpm", "start"]
