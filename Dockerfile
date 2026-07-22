# Linux build that mirrors Render's Node runtime. Usable as an alternative
# deploy (Render "Docker" env, Fly, Koyeb, a VM) and for local parity testing.
FROM node:22-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has to compile instead of using a prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# Render/most platforms inject PORT; the start script binds 0.0.0.0:$PORT.
CMD ["npm", "run", "start"]
