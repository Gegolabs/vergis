import { describe, it, expect } from 'vitest'
import { configFromEnv, decideDevIdentity, decideFreshStore, deprecatedEnvWarnings, hasFreshFlag, parseDevIdentity } from '../server/config'

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
    expect(c.csrfSecret).toEqual({ value: 'SECRET-EFIMERO', ephemeral: true })
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
  it('VERGIS_CSRF_SECRET presente → no efímero', () => {
    const c = configFromEnv({ VERGIS_CSRF_SECRET: 'fijo' }, fixedSecret)
    expect(c.csrfSecret).toEqual({ value: 'fijo', ephemeral: false })
  })
  it('VERGIS_ANNOTATION_SECRET quedó DEPRECADO: no fija el CSRF y produce aviso (sin su valor)', () => {
    const c = configFromEnv({ VERGIS_ANNOTATION_SECRET: 'viejo' }, fixedSecret)
    expect(c.csrfSecret).toEqual({ value: 'SECRET-EFIMERO', ephemeral: true })
    const warns = deprecatedEnvWarnings({ VERGIS_ANNOTATION_SECRET: 'viejo' })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/DEPRECADO/)
    expect(warns[0]).not.toContain('viejo')
  })
  it('los envs del store viejo de anotaciones también avisan; un entorno limpio no avisa', () => {
    expect(deprecatedEnvWarnings({ VERGIS_ANNOTATIONS_DB: '/x/a.sqlite' })).toHaveLength(1)
    expect(deprecatedEnvWarnings({ VERGIS_ANNOTATIONS_URL: 'postgres://x' })).toHaveLength(1)
    expect(deprecatedEnvWarnings({})).toEqual([])
  })
  it('VERGIS_PI_ACL=on enciende la ACL; VERGIS_HOT_RELOAD=0 la apaga', () => {
    expect(configFromEnv({ VERGIS_PI_ACL: 'on' }, fixedSecret).piAclEnabled).toBe(true)
    expect(configFromEnv({ VERGIS_HOT_RELOAD: '0' }, fixedSecret).hotReload).toBe(false)
  })
})

describe('parseDevIdentity · email o email:grupos', () => {
  it('solo email → user sin claims', () => {
    expect(parseDevIdentity('ana@x.com')).toEqual({ user: 'ana@x.com', claims: {} })
  })
  it('email:grupos → claim groups como arreglo (limpia espacios y vacíos)', () => {
    expect(parseDevIdentity('ana@x.com: miranda , admin ,')).toEqual({
      user: 'ana@x.com',
      claims: { groups: ['miranda', 'admin'] },
    })
  })
  it('vacío o sin email → null', () => {
    expect(parseDevIdentity('')).toBeNull()
    expect(parseDevIdentity('   ')).toBeNull()
    expect(parseDevIdentity(':miranda')).toBeNull()
  })
})

describe('decideDevIdentity · fail-safe (imposible activar con gate real)', () => {
  it('env ausente → off (comportamiento idéntico a hoy)', () => {
    expect(decideDevIdentity({})).toEqual({ mode: 'off' })
    expect(configFromEnv({}, fixedSecret).devIdentity).toBeNull()
  })
  it('seteado y SIN gate real → active con la identidad parseada', () => {
    const d = decideDevIdentity({ VERGIS_DEV_IDENTITY: 'cesar@x.com:miranda' })
    expect(d).toEqual({ mode: 'active', identity: { user: 'cesar@x.com', claims: { groups: ['miranda'] } } })
    expect(configFromEnv({ VERGIS_DEV_IDENTITY: 'cesar@x.com:miranda' }, fixedSecret).devIdentity).toEqual({
      user: 'cesar@x.com',
      claims: { groups: ['miranda'] },
    })
  })
  it('seteado CON gate real (VERGIS_GATE_SECRET) → ignored-gate, jamás inyecta', () => {
    const env = { VERGIS_DEV_IDENTITY: 'cesar@x.com:miranda', VERGIS_GATE_SECRET: 'proxy-token' }
    expect(decideDevIdentity(env)).toEqual({ mode: 'ignored-gate' })
    expect(configFromEnv(env, fixedSecret).devIdentity).toBeNull()
  })
  it('VERGIS_GATE_SECRET vacío NO cuenta como gate real → sigue activo', () => {
    expect(decideDevIdentity({ VERGIS_DEV_IDENTITY: 'x@x.com', VERGIS_GATE_SECRET: '' }).mode).toBe('active')
  })
  it('seteado pero sin email parseable → invalid (se ignora)', () => {
    expect(decideDevIdentity({ VERGIS_DEV_IDENTITY: ':solo-grupos' })).toEqual({ mode: 'invalid', raw: ':solo-grupos' })
  })
})

// `--fresh` recrea el store de gobierno del ARNÉS DE DEV. La imposibilidad de tocar un store de
// producción es de construcción: reusa la misma señal fail-safe que `decideDevIdentity`.
describe('decideFreshStore · --fresh solo en el arnés de desarrollo', () => {
  const DEV = { VERGIS_DEV_IDENTITY: 'cesar@x.com:miranda' }

  it('sin la bandera → off (el store se conserva: `--keep` implícito)', () => {
    expect(decideFreshStore([], DEV)).toEqual({ mode: 'off' })
    expect(decideFreshStore(['--keep'], DEV)).toEqual({ mode: 'off' })
    expect(hasFreshFlag([])).toBe(false)
    expect(hasFreshFlag(['--fresh'])).toBe(true)
  })

  it('bandera ∧ dev-identity activa ∧ sin gate real → fresh', () => {
    expect(decideFreshStore(['--fresh'], DEV)).toEqual({ mode: 'fresh' })
    expect(decideFreshStore(['--otro', '--fresh'], DEV)).toEqual({ mode: 'fresh' })
  })

  it('bandera CON gate real → refused-gate, jamás borra (producción)', () => {
    expect(decideFreshStore(['--fresh'], { ...DEV, VERGIS_GATE_SECRET: 'proxy-token' })).toEqual({ mode: 'refused-gate' })
  })

  it('bandera SIN identidad de dev → refused-no-dev (un despliegue cualquiera no es el arnés)', () => {
    expect(decideFreshStore(['--fresh'], {})).toEqual({ mode: 'refused-no-dev' })
    expect(decideFreshStore(['--fresh'], { VERGIS_GOVERNANCE_DB: '/opt/mira/governance.sqlite' })).toEqual({ mode: 'refused-no-dev' })
  })

  it('dev-identity inválida no habilita el borrado', () => {
    expect(decideFreshStore(['--fresh'], { VERGIS_DEV_IDENTITY: ':solo-grupos' })).toEqual({ mode: 'refused-no-dev' })
  })
})

// `HOST` (opcional) permite atar la escucha a una interfaz — el arnés de dev, localhost-only. Sin el
// env, el comportamiento es el de hoy: `server.listen(PORT)` = todas las interfaces (lo que el
// contenedor necesita para que el proxy lo alcance).
describe('configFromEnv · HOST (interfaz de escucha, opcional)', () => {
  it('sin HOST → undefined (todas las interfaces, como hoy)', () => {
    expect(configFromEnv({}, fixedSecret).host).toBeUndefined()
  })
  it('HOST vacío o en blanco NO cuenta (no se ata a "")', () => {
    expect(configFromEnv({ HOST: '' }, fixedSecret).host).toBeUndefined()
    expect(configFromEnv({ HOST: '   ' }, fixedSecret).host).toBeUndefined()
  })
  it('HOST seteado → se usa tal cual (trim)', () => {
    expect(configFromEnv({ HOST: '127.0.0.1' }, fixedSecret).host).toBe('127.0.0.1')
    expect(configFromEnv({ HOST: ' ::1 ' }, fixedSecret).host).toBe('::1')
  })
})
