# Sidecar HTML→PDF de Vergis (WeasyPrint) — issue #65. Autocontenido: se construye desde este
# directorio, sin heredar imágenes de otras instancias. Multi-arch (amd64/arm64 vía base oficial).
# Sin red saliente en runtime: el HTML llega autocontenido y el url_fetcher bloquea todo salvo data:.
FROM python:3.12-slim-bookworm

# Librerías nativas de WeasyPrint (pango/harfbuzz) + fuentes offline: DejaVu (cobertura) y
# Liberation (sans métricamente compatible con Arial — el stack del theme termina en sans-serif).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 \
      shared-mime-info fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir weasyprint==63.1 gunicorn==23.0.0

RUN useradd --system --uid 10001 --no-create-home pdf
WORKDIR /srv
COPY app.py .
USER pdf
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:9090/healthz', timeout=4)"]
# --timeout mata un render colgado y recicla el worker (backstop del timeout del cliente Vergis).
CMD ["gunicorn", "--bind=0.0.0.0:9090", "--workers=2", "--timeout=60", "--access-logfile=-", "app:app"]
