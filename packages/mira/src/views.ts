// Multi-vista + drill-through (helpers puros) — extraído de mira.ts (NEXT · Ola 3·B).
// Resolución de la VISTA ACTIVA de un spec multi-vista (página por `pageParam`, nav sin destinos de
// drill salvo la activa, pieza-guía si falta el contexto), normalización del `ctx` de navegación y
// utilidades de datasets. Todo PURO y testeable (ver tests/resolve-active-view.test.ts).
import { collectDataRefs, collectDatasetKeys, type MiraControl, type MiraPage, type MiraSpec } from './dsl/validate'
import type { CtxValues, PagesNav } from './mira-types'

/**
 * Resuelve la VISTA ACTIVA de un spec (paso puro, testeable): en multi-vista se elige la página por
 * `pageParam` (default: la 1ª) y se devuelven SOLO sus datasets; en una vista, la pieza + todo `data`.
 * Las páginas-destino de drill (declaran `context`) NO van en la nav por defecto — aparecen "bajo
 * demanda", únicamente cuando son la vista activa. Una vista de detalle alcanzada SIN su contexto
 * (acceso directo, no por drill) devuelve una pieza-guía sin datasets (evita volcar todo).
 */
export function resolveActiveView(
  spec: MiraSpec,
  pageParam: string | undefined,
  ctxValues: CtxValues,
): { activePiece: Record<string, unknown>; pagesNav?: PagesNav; datasetNames: string[]; pageUnknown?: boolean } {
  const isMulti = Array.isArray(spec.pages) && spec.pages.length > 0
  if (!isMulti) {
    return { activePiece: spec.piece as Record<string, unknown>, datasetNames: Object.keys(spec.data) }
  }
  const pages = spec.pages!
  const requested = pageParam != null ? pages.find((p) => p.id === pageParam) : undefined
  const active = requested ?? pages[0]
  // `?page=<id>` con un id que no existe cae en silencio a la 1ª página. Señalamos el fallback para que
  // el caller lo audite (`mira-page-unknown`) en vez de que un enlace roto se vea como navegación normal.
  const pageUnknown = pageParam != null && requested === undefined
  const navPages = pages.filter((p) => !(p.context && p.context.length > 0) || p.id === active.id)
  const pagesNav: PagesNav = { items: navPages.map((p) => ({ id: p.id, title: p.title })), active: active.id }
  const missing = (active.context ?? []).filter((c) => !ctxValues[c])
  if (missing.length > 0) {
    return { activePiece: contextPrompt(active, missing), pagesNav, datasetNames: [], pageUnknown }
  }
  return { activePiece: active.piece, pagesNav, datasetNames: uniqueDatasets(active.piece), pageUnknown }
}

/** ¿El control es multi-select? (`single: false` en el DSL; default single). */
export function isMultiControl(c: MiraControl): boolean {
  return c.single === false
}

/** Normaliza el contexto del drill (`params.ctx`) a un mapa campo→valor(es). Un parámetro repetido en
 *  la URL (control multi-select) llega como arreglo; uno solo, como string (back-compat). */
export function normalizeCtx(raw: unknown): CtxValues {
  if (!raw || typeof raw !== 'object') return {}
  // Object.create(null): un param `__proto__` multi-valor (arreglo) asignado a un objeto literal
  // corrompería el prototipo del mapa. Sin prototipo, `__proto__` es una clave normal.
  const out = Object.create(null) as CtxValues
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const list = v.filter((x) => x != null && x !== '').map(String)
      if (list.length === 1) out[k] = list[0]
      else if (list.length > 1) out[k] = list
    } else if (v != null && v !== '') {
      out[k] = String(v)
    }
  }
  return out
}

/** Primer valor de una entrada de contexto (para consumidores single-value). */
export function asSingle(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** Datasets (sin repetir) que una pieza referencia vía `data.<dataset>...`. */
function uniqueDatasets(piece: Record<string, unknown>): string[] {
  // Une los dos recolectores: referencias `data.<ds>.<campo>` y datasets pelados de agg.dataset /
  // table.data / semaforo.data — así una página cuyo único uso de un dataset es vía `agg.dataset`
  // igual lo recupera (antes salía KPI en 0 / tabla vacía).
  return [...new Set([...collectDataRefs(piece), ...collectDatasetKeys(piece)].map((r) => r.split('.')[0]))]
}

/**
 * Dataset del que cuelga el `watermark_field` de la frescura GLOBAL (`quality.freshness`), o
 * `undefined` si no hay frescura declarada o está en `ignore`. Se recupera siempre para que
 * `checkFreshness` resuelva el watermark aun cuando el dataset viva en otra página (multi-vista).
 */
export function watermarkDatasetOf(spec: MiraSpec): string | undefined {
  const f = (spec.quality as { freshness?: Record<string, unknown> } | undefined)?.freshness
  if (!f || f['source_watermark'] === 'ignore') return undefined
  // `resolvePath` acepta el prefijo `data.` en watermark_field — quitarlo acá también, o un spec
  // con `watermark_field: data.<ds>.<campo>` resolvería 'data' como dataset y el fix no aplicaría.
  const raw = String(f['watermark_field'] ?? '')
  const wf = raw.startsWith('data.') ? raw.slice('data.'.length) : raw
  return wf ? wf.split('.')[0] || undefined : undefined
}

/** Pieza-guía cuando se entra a una vista de detalle sin el contexto requerido (no por drill). */
function contextPrompt(page: MiraPage, missing: string[]): Record<string, unknown> {
  return {
    layout: 'rows',
    elements: [
      {
        markdown_block: {
          content: `### ${page.title}\n\nSelecciona un registro en otra vista para ver su detalle (falta: ${missing.join(', ')}).`,
        },
      },
    ],
  }
}
