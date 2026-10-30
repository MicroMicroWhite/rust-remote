ARG BUN_IMAGE=oven/bun:1.3.14-alpine
ARG NGINX_IMAGE=nginx:alpine
ARG TUNNEL_HOSTNAME
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
FROM ${NGINX_IMAGE}
ARG TUNNEL_HOSTNAME
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY proxy_params_remote /etc/nginx/proxy_params_remote
RUN sed -i "s/__TUNNEL_HOSTNAME__/${TUNNEL_HOSTNAME}/g" /etc/nginx/conf.d/default.conf
EXPOSE 80
