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
# El CHANGELOG viaja DENTRO de la imagen (issue #229). No es documentación de cortesía: es lo único
# que responde «¿qué exige esta versión?» desde la VM, sin salir de ella y sin acceso al repo — que es
# exactamente el momento en que la pregunta aparece, con el `pull` ya hecho. Va al final para no
# invalidar las capas caras de arriba, y pesa lo que pesa un texto.
#   docker run --rm --entrypoint cat <imagen> /app/CHANGELOG.md
COPY CHANGELOG.md ./CHANGELOG.md

# ═══ CONTRATO PÚBLICO DEL ANILLO (issue #210 · I9) ═════════════════════════════════════════════════
#
# Los labels de descripción/licencia/versión (`org.opencontainers.image.*`) los inyecta el workflow de
# build desde la metadata de git — NO se declaran acá, para que no haya dos fuentes del mismo dato.
# Lo que sí es del Dockerfile es el dato que ninguna metadata de git conoce: **qué versión de esquema
# del store embebido soporta el código que va DENTRO de esta imagen**.
#
# ¿Para qué sirve? Para que un conmutador de anillos pueda negarse a un rollback incompatible SIN
# arrancar el candidato: leer un label de una imagen es barato (`docker inspect` / `imagetools`),
# arrancar un nodo no lo es, y un candidato cuyo esquema es más viejo que el del archivo del store no
# debe llegar ni a abrirlo. Es una negativa TEMPRANA, no la única: el gate autoritativo sigue siendo el
# pre-flight de la promoción contra el bloque `control` de `/contrato` (que además reporta época,
# degradación y el store exacto que bloquea). El label descarta antes; el pre-flight decide.
#
#   vergis.schema         — el esquema del store de GOBIERNO (el número del diseño, para el consumidor
#                           que quiere un solo entero).
#   vergis.schema.stores  — el mapa COMPLETO, un store por par `nombre=versión`. En plural a propósito:
#                           una instalación tiene más de un store embebido y un solo número esconde al
#                           que sí bloquea el rollback. Los nombres son los mismos que declara
#                           `/contrato` (`store[].name`).
#
# Estos valores NO se mantienen a mano con la esperanza de acordarse: `tests/imagen-anillo-labels.test.ts`
# los compara contra las constantes `*_SCHEMA_VERSION` del código y contra la lista de stores que el
# server cablea. Si alguien sube una constante y no el label —o agrega un store—, la suite se pone roja.
LABEL vergis.schema="1" \
      vergis.schema.stores="gobierno=1,notas=1,data-maestra=1,evaluaciones=1"

USER node
EXPOSE 8080

# Único server: render POR CONSUMIDOR con RLS (data-anchored). No hay camino de servir sin RLS.
CMD ["node", "dist/serve-rls.mjs"]
