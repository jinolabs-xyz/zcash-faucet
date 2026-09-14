# Linux build that mirrors Render's Node runtime. Usable as an alternative
# deploy (Render "Docker" env, Fly, Koyeb, a VM) and for local parity testing.
FROM node:24-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has to compile instead of using a prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# NODE IS PID 1, on purpose (risk register II, R-27). `npm run start` made npm PID 1
# with `sh -c "next start"` under it, and dash (this image's sh) does not exec its
# command, so docker's SIGTERM reached npm, npm forwarded it to sh, sh died, npm exited
# and docker SIGKILLed the orphaned node: the app never saw the signal and the drain in
# src/instrumentation.ts was dead code in production, while passing on a laptop whose
# sh does exec (found by the #529 review, in this image). Exec form, node directly,
# same flags as package.json's start script; the port is fixed here because compose
# sets PORT=3000 and exec form cannot expand an env var.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
