import pkg from '../../../package.json' with { type: 'json' }

/**
 * Versión del producto — fuente única: el `package.json` raíz.
 *
 * Se resuelve en BUILD-TIME (el import del JSON queda horneado en el bundle de esbuild
 * y en el módulo bajo tsx/vitest), NO leyendo el filesystem en runtime: el layout del
 * contenedor no coincide con el del repo y un `resolve()` relativo no alcanza el
 * package.json desde `dist/serve-rls.mjs`.
 *
 * Sin fallback silencioso: si el paquete no declarara versión, el valor es `null` y el
 * consumidor muestra la ausencia, jamás un número fantasma.
 */
export const VERGIS_VERSION: string | null = (pkg as { version?: string }).version ?? null

/** Etiqueta del motor para el pie del inspector: versión real o ausencia honesta. */
export const VERGIS_VERSION_LABEL: string = VERGIS_VERSION
  ? `Mira v${VERGIS_VERSION}`
  : 'Mira · versión desconocida'
