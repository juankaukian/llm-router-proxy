FROM node:20-alpine AS build

WORKDIR /app

RUN npm i -g pnpm

ARG VITE_API_BASE_URL=http://gateway:8080
ARG VITE_GATEWAY_API_KEY=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_GATEWAY_API_KEY=$VITE_GATEWAY_API_KEY

COPY package.json tsconfig.json vite.config.ts eslint.config.js tailwind.config.js postcss.config.cjs index.html ./
COPY src ./src

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
