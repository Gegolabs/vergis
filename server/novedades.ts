/**
 * NOVEDADES (`GET /novedades`, issue #308) — el nodo publica por HTTP el `CHANGELOG.md` que viaja
 * DENTRO de su imagen (`/app/CHANGELOG.md`, issue #229), para que el número de versión del pie del
 * inspector deje de ser un callejón sin salida.
 *
 * Hasta acá, la única forma declarada de leer ese archivo era
 * `docker run --rm --entrypoint cat <imagen> /app/CHANGELOG.md`: acceso de OPERADOR con shell. Un
 * especificador que ve `Vergis v0.31.0` al pie del inspector no tenía ningún camino a «¿qué trae?».
 *
 * Tres propiedades que esta superficie sostiene, y por qué:
 *
 * 1. **«Sin publicar» NUNCA se sirve.** Lo que corre es una versión cortada; mostrar lo que todavía
 *    no se publicó le promete al lector capacidades que su nodo no tiene. El filtro vive en UNA sola
 *    función (`seccionesPublicables`) y el handler no tiene otra puerta al texto.
 * 2. **La versión que corre va primero.** Es la pregunta que trae al lector; el historial va debajo,
 *    con su índice de anclas (`/novedades#<versión>`).
 * 3. **Una versión sin sección no rompe la página.** Si `package.json` va adelante del CHANGELOG
 *    —o si el archivo embarcado es de otro corte—, la página se sirve igual, con el historial
 *    completo y diciendo con esas palabras que la versión que corre no tiene sección.
 *
 * Sin dependencias de render: el markdown del CHANGELOG se convierte con el bloque de abajo
 * (encabezados, párrafos, listas, tablas, citas, reglas, código y los inline de siempre), que es
 * exactamente el subconjunto que este documento usa. Agregar un renderer completo costaría una
 * dependencia nueva en la imagen para ganar sintaxis que el archivo no escribe.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { escapeHtml } from '@vergis/capabilities'
import { PAGE_CSS } from './ui'

// ── Markdown → HTML (el subconjunto que el CHANGELOG escribe) ────────────────────────────────────

// Marcadores de los tramos que NO se re-procesan (código inline). Son caracteres de USO PRIVADO
// (U+E000/U+E001), no bytes de control: un byte de control crudo en la salida es un fenómeno propio
// (W-02) y además rompería el HTML. El CHANGELOG no contiene PUA.
const MARCA_ABRE = ''
const MARCA_CIERRA = ''

/** ¿El destino de un enlace es servible? Solo relativo, `http(s)` y ancla — nada de `javascript:`. */
function hrefSeguro(url: string): string | null {
  const u = url.trim()
  if (u === '') return null
  if (/^(https?:)?\/\//i.test(u)) return u
  if (/^[#/]/.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null // cualquier otro esquema (javascript:, data:, …)
  return u // relativo simple (`docs/capacidades.md`)
}

/**
 * Inline: código, enlaces, negrita y cursiva. El escape va PRIMERO y una sola vez — el resto opera
 * sobre texto ya escapado, así que ningún marcado puede reinyectar HTML.
 */
export function inlineHtml(texto: string): string {
  const guardados: string[] = []
  let t = escapeHtml(texto)
  // (1) Código inline: se guarda tal cual y se saca del camino de los demás reemplazos.
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    guardados.push(`<code>${c}</code>`)
    return `${MARCA_ABRE}${guardados.length - 1}${MARCA_CIERRA}`
  })
  // (2) Enlaces. El texto puede llevar marcado; el destino se valida.
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label: string, url: string) => {
    const href = hrefSeguro(url)
    if (!href) return label
    const externo = /^(https?:)?\/\//i.test(href) ? ' target="_blank" rel="noopener"' : ''
    return `<a href="${href}"${externo}>${label}</a>`
  })
  // (3) Negrita antes que cursiva: `**x**` no debe caer en la regla de un solo asterisco.
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
  // (4) Restitución de los tramos guardados.
  return t.replace(new RegExp(`${MARCA_ABRE}(\\d+)${MARCA_CIERRA}`, 'g'), (_m, i: string) => guardados[Number(i)] ?? '')
}

const esSeparadorDeTabla = (l: string): boolean => /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(l.trim())
const celdas = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/**
 * Markdown → HTML por BLOQUES. Deliberadamente acotado a lo que el CHANGELOG usa: encabezados ATX,
 * párrafos, listas (con o sin número), tablas GFM, citas, reglas y cercas de código.
 *
 * `nivelMin` es el encabezado MÁS ALTO que el cuerpo puede emitir: dentro de una sección de versión
 * —que ya es un `<h2>` de la página— se pasa `3`, así el `###` del documento sale `<h3>` y un `#`
 * suelto no puede saltar por encima del título de su propia sección.
 */
export function mdToHtml(md: string, nivelMin = 1): string {
  const lineas = md.split('\n')
  const out: string[] = []
  let i = 0
  const parrafo: string[] = []
  const cerrarParrafo = (): void => {
    if (!parrafo.length) return
    out.push(`<p>${inlineHtml(parrafo.join(' '))}</p>`)
    parrafo.length = 0
  }
  while (i < lineas.length) {
    const linea = lineas[i]
    const t = linea.trim()
    if (t === '') {
      cerrarParrafo()
      i++
      continue
    }
    // Cerca de código: se emite verbatim (escapado), sin tocar su contenido.
    const cerca = /^```(.*)$/.exec(t)
    if (cerca) {
      cerrarParrafo()
      const cuerpo: string[] = []
      i++
      while (i < lineas.length && !/^```/.test(lineas[i].trim())) cuerpo.push(lineas[i++])
      i++ // la cerca de cierre (o el fin del archivo)
      out.push(`<pre><code>${escapeHtml(cuerpo.join('\n'))}</code></pre>`)
      continue
    }
    const enc = /^(#{1,6})\s+(.*)$/.exec(t)
    if (enc) {
      cerrarParrafo()
      const nivel = Math.min(6, Math.max(enc[1].length, nivelMin))
      out.push(`<h${nivel}>${inlineHtml(enc[2])}</h${nivel}>`)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      cerrarParrafo()
      out.push('<hr>')
      i++
      continue
    }
    // Tabla GFM: encabezado + separador. Sin separador no es tabla (y cae a párrafo).
    if (t.startsWith('|') && i + 1 < lineas.length && esSeparadorDeTabla(lineas[i + 1])) {
      cerrarParrafo()
      const cab = celdas(t)
      i += 2
      const filas: string[][] = []
      while (i < lineas.length && lineas[i].trim().startsWith('|')) filas.push(celdas(lineas[i++]))
      out.push(
        `<table><thead><tr>${cab.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      )
      continue
    }
    // Lista (con o sin número). Las líneas siguientes INDENTADAS continúan el ítem abierto.
    const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t)
    if (item) {
      cerrarParrafo()
      const ordenada = /\d/.test(item[1])
      const items: string[] = []
      while (i < lineas.length) {
        const l = lineas[i]
        const it = /^([-*+]|\d+[.)])\s+(.*)$/.exec(l.trim())
        if (it && (/\d/.test(it[1]) === ordenada || !items.length)) {
          items.push(it[2])
          i++
          continue
        }
        // Continuación: línea indentada y no vacía, con un ítem ya abierto.
        if (items.length && l.trim() !== '' && /^\s+/.test(l)) {
          items[items.length - 1] += ` ${l.trim()}`
          i++
          continue
        }
        break
      }
      const tag = ordenada ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((x) => `<li>${inlineHtml(x)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (t.startsWith('>')) {
      cerrarParrafo()
      const cita: string[] = []
      while (i < lineas.length && lineas[i].trim().startsWith('>')) cita.push(lineas[i++].trim().replace(/^>\s?/, ''))
      out.push(`<blockquote>${mdToHtml(cita.join('\n'), nivelMin)}</blockquote>`)
      continue
    }
    parrafo.push(t)
    i++
  }
  cerrarParrafo()
  return out.join('\n')
}

// ── El CHANGELOG, partido en secciones ───────────────────────────────────────────────────────────

export interface SeccionChangelog {
  /** `X.Y.Z` si el encabezado abre una versión; `null` si la sección es prosa del documento. */
  version: string | null
  /** El encabezado `##` completo, tal cual («0.31.0 — 2026-09-21»). */
  titulo: string
  /** Cuerpo markdown de la sección, sin su encabezado. */
  cuerpo: string
  /** ¿Es la sección de trabajo NO publicado? Se conserva en el parseo para poder medir el filtro. */
  sinPublicar: boolean
}

const RE_VERSION = /^(\d+\.\d+\.\d+)\b/

/**
 * Parte el documento por encabezados `##`. Devuelve TODO lo que hay, «Sin publicar» incluida: el
 * filtro es de `seccionesPublicables`, y separarlos es lo que permite que un test compruebe que la
 * sección prohibida ESTABA en la fuente antes de exigir que no esté en la salida — sin ese control
 * positivo, «no aparece» no distingue «la filtré» de «nunca estuvo».
 */
export function parseChangelog(md: string): SeccionChangelog[] {
  const secciones: SeccionChangelog[] = []
  let actual: SeccionChangelog | null = null
  const cuerpo: string[] = []
  let enCerca = false
  const cerrar = (): void => {
    if (actual) secciones.push({ ...actual, cuerpo: cuerpo.join('\n').trim() })
    cuerpo.length = 0
  }
  for (const linea of md.split('\n')) {
    if (/^```/.test(linea.trim())) enCerca = !enCerca
    const enc = !enCerca && /^##\s+(.*)$/.exec(linea)
    if (enc) {
      cerrar()
      const titulo = enc[1].trim()
      actual = {
        version: RE_VERSION.exec(titulo)?.[1] ?? null,
        titulo,
        cuerpo: '',
        sinPublicar: /^sin\s+publicar\b/i.test(titulo),
      }
      continue
    }
    if (actual) cuerpo.push(linea)
  }
  cerrar()
  return secciones
}

/**
 * LA ÚNICA puerta del texto hacia la página: secciones de VERSIÓN, sin «Sin publicar».
 *
 * Deja fuera también la prosa del documento (el esquema X.Y.Z, la tabla de tags, el cotejo del
 * corte): son el manual de quien CORTA versiones, no las novedades de quien la usa, y mezclarlas
 * sepulta lo que el lector vino a buscar.
 */
export function seccionesPublicables(md: string): SeccionChangelog[] {
  return parseChangelog(md).filter((s) => s.version !== null && !s.sinPublicar)
}

/** Orden de la página: la versión que corre primero, el resto en el orden del documento. */
export function ordenarPorVersionQueCorre(
  secciones: SeccionChangelog[],
  version: string | null,
): { actual: SeccionChangelog | null; historial: SeccionChangelog[] } {
  const actual = version ? (secciones.find((s) => s.version === version) ?? null) : null
  return { actual, historial: secciones.filter((s) => s !== actual) }
}

// ── La página ────────────────────────────────────────────────────────────────────────────────────

/** CSS propio de la página (sobre `PAGE_CSS`, que ya trae tema, tipografía, tablas y el avatar). */
const NOVEDADES_CSS = `
body.nv{max-width:860px;margin:0 auto;padding:44px 28px 64px}
.nv-actual{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:6px 22px 18px;margin:10px 0 26px}
.nv-ver{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:34px 0 4px}
.nv-ver h2{margin:0;font-size:17px;color:var(--fg);text-transform:none;letter-spacing:0}
.nv-actual .nv-ver{margin-top:20px}
.nv-tag{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);border:1px solid var(--accent);border-radius:9px;padding:2px 8px}
.nv-idx{display:flex;flex-wrap:wrap;gap:7px;margin:4px 0 8px;padding:0;list-style:none}
.nv-idx li a{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:3px 9px;color:var(--fg)}
.nv-idx li a:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.nv-body h3{font-size:14.5px;margin:20px 0 6px;color:var(--fg);text-transform:none;letter-spacing:0}
.nv-body h4{font-size:13px;margin:16px 0 5px;color:var(--muted)}
.nv-body p,.nv-body li{font-size:13.5px;line-height:1.62}
.nv-body ul,.nv-body ol{padding-left:22px}
.nv-body blockquote{margin:10px 0;padding:2px 0 2px 14px;border-left:3px solid var(--border);color:var(--muted)}
.nv-body pre{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:11px 13px;overflow-x:auto;font-size:12px}
.nv-body table{font-size:12.5px}
.nv-body hr{border:none;border-top:1px solid var(--border);margin:22px 0}
.nv-nota{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:11px 14px;font-size:13px;color:var(--muted);margin:14px 0 22px}
.nv-foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:11px}`

const seccionHtml = (s: SeccionChangelog, destacada: boolean): string =>
  `<section${destacada ? ' class="nv-actual"' : ''}>` +
  `<div class="nv-ver" id="${escapeHtml(s.version ?? '')}"><h2>${inlineHtml(s.titulo)}</h2>` +
  (destacada ? `<span class="nv-tag">en este nodo</span>` : '') +
  `</div><div class="nv-body">${mdToHtml(s.cuerpo, 3)}</div></section>`

/**
 * La página completa. `version` es la que CORRE (de `package.json`, vía `VERGIS_VERSION`); `null` o
 * una que el CHANGELOG embarcado no tiene se dicen con esas palabras en vez de inventar una sección.
 */
export function novedadesHtml(opts: {
  md: string
  version: string | null
  avatar?: string
  brand?: string
}): string {
  const secciones = seccionesPublicables(opts.md)
  const { actual, historial } = ordenarPorVersionQueCorre(secciones, opts.version)
  const titulo = 'Novedades de Vergis'
  const sub = actual
    ? `Esto trae la versión que corre en este nodo. Más abajo, el historial.`
    : opts.version
      ? `La versión que corre (v${escapeHtml(opts.version)}) no tiene sección en el changelog que viaja en esta imagen. Abajo va el historial completo, sin retoques.`
      : `Este nodo no declara versión. Abajo va el historial completo del changelog que viaja en esta imagen.`
  const indice = secciones.length
    ? `<ul class="nv-idx">${secciones
        .map((s) => `<li><a href="#${escapeHtml(s.version ?? '')}">${escapeHtml(s.version ?? '')}</a></li>`)
        .join('')}</ul>`
    : `<p class="nv-nota">El changelog que viaja en esta imagen no declara ninguna versión publicada.</p>`
  const cuerpo =
    (actual ? seccionHtml(actual, true) : `<p class="nv-nota">${sub}</p>`) +
    (historial.length ? `<h2>Historial</h2>${indice}${historial.map((s) => seccionHtml(s, false)).join('')}` : indice)
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(titulo)}</title>` +
    `<style>${PAGE_CSS}${NOVEDADES_CSS}</style></head><body class="nv">` +
    (opts.avatar ?? '') +
    `<div class="bc">${escapeHtml(opts.brand ?? 'Vergis')}</div>` +
    `<h1>${escapeHtml(titulo)}</h1>` +
    (actual ? `<div class="bc">${sub}</div>` : '') +
    cuerpo +
    `<div class="nv-foot">Powered by Vergis · el changelog viaja dentro de la imagen de este nodo.</div>` +
    `<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();</script>` +
    `</body></html>`
  )
}

// ── El handler ───────────────────────────────────────────────────────────────────────────────────

export interface NovedadesDeps {
  /**
   * El texto del CHANGELOG embarcado, o `null` si no se pudo leer. Se INYECTA (no se resuelve acá)
   * por la misma razón que el resto de las superficies: el layout del contenedor no es el del repo,
   * y un handler que abre archivos por su cuenta no se puede medir con una fixture.
   */
  leerChangelog: () => string | null
  /** La versión que corre (`VERGIS_VERSION`). */
  version: string | null
  /** Avatar de identidad para el marco de la plataforma. */
  avatarFor?: (email: string) => Promise<string>
  identityOf?: (headers: IncomingMessage['headers']) => { user?: string }
  brand?: string
}

/**
 * `GET /novedades`. Autorización: **la del resto del nodo** — el token del gate ya se verificó en el
 * router, y de ahí para adentro es lo mismo que ve el catálogo. No hay rol nuevo: el changelog de la
 * imagen que uno está usando no es superficie de administración.
 *
 * El texto se lee y se parsea UNA vez por proceso: el archivo vive dentro de la imagen y no cambia
 * mientras el proceso vive. Un `SIGHUP` no lo recarga porque no hay nada que recargar.
 */
export function createNovedadesHandler(deps: NovedadesDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  let cache: string | null | undefined
  return async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<p>Las novedades solo se consultan con GET.</p>')
      return true
    }
    if (cache === undefined) cache = deps.leerChangelog()
    if (cache === null) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<p>Las novedades no están disponibles en este nodo: el changelog no viajó en esta imagen.</p>')
      return true
    }
    let avatar = ''
    try {
      const email = (deps.identityOf?.(req.headers).user ?? '').toLowerCase()
      if (deps.avatarFor) avatar = await deps.avatarFor(email)
    } catch (e) {
      // El avatar es marco, no contenido: su fallo no puede costarle la página al lector.
      console.error(`[novedades] avatar no disponible: ${e instanceof Error ? e.message : String(e)}`)
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(novedadesHtml({ md: cache, version: deps.version, avatar, brand: deps.brand }))
    return true
  }
}
