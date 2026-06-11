# Vergis — imagen de despliegue (QW-04). Sirve y regenera el dashboard.
# Multi-stage: el server se compila a dist/ en build-time; la imagen final corre JS precompilado
# (sin tsx) con dependencias SOLO de producción y sin lifecycle scripts (supply chain — ADR-001).

FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npm run build

FROM node:22-slim
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
COPY packages/policy/package.json packages/policy/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY schema ./schema
COPY examples ./examples

USER node
EXPOSE 8080

# Único server: render POR CONSUMIDOR con RLS (data-anchored). No hay camino de servir sin RLS.
CMD ["node", "dist/serve-rls.mjs"]
