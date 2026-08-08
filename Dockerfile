# Vergis — imagen de despliegue (QW-04). Sirve y regenera el dashboard.
# Multi-stage: el server se compila a dist/ en build-time; la imagen final corre JS precompilado
# (sin tsx) con dependencias SOLO de producción y sin lifecycle scripts (supply chain — ADR-001).

# Base pineada por digest (manifest list multi-arch): Renovate mantiene el digest al día vía `docker:pinDigests` — pendiente de habilitar la app en GitHub (TODO.md:37).
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /app
# Manifests primero → la capa de `npm ci` se cachea y no se invalida al editar código.
COPY package.json package-lock.json .npmrc ./
COPY packages/botler/package.json packages/botler/package.json
COPY packages/capabilities/package.json packages/capabilities/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mira/package.json packages/mira/package.json
COPY packages/miranda/package.json packages/miranda/package.json
COPY packages/policy/package.json packages/policy/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Mismo digest que el stage `build`: Renovate los mantiene sincronizados (ver nota del FROM de arriba).
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    VERGIS_OUT=/tmp/vergis

# Manifests (raíz + workspaces) → npm ci resuelve los workspaces e instala solo producción.
COPY package.json package-lock.json .npmrc ./
COPY packages/botler/package.json packages/botler/package.json
COPY packages/capabilities/package.json packages/capabilities/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mira/package.json packages/mira/package.json
COPY packages/miranda/package.json packages/miranda/package.json
COPY packages/policy/package.json packages/policy/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY schema ./schema
COPY examples ./examples

USER node
EXPOSE 8080

# Único server: render POR CONSUMIDOR con RLS (data-anchored). No hay camino de servir sin RLS.
CMD ["node", "dist/serve-rls.mjs"]
