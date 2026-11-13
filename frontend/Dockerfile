# Web image: Caddy serving the built UI. The Caddyfile is mounted at runtime
# (deploy/Caddyfile), so the same image works for local, staging and production.
FROM docker.io/library/node:22.23.5-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM docker.io/library/caddy:2.11.9-alpine
COPY --from=build /src/dist /srv
