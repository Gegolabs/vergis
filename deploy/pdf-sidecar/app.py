"""Sidecar HTML→PDF de Vergis (issue #65, TX-09).

Contrato: POST /convert (cuerpo text/html UTF-8, autocontenido) → 200 application/pdf.
GET /healthz → {"ok": true, "weasyprint": "<versión>"}. Errores 400/413/500 en text/plain.
Sin estado, sin disco, sin red saliente: el url_fetcher solo admite data: URIs (los assets
del render de Vergis viajan embebidos); cualquier otra URL se bloquea y WeasyPrint continúa
sin ese recurso (defensa SSRF/file:// fail-closed).
"""
import json
import logging
import os

import weasyprint
from weasyprint import HTML, default_url_fetcher

MAX_BYTES = int(os.environ.get("PDF_MAX_HTML_BYTES", str(20 * 1024 * 1024)))
logging.basicConfig(level=logging.INFO)


def fetcher(url, *args, **kwargs):
    if url.startswith("data:"):
        return default_url_fetcher(url, *args, **kwargs)
    raise ValueError("recurso externo bloqueado: " + url[:120])


def _plain(start_response, status, text):
    body = text.encode("utf-8")
    start_response(status, [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))])
    return [body]


def app(environ, start_response):
    path, method = environ.get("PATH_INFO", ""), environ.get("REQUEST_METHOD", "")
    if path == "/healthz" and method == "GET":
        body = json.dumps({"ok": True, "weasyprint": weasyprint.__version__}).encode()
        start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
        return [body]
    if path == "/convert" and method == "POST":
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return _plain(start_response, "400 Bad Request", "cuerpo vacío: se espera el HTML del documento (text/html).")
        if length > MAX_BYTES:
            return _plain(start_response, "413 Payload Too Large", f"HTML de {length} bytes supera el tope de {MAX_BYTES}.")
        html = environ["wsgi.input"].read(length).decode("utf-8", errors="replace")
        try:
            pdf = HTML(string=html, base_url=None, url_fetcher=fetcher).write_pdf()
        except Exception as e:  # noqa: BLE001 — el borde del servicio reporta, no clasifica
            logging.exception("conversión falló")
            return _plain(start_response, "500 Internal Server Error", f"weasyprint: {e}")
        start_response("200 OK", [("Content-Type", "application/pdf"), ("Content-Length", str(len(pdf)))])
        return [pdf]
    return _plain(start_response, "404 Not Found", "rutas: POST /convert · GET /healthz")
