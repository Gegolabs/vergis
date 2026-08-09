/**
 * Forma CANÓNICA de una definición de item del motor — la identidad única de «qué se publicó»
 * (issue #107 fase 2, Δ1 del plan del cluster 006).
 *
 * Por qué existe: el hito cero MIDIÓ que el motor Fabric no persiste el payload byte-a-byte. Lo
 * normaliza al guardarlo — los crudos de las dos corridas (comentario del hito cero en #107)
 * muestran dos transformaciones: los strings vacíos (`""`) vuelven como `null`, y el JSON vuelve
 * re-serializado en pretty-print con saltos CRLF. Comparar el sha de los bytes enviados contra el
 * sha de los bytes leídos marcaría «publicación no confiable» (D7) a TODA publicación legítima.
 *
 * La forma canónica, por part:
 *  · se decodifica el base64 a UTF-8;
 *  · si `JSON.parse` da, se normaliza en profundidad (`""` → `null` en valores string, claves de
 *    objeto ordenadas, orden de arreglos intacto) y se re-serializa compacto (sin whitespace, LF);
 *  · si NO parsea como JSON, el payload se compara BYTE A BYTE.
 *
 * CONJETURA ETIQUETADA (no medida): que un payload no-JSON —una part binaria, un `.py` suelto— pase
 * o no por alguna normalización del motor. El hito cero solo ejerció `SparkJobDefinitionV1.json`. No
 * se inventa aquí una normalización que nadie midió: byte-a-byte es el default honesto, y si alguna
 * vez se mide otra cosa, se agrega con sus crudos.
 *
 * El sha canónico es UNA sola identidad para todo el sistema: el del render (H2), el del ledger (H3)
 * y el del read-back (H4) son este mismo.
 */

import { createHash } from 'node:crypto'

/**
 * Lo mínimo que este módulo necesita de una part. Tipo ESTRUCTURAL a propósito (Δ3): no importa
 * `DefinitionPart` de `fabric-authoring.ts` — cualquier objeto con esta forma calza.
 */
export interface CanonicalizablePart {
  path: string
  payloadBase64: string
}

/** Normaliza un valor ya parseado: `""` → `null`, claves de objeto ordenadas, arreglos en su orden. */
function normalizeValue(value: unknown): unknown {
  if (value === '') return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeValue)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalizeValue((value as Record<string, unknown>)[key])
  }
  return out
}

/**
 * Bytes canónicos de UN payload. JSON → re-serialización compacta normalizada; no-JSON → los bytes
 * crudos que el base64 decodifica (byte a byte, sin pasar por UTF-8: decodificar y re-codificar un
 * payload que no es texto válido sería lossy).
 */
function canonicalPayloadBytes(payloadBase64: string): Buffer {
  const raw = Buffer.from(payloadBase64, 'base64')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return raw
  }
  return Buffer.from(JSON.stringify(normalizeValue(parsed)), 'utf8')
}

/** El texto canónico de un payload, para diagnóstico y tests (JSON compacto, o el crudo si no es JSON). */
export function canonicalPayload(payloadBase64: string): string {
  return canonicalPayloadBytes(payloadBase64).toString('utf8')
}

/**
 * sha256 hex de una definición completa. Las parts se ordenan POR PATH (el orden en que vengan es
 * irrelevante: la identidad de una definición no depende de en qué orden se listaron sus partes) y
 * se concatenan como `path + '\n' + payloadCanónico + '\n'`.
 *
 * Dos parts con el mismo `path` son un error: la definición no tendría identidad única.
 */
export function canonicalDefinitionSha256(parts: readonly CanonicalizablePart[]): string {
  const ordenadas = [...parts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const vistas = new Set<string>()
  const hash = createHash('sha256')
  for (const p of ordenadas) {
    if (vistas.has(p.path)) throw new Error(`definición inválida: part duplicada '${p.path}'.`)
    vistas.add(p.path)
    hash.update(`${p.path}\n`, 'utf8')
    hash.update(canonicalPayloadBytes(p.payloadBase64))
    hash.update('\n', 'utf8')
  }
  return hash.digest('hex')
}

/**
 * ¿Son la MISMA definición dos conjuntos de parts? Igualdad de shas canónicos — la pregunta que el
 * read-back de D7 hace contra lo publicado.
 */
export function definitionsEquivalent(a: readonly CanonicalizablePart[], b: readonly CanonicalizablePart[]): boolean {
  return canonicalDefinitionSha256(a) === canonicalDefinitionSha256(b)
}
