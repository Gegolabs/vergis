/**
 * Tipos de `lib.mjs` — el núcleo puro del arnés de carga.
 *
 * El arnés es JavaScript por contrato del brief (Node ≥ 22, **sin dependencias**, corre en el host
 * sin build). Este archivo existe solo para que `tests/carga-arnes.test.ts` —que sí es TypeScript y
 * sí pasa por `npm run typecheck`— pueda importarlo con tipos en vez de con `any`.
 */

export declare const CLASES_DAFTAR: readonly string[]
export declare const CLASES_MIRA: readonly string[]
export declare const CLASES_ESCRITURA: ReadonlySet<string>

export interface Juicio {
  ok: boolean
  motivo: string | null
}

export declare function juzgar(clase: string, status: number, texto: string | null, invariante?: string | null): Juicio
export declare function motivoDeFalloDeRed(err: unknown): string
export declare function familiaDeMotivo(motivo: string | null | undefined): string
export declare function percentil(valores: readonly number[], p: number): number | null

export interface ResumenClase {
  n: number
  ok: number
  mal: number
  sinmedir: number
  p50: number | null
  p95: number | null
  p99: number | null
  p100: number | null
  errores: Record<string, number>
  rps: number | null
  tasaMal: number | null
}

export interface ResumenEscalon {
  escalon: number
  vu: number | null
  clases: (ResumenClase & { clase: string })[]
  total: ResumenClase
}

export interface Resumen {
  preambulo: Record<string, unknown> | null
  escalones: ResumenEscalon[]
  reverificacion: Record<string, unknown> | null
  stats: Record<string, unknown>[]
  warmupDescartado: number
}

export declare function resumir(registros: readonly Record<string, unknown>[]): Resumen
export declare function violaUmbral(
  resumenEscalon: ResumenEscalon,
  p95Max: number | null,
  clasesUmbral?: ReadonlySet<string> | null,
): { viola: boolean; causas: string[] }
export declare function juzgarControlNegativo(esperado: string, registros: readonly Record<string, unknown>[]): { ok: boolean; detalle: string }
export declare function compararProgreso(
  enviado: Record<string, unknown>,
  releido: Record<string, unknown> | null | undefined,
): { igual: boolean; diferencias: string[]; agregadas: string[] }
export declare function parsearCrudo(texto: string): { registros: Record<string, unknown>[]; rotas: number[] }
