// Publicación ATÓMICA de data maestra (NEXT · Ola 2·1): el plan construye y puebla una `__replica_new`
// y solo cuando está lista hace el swap (drop de la vieja + sp_rename). Antes se hacía DROP TABLE de la
// réplica VIVA y luego el INSERT fila-a-fila → un fallo a mitad la destruía para todos los consumidores.
// El plan es PURO (sin motor): se verifica la secuencia y los tipos NVARCHAR. La ejecución contra Fabric
// (sp_rename, SECURITY POLICY) se verifica en vivo.
import { describe, it, expect } from 'vitest'
import { masterDataPublishPlan, replicaTable, replicaStagingTable, parseMasterDataConfig } from '@vergis/capabilities'

const [entity] = parseMasterDataConfig({
  entities: [
    {
      id: 'empresas',
      label: 'Empresas',
      database_ref: 'mira',
      table: 'dbo.md_empresas',
      columns: [
        { name: 'rut', label: 'RUT', type: 'string', pk: true },
        { name: 'nombre', label: 'Nombre', type: 'string' },
        { name: 'activo', label: 'Activo', type: 'bool' },
      ],
    },
  ],
})

describe('masterDataPublishPlan · staging + swap', () => {
  it('la staging es __replica_new; la viva __replica', () => {
    expect(replicaTable(entity)).toBe('dbo.md_empresas__replica')
    expect(replicaStagingTable(entity)).toBe('dbo.md_empresas__replica_new')
  })

  it('buildStaging construye la staging con NVARCHAR (no VARCHAR) para preservar acentos', () => {
    const plan = masterDataPublishPlan(entity)
    expect(plan.buildStaging[0]).toBe('DROP TABLE IF EXISTS dbo.md_empresas__replica_new;')
    expect(plan.buildStaging[1]).toContain('CREATE TABLE dbo.md_empresas__replica_new')
    expect(plan.buildStaging[1]).toContain('rut NVARCHAR(400)')
    expect(plan.buildStaging[1]).not.toMatch(/[^N]VARCHAR\(400\)/) // Unicode: NVARCHAR, nunca VARCHAR pelado
    expect(plan.buildStaging[1]).toContain('activo BIT')
  })

  it('swap: DROP policy/fn/tabla vieja → sp_rename staging→viva → recrea policy sobre la viva', () => {
    const plan = masterDataPublishPlan(entity, ['sp_consumer'])
    expect(plan.swap[0]).toBe('DROP SECURITY POLICY IF EXISTS [dbo].[secpol_md_empresas__replica];')
    expect(plan.swap[1]).toBe('DROP FUNCTION IF EXISTS [dbo].[fn_pol_md_empresas__replica];')
    expect(plan.swap[2]).toBe('DROP TABLE IF EXISTS dbo.md_empresas__replica;')
    expect(plan.swap[3]).toBe("EXEC sp_rename 'dbo.md_empresas__replica_new', 'md_empresas__replica';")
    expect(plan.swap[4]).toContain('CREATE FUNCTION [dbo].[fn_pol_md_empresas__replica](@c NVARCHAR(400))')
    expect(plan.swap[5]).toContain('CREATE SECURITY POLICY [dbo].[secpol_md_empresas__replica]')
    expect(plan.swap[5]).toContain('(rut) ON dbo.md_empresas__replica') // predicado sobre la PK, tabla viva
    expect(plan.swap[6]).toBe('GRANT SELECT ON dbo.md_empresas__replica TO [sp_consumer];')
  })

  it('el DROP de la tabla viva ocurre en el SWAP (tras la staging), no antes de tener los datos', () => {
    const plan = masterDataPublishPlan(entity)
    // Ninguna sentencia de buildStaging toca la réplica viva.
    expect(plan.buildStaging.some((s) => /\bmd_empresas__replica\b(?!_new)/.test(s))).toBe(false)
    // El sp_rename (swap) es lo que promueve la staging a viva.
    expect(plan.swap.some((s) => s.includes('sp_rename'))).toBe(true)
  })
})
