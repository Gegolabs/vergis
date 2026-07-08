import { describe, it, expect } from 'vitest'
import { configFromEnv } from '../server/config'

const fixedSecret = () => 'SECRET-EFIMERO'

describe('configFromEnv · defaults', () => {
  it('env vacío → defaults sanos', () => {
    const c = configFromEnv({}, fixedSecret)
    expect(c.engine).toBe('clickhouse')
    expect(c.port).toBe(8080)
    expect(c.refreshMs).toBe(0)
    expect(c.dataCacheTtlMs).toBe(0)
    expect(c.interactiveMaxRows).toBeUndefined()
    expect(c.hotReload).toBe(true)
    expect(c.piAclEnabled).toBe(false)
    expect(c.indexTitle).toBe('Productos de Información')
    expect(c.policyPaths).toEqual([])
    expect(c.gateClaims).toEqual({ groups: 'x-forwarded-groups' })
    expect(c.annotationSecret).toEqual({ value: 'SECRET-EFIMERO', ephemeral: true })
  })
})

describe('configFromEnv · validación numérica (cierra el hallazgo NaN)', () => {
  it('PORT no numérico → lanza (antes: listen(NaN))', () => {
    expect(() => configFromEnv({ PORT: 'abc' }, fixedSecret)).toThrow(/PORT/)
  })
  it('VERGIS_INTERACTIVE_MAX_ROWS no numérico → lanza (antes: NaN a Mira)', () => {
    expect(() => configFromEnv({ VERGIS_INTERACTIVE_MAX_ROWS: 'muchas' }, fixedSecret)).toThrow(/INTERACTIVE_MAX_ROWS/)
  })
  it('PORT numérico válido se respeta', () => {
    expect(configFromEnv({ PORT: '9090' }, fixedSecret).port).toBe(9090)
  })
})

describe('configFromEnv · engine, listas, gate y secreto', () => {
  it('engine inválido → lanza', () => {
    expect(() => configFromEnv({ VERGIS_ENGINE: 'postgres' }, fixedSecret)).toThrow(/VERGIS_ENGINE/)
  })
  it('fabric se acepta', () => {
    expect(configFromEnv({ VERGIS_ENGINE: 'fabric' }, fixedSecret).engine).toBe('fabric')
  })
  it('listas coma-separadas se limpian; los grupos se normalizan a minúscula', () => {
    const c = configFromEnv({ VERGIS_ADMIN_SEED: ' a@x.com , b@x.com ,', VERGIS_DEFAULT_STEWARD_GROUPS: 'Analistas, ' }, fixedSecret)
    expect(c.adminSeed).toEqual(['a@x.com', 'b@x.com'])
    expect(c.defaultStewardGroups).toEqual(['analistas'])
  })
  it('VERGIS_GATE_CLAIMS se parsea a claim→header en minúscula', () => {
    const c = configFromEnv({ VERGIS_GATE_CLAIMS: 'viewer_area:X-Forwarded-Area, groups:x-forwarded-groups' }, fixedSecret)
    expect(c.gateClaims).toEqual({ viewer_area: 'x-forwarded-area', groups: 'x-forwarded-groups' })
  })
  it('VERGIS_ANNOTATION_SECRET presente → no efímero', () => {
    const c = configFromEnv({ VERGIS_ANNOTATION_SECRET: 'fijo' }, fixedSecret)
    expect(c.annotationSecret).toEqual({ value: 'fijo', ephemeral: false })
  })
  it('VERGIS_PI_ACL=on enciende la ACL; VERGIS_HOT_RELOAD=0 la apaga', () => {
    expect(configFromEnv({ VERGIS_PI_ACL: 'on' }, fixedSecret).piAclEnabled).toBe(true)
    expect(configFromEnv({ VERGIS_HOT_RELOAD: '0' }, fixedSecret).hotReload).toBe(false)
  })
})
