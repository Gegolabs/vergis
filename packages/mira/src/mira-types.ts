// Tipos compartidos de Mira — extraídos de mira.ts (NEXT · Ola 3·B).
// Módulo NEUTRAL: lo importan tanto mira.ts (la clase MiraBotlet) como los helpers extraídos
// (views, controls) sin crear ciclo de imports.

/** Contexto de navegación (drill/controles): un valor por clave, o VARIOS (control multi-select). */
export type CtxValues = Record<string, string | string[]>

/** Barra de navegación de un PI multi-vista (páginas navegables + la activa). */
export interface PagesNav {
  items: { id: string; title: string }[]
  active: string
}

/** Control de cabecera ya resuelto: opciones + valor(es) seleccionado(s). Viaja al render. */
export interface ControlResolved {
  id: string
  /**
   * Clave de contexto que este control FIJA (default = `id`). Dos controles con el mismo `param` son
   * llaves alternativas del MISMO alcance: eligen por campos distintos, escriben el mismo `ctx.<param>`.
   */
  param?: string
  label: string
  /**
   * Opciones del selector: pares `{value, label}` (`value` = la llave que se escribe en `ctx.<param>`,
   * `label` = el texto que se ve). El render tolera también `string[]` (label = value) por compat.
   */
  options: (string | { value: string; label: string })[]
  /** Valor VIGENTE (la llave; multi: los valores unidos por ", "). */
  value: string
  /** Etiqueta del valor vigente para el print/summary (default = `value`). */
  displayLabel?: string
  /** Solo multi-select: los valores seleccionados. */
  values?: string[]
  /** `true` si el control es multi-select (`single: false` en el DSL). */
  multi?: boolean
}
