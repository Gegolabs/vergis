/**
 * Cliente del SIDECAR HTML→PDF y las piezas puras del endpoint `/<slug>/pdf` (issue #65).
 *
 * Módulo deliberadamente PURO y sin dependencias del serving: se testea en aislamiento (serve-rls
 * tiene efectos de módulo — levanta el servidor al importarse). El contrato con el sidecar es
 * mínimo: un HTML entra por `POST /convert`, un PDF sale. La seguridad no vive acá: el HTML ya nació
 * RLS-filtrado bajo la identidad del solicitante, y al sidecar solo lo alcanza la red interna del
 * compose.
 */

/**
 * El servicio de conversión no respondió (conexión rechazada, timeout, o status ≠ 200). Es un fallo
 * de DISPONIBILIDAD, no del render: la ruta lo traduce a un 503 con mensaje en español, y `detail`
 * (URL del sidecar, status, causa) va al log del servidor — jamás al consumidor.
 */
export class PdfUnavailableError extends Error {
  readonly detail: string
  constructor(detail: string) {
    super(`Servicio de conversión PDF no disponible: ${detail}`)
    this.name = 'PdfUnavailableError'
    this.detail = detail
  }
}

/** Slug de plataforma: minúsculas, sin caracteres fuera de `[\wÀ-ÿ -]`, espacios → `-`. */
function slug(s: unknown): string {
  return String(s == null ? '' : s)
    .trim()
    .replace(/[^\wÀ-ÿ -]+/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

/**
 * Nombre del archivo descargado (issue #65 · D10) — la MISMA gramática del CSV (#61 · D7):
 * `<doc>[--<página>]--YYYY-MM-DD[--filtrado].pdf`.
 *
 * El título identifica el PI; el segmento de página aparece solo en PI multi-vista (identifica QUÉ
 * vista congela el PDF) y se omite si es vacío o igual al slug del título; la fecha ancla la foto; el
 * sufijo `--filtrado` avisa que el documento NO es el completo. Separador `--` porque los slugs
 * internos ya usan `-`.
 */
export function pdfFilename(docTitle: string, page: string | undefined, dateISO: string, filtered: boolean): string {
  const base = slug(docTitle) || 'documento'
  const vista = slug(page)
  const mid = vista && vista !== base ? '--' + vista : ''
  return base + mid + '--' + dateISO + (filtered ? '--filtrado' : '') + '.pdf'
}

/**
 * Cabecera `Content-Disposition` de la descarga: fallback ASCII para clientes viejos + `filename*`
 * RFC 5987 con el nombre real. Los slugs conservan acentos (`À-ÿ`), que no son ASCII: sin el par, un
 * nombre con tildes llega mutilado o rompe el parser de la cabecera.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'documento.pdf'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Cliente del sidecar: HTML (UTF-8, autocontenido) → bytes del PDF. Sin dependencias npm — el `fetch`
 * global de Node 22 y `AbortSignal.timeout` bastan. TODO fallo de red, timeout o status ≠ 200 sale
 * como `PdfUnavailableError`: el llamador nunca tiene que clasificar excepciones de `fetch`.
 */
export function createPdfClient(opts: { serviceUrl: string; timeoutMs: number }): (html: string) => Promise<Uint8Array> {
  const url = opts.serviceUrl.replace(/\/$/, '') + '/convert'
  return async (html: string): Promise<Uint8Array> => {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: html,
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch (e) {
      throw new PdfUnavailableError(`POST ${url} falló: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    }
    if (!res.ok) {
      // Los primeros bytes del cuerpo son el diagnóstico útil del sidecar (`weasyprint: …`); se
      // recortan porque un stack completo no aporta al log y sí lo inunda.
      const body = await res.text().catch(() => '')
      throw new PdfUnavailableError(`POST ${url} respondió ${res.status}: ${body.slice(0, 300)}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}
