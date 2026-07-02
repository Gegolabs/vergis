// Navegación multi-vista de la query string (extraído de serve-rls para testearlo en aislamiento —
// serve-rls tiene efectos de módulo: levanta el server al importarse).

/** Navegación multi-vista de la query: `?page=<id>` + `?ctx.<campo>=<valor>` (drill-through).
 *  Una clave repetida (`?ctx.week=a&ctx.week=b`, control multi-select) se acumula como arreglo. */
export interface NavQuery {
  page?: string
  ctx?: Record<string, string | string[]>
}

/** Extrae page/ctx de la URL. El `ctx` se bindea como parámetro (injection-safe) aguas abajo.
 *  `getAll` acumula los parámetros repetidos (multi-select); con un solo valor queda string simple. */
export function navFromUrl(rawUrl: string): NavQuery {
  const u = new URL(rawUrl, 'http://localhost')
  const ctx: Record<string, string | string[]> = {}
  for (const k of new Set(u.searchParams.keys())) {
    const m = k.match(/^ctx\.(.+)$/)
    if (!m) continue
    const all = u.searchParams.getAll(k)
    ctx[m[1]] = all.length === 1 ? all[0] : all
  }
  return { page: u.searchParams.get('page') ?? undefined, ctx: Object.keys(ctx).length ? ctx : undefined }
}
