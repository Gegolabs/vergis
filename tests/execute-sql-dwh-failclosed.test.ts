import { describe, it, expect } from 'vitest'
import { createExecuteSqlDwh } from '@vergis/capabilities'

const identity = { sub: 'u1', claims: {} } as unknown as Parameters<ReturnType<typeof createExecuteSqlDwh>['execute']>[1]

/**
 * Fail-closed (issue #66): un perfil cuya credencial no resuelve revienta al construir el provider,
 * ANTES del `connect()` — el test no toca la red (si la tocara, tardaría el connectionTimeout de 30 s
 * y el mensaje sería de red, no del campo faltante).
 */
describe('execute-sql-dwh · fail-closed de credencial', () => {
  it('perfil sin clientSecret → rechaza nombrando el ref y el campo, sin intentar red', async () => {
    const cap = createExecuteSqlDwh({ dwh: { server: 'no-existe.database.windows.net', database: 'db', tenantId: 'T', clientId: 'C' } })
    const t0 = Date.now()
    await expect(cap.execute({ database_ref: 'dwh', sql: 'SELECT 1' }, identity))
      .rejects.toThrow("credencial (database_ref 'dwh'): modo 'secret' requiere clientSecret.")
    expect(Date.now() - t0).toBeLessThan(5_000) // no hubo intento de conexión
  })

  it("perfil con auth desconocido → rechaza nombrando el ref", async () => {
    const cap = createExecuteSqlDwh({ dwh: { server: 's', database: 'db', auth: 'zzz' as never } })
    await expect(cap.execute({ database_ref: 'dwh', sql: 'SELECT 1' }, identity)).rejects.toThrow(/database_ref 'dwh'.*desconocido/)
  })
})
