// marks-core.mjs — el NÚCLEO del contador de marcas de dato: una sola implementación para la máquina
// del operador y para el contenedor del anillo.
//
// El bloque entre `//#NUCLEO-INICIO` y `//#NUCLEO-FIN` viaja LITERAL al contenedor (`marks ruta` y
// `smoke --marks`), sin los `export`: por eso no importa nada, no usa `process` y corre en el Node de
// la imagen. Dos copias del conteo podrían driftear, y un contador drifteado es exactamente el defecto
// que este instrumento existe para no repetir.
//
// POR QUÉ la marca de dato y no `mark-rect role-mark`: esa clase la emite vega-scenegraph en el `<g>`
// CONTENEDOR del mark — uno por barra en las formas singular y agrupada, donde el número coincidía por
// casualidad, pero uno por CATEGORÍA DEL EJE en la apilada. Un gráfico de 8 barras apiladas devolvía
// `1`. La marca de dato vive en el `<path>`: `aria-roledescription="bar"` (`"point"` en las series).
// Se reporta `contenedores_rect` al lado A PROPÓSITO: verlo diferir es lo que delata la coincidencia.

//#NUCLEO-INICIO
/** Formas de pieza y cuál contador es «el» contador de cada una. */
export const FORMAS = {
  singular: 'bar',
  agrupado: 'bar',
  apilado: 'bar',
  series: 'point',
}

/** Recorta las `<section class="chart">` del documento. No anidan: del inicio al `</section>`. */
export function seccionesChart(html) {
  const out = []
  const marca = '<section class="chart"'
  let i = html.indexOf(marca)
  while (i !== -1) {
    const fin = html.indexOf('</section>', i)
    const cuerpo = fin === -1 ? html.slice(i) : html.slice(i, fin)
    const t = cuerpo.match(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/)
    out.push({ titulo: t ? t[1].trim() : '', html: cuerpo })
    i = html.indexOf(marca, fin === -1 ? html.length : fin)
  }
  return out
}

/** Nº de ocurrencias de una subcadena literal (no regex: los selectores llevan comillas y guiones). */
export function cuenta(txt, aguja) {
  return txt.split(aguja).length - 1
}

/** Todos los contadores de una sección. `marcas` NO se decide acá: lo decide la forma. */
export function contadoresDeSeccion(cuerpo) {
  return {
    bar: cuenta(cuerpo, 'aria-roledescription="bar"'),
    point: cuenta(cuerpo, 'aria-roledescription="point"'),
    contenedores_rect: cuenta(cuerpo, 'mark-rect role-mark'),
    lineas: cuenta(cuerpo, 'mark-line role-mark'),
    simbolos: cuenta(cuerpo, 'mark-symbol role-mark'),
    rotulos: cuenta(cuerpo, 'mark-text role-mark'),
    sigma_role_mark: cuenta(cuerpo, 'role-mark'),
  }
}

/** ¿El documento trae el asidero? Sin ninguno de los dos canales no hay nada que contar. */
export function tieneAsidero(html) {
  return html.includes('aria-roledescription=') || html.includes('role-mark')
}

/** Versión del motor: el pie del render la escribe como `Vergis v<x>` (VERGIS_VERSION_LABEL). */
export function motorDeHtml(html) {
  const m = html.match(/Vergis v([0-9][0-9A-Za-z.+-]*)/)
  return m ? m[1] : null
}

/** Conteo completo de un documento: una fila por sección de gráfico. */
export function medir(html, forma) {
  const canal = forma ? FORMAS[forma] : null
  return seccionesChart(html).map((s, i) => {
    const c = contadoresDeSeccion(s.html)
    return {
      seccion: i + 1,
      titulo: s.titulo,
      forma: forma || null,
      selector: canal ? 'aria-roledescription="' + canal + '"' : null,
      marcas: canal ? c[canal] : null,
      ...c,
    }
  })
}
//#NUCLEO-FIN

/** El núcleo como texto ejecutable en otro proceso (sin `export`). */
export async function nucleoTexto() {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const a = src.indexOf('//#NUCLEO-INICIO')
  const z = src.indexOf('//#NUCLEO-FIN')
  const t = src.slice(a, z).replace(/^export /gm, '')
  if (!t.includes('function medir(')) throw new Error('marks-core: el núcleo salió vacío o incompleto (¿se movieron los marcadores?)')
  return t
}
