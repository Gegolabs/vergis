import type { Capability } from '@vergis/botler'

/**
 * Stub de `execute-sql-dwh` para v0.1: devuelve filas inline.
 * En QW-04 (Fase 3) se reemplaza por SQL real contra el Fabric SQL endpoint.
 * `__force_fail` permite simular una Capability caída (criterio de aceptación 5).
 */
export const staticData: Capability = {
  name: 'static-data',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { rows?: unknown; __force_fail?: boolean }
    if (p.__force_fail) {
      throw new Error('static-data: fallo forzado (simulación de Capability caída)')
    }
    if (!Array.isArray(p.rows)) {
      throw new Error('static-data: params.rows debe ser un arreglo de filas')
    }
    return { rows: p.rows }
  },
}
