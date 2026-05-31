# Vergis — imagen de despliegue (QW-04). Sirve y regenera el dashboard.
FROM node:22-slim
WORKDIR /app

# Dependencias (incluye dev: tsx/vega/mssql se usan en runtime vía tsx).
# node_modules y artefactos quedan excluidos por .dockerignore → npm ci instala limpio.
COPY . .
RUN npm ci

ENV NODE_ENV=production \
    PORT=8080 \
    VERGIS_OUT=/tmp/vergis
EXPOSE 8080

# VERGIS_RLS=1 → server con render por-consumidor (RLS); si no, el server estático clásico.
CMD ["sh", "-c", "if [ \"$VERGIS_RLS\" = \"1\" ]; then exec npx tsx server/serve-rls.ts; else exec npx tsx server/serve.ts; fi"]
