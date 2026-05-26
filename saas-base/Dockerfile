# syntax=docker/dockerfile:1.6

# ─── Stage 1: dependencias de producción ────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# package*.json primero para que Docker cachee este layer cuando el código
# cambia pero las deps no.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: imagen runtime ────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
# Render usa $PORT (10000 por default). Express ya lo lee desde config.
ENV PORT=10000

# Healthcheck necesita curl. Apenas pesa.
RUN apk add --no-cache curl tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
# scripts/ se incluye para tareas admin (crear tenant, resetear password,
# seeds). El .dockerignore filtra los check-*/fix-*/debug-* que son ad-hoc
# locales.
COPY scripts ./scripts

# Usuario sin privilegios — el usuario 'node' viene preconfigurado en la
# imagen oficial de Node.
USER node

EXPOSE 10000

# tini reapea zombies y propaga SIGTERM correctamente a node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
