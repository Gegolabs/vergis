/**
 * CONVENCIÓN DE PLATAFORMA — el corte as-of en el header del PI (issue #108).
 *
 * Misma posición, mismo formato, en todos los PIs y en todos los themes: la primera línea del bloque
 * `.meta` del header dice a qué momento corresponde el dato. No es configurable por spec: ningún knob
 * elige posición, formato ni presencia. La línea aparece SIEMPRE — cuando la plataforma no sabe el
 * corte lo dice con todas sus letras («corte no disponible»), nunca calla ni rellena con la hora del
 * render (esa hora responde «¿cuándo se dibujó?» cuando el lector pregunta «¿a qué momento
 * corresponde?», y además vuelve no-determinista el HTML de un mismo dato).
 */

import { escapeHtml } from '../markdown'
import type { AsOfDetail } from '../ingestion-observability'

/** El corte as-of ya resuelto por Mira (precedencia watermark → ingesta → nada), listo para pintar. */
export interface AsOfMeta {
  /** ISO del corte (`YYYY-MM-DD` o timestamp completo); null = la plataforma no lo sabe. */
  cutoff: string | null
  /** De dónde salió: marca de agua declarada por el dato, ingesta de la plataforma, o nada. */
  source: 'watermark' | 'ingesta' | 'none'
  /** Detalle por dominio (solo aplica al corte por ingesta). */
  detail?: AsOfDetail[]
}

/** Formato de grano FECHA («4 de agosto de 2026»), es-CL, en UTC (un día es un día). */
export function formatDate(date?: string | Date): string {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return String(date)
  return new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

/** Formato de grano INSTANTE («04 ago 2026, 08:29»), es-CL, en la zona de negocio. */
export function formatDateTime(date?: string | Date): string {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return String(date)
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Santiago',
  }).format(d)
}

/**
 * Etiqueta del corte con el grano que trae el DATO: un `YYYY-MM-DD` es un corte diario y se lee como
 * fecha; un timestamp lleva su hora. El grano jamás lo elige el spec.
 */
export function formatCutoff(cutoff: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? formatDate(cutoff) : formatDateTime(cutoff)
}

const TOOLTIP_WATERMARK = 'Corte declarado por el dato del PI (marca de agua).'
const TOOLTIP_INGESTA = 'Corte garantizado: la ingesta más antigua de los dominios del PI.'
const TOOLTIP_NONE = 'La plataforma no tiene registro del corte de estos datos.'

/** Texto del tooltip nativo (atributo `title`) — sin JS, una línea por dominio cuando aplica. */
export function asOfTooltip(asOf: AsOfMeta): string {
  if (asOf.cutoff == null) return TOOLTIP_NONE
  if (asOf.source === 'watermark') return TOOLTIP_WATERMARK
  const lines = (asOf.detail ?? []).map((d) => `${d.label}: ${formatDateTime(d.lastSuccessAt)}`)
  return [TOOLTIP_INGESTA, ...lines].join('\n')
}

/**
 * El bloque `.meta` del header, idéntico en todos los themes. Devuelve el div completo para que el
 * theme solo decida DÓNDE va (y su CSS, cómo se ve): así los dos themes emiten el mismo markup y el
 * test lo verifica una vez por theme.
 */
export function asOfBlock(asOf?: AsOfMeta): string {
  const a: AsOfMeta = asOf ?? { cutoff: null, source: 'none' }
  const title = escapeHtml(asOfTooltip(a))
  const line =
    a.cutoff == null
      ? `<div class="gen" title="${title}">Datos: corte no disponible</div>`
      : `<div class="date" title="${title}">Datos al ${escapeHtml(formatCutoff(a.cutoff))}</div>`
  return `<div class="meta">${line}</div>`
}
