# Linux build that mirrors Render's Node runtime. Usable as an alternative
# deploy (Render "Docker" env, Fly, Koyeb, a VM) and for local parity testing.
#
# PINNED BY DIGEST, AND THE DIGEST IS WHAT MOVES (risk register II, R-7). A bare
# `node:24-slim` never moved on the box: docker builds from whatever it pulled first,
# redeploy.sh never asked it to pull again, and dependabot preserves tag precision, so a
# 24.x security release produced no PR and no fetch. The digest is the multi-arch INDEX
# (`docker buildx imagetools inspect node:24-slim`), so it resolves on the arm64 laptop
# and the amd64 box alike. dependabot bumps it weekly; a changed digest is a changed
# line, so it is an app-affecting commit and `compose build --pull` fetches it. Both
# stages carry the same digest and the repo suite keeps them equal.
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has to compile instead of using a prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# Render/most platforms inject PORT; the start script binds 0.0.0.0:$PORT.
CMD ["npm", "run", "start"]
