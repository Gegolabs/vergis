import { readFileSync } from 'node:fs'
import type { IdentityClaimStore, IdentityReconcileEntry, IdentityReconcileResult } from './governance-store'

/**
 * Import del mapa identidad→claims DESDE EL ARCHIVO desplegado hacia el store de gobierno (#159).
 *
 * Es el camino de migración: una instancia viva sirve hoy su trust-base desde el JSON que apunta
 * `VERGIS_IDENTITY_MAP`, y tiene que poder pasarlo al store SIN perder una sola entrada. Vive en su
 * propio módulo —y no en el store— porque es lo único de esta pieza que toca el sistema de archivos:
 * el store se prueba y se usa sin saber que existe un archivo.
 *
 * Todo lo importado entra como `autoritativa`: el archivo NO declara procedencia, y suponerle
 * `override` a una entrada por venir del archivo inventaría una excepción que nadie inscribió.
 */

/** El formato del archivo: `{ email → { claim: valor(es) } }` — el mismo que hoy lee el resolver. */
export type IdentityMapFile = Record<string, Record<string, string | string[]>>

export interface IdentityMapImportResult extends IdentityReconcileResult {
  /** Entradas legibles que el archivo traía (antes de aplicar). */
  leidas: number
  /**
   * Claves del archivo que NO son una entrada válida (sin email, o con un valor que no es un objeto
   * de claims). Se REPORTAN y no se importan: fabricarles claims sería inventar autorización, y
   * dejarlas mudas escondería que el archivo tenía basura.
   */
  invalidas: string[]
}

/** Parsea el JSON del archivo a entradas de reconciliación. Lanza si el JSON no es un objeto. */
export function parseIdentityMapFile(text: string): { entries: IdentityReconcileEntry[]; invalidas: string[] } {
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('El mapa de identidad debe ser un objeto { email: { claim: valor(es) } }.')
  }
  const entries: IdentityReconcileEntry[] = []
  const invalidas: string[] = []
  for (const [email, claims] of Object.entries(raw as Record<string, unknown>)) {
    if (!email.trim() || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
      invalidas.push(email)
      continue
    }
    // Una entrada del archivo SIN claims se importa igual: es «se reconcilió y no resolvió», un
    // estado distinto de «no hay entrada» — y el store existe justamente para poder distinguirlos.
    entries.push({ email, claims: claims as Record<string, string | string[]> })
  }
  return { entries, invalidas }
}

/**
 * Carga un mapa ya parseado al store como `autoritativa`, preservando los overrides humanos (usa
 * `reconcileIdentityClaims`, que es el contrato del hito): importar es reconciliar contra la fuente
 * que hoy manda —el archivo—, no agregar entradas sueltas encima de lo que hubiera.
 */
export async function importIdentityMap(
  store: IdentityClaimStore,
  map: IdentityMapFile,
  opts: { updatedBy?: string } = {},
): Promise<IdentityMapImportResult> {
  const entries: IdentityReconcileEntry[] = Object.entries(map).map(([email, claims]) => ({ email, claims }))
  const res = await store.reconcileIdentityClaims(entries, { updatedBy: opts.updatedBy ?? 'import:VERGIS_IDENTITY_MAP' })
  return { ...res, leidas: entries.length, invalidas: [] }
}

/** Lee el archivo de `VERGIS_IDENTITY_MAP` y lo carga al store. Lanza si el archivo no existe o no parsea. */
export async function importIdentityMapFile(
  store: IdentityClaimStore,
  file: string,
  opts: { updatedBy?: string } = {},
): Promise<IdentityMapImportResult> {
  const { entries, invalidas } = parseIdentityMapFile(readFileSync(file, 'utf8'))
  const res = await store.reconcileIdentityClaims(entries, { updatedBy: opts.updatedBy ?? `import:${file}` })
  return { ...res, leidas: entries.length, invalidas }
}
