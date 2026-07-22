import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDeploymentConfig,
  configCheckMode,
  isEphemeralPath,
  reportDeploymentConfig,
  type ConfigFinding,
} from '../server/deployment-check'

// Un archivo y un directorio que SÍ existen (fuera de la lógica de "efímero", que solo aplica a VERGIS_OUT).
const dir = mkdtempSync(join(tmpdir(), 'vergis-check-'))
const existingFile = join(dir, 'entidades.yaml')
writeFileSync(existingFile, 'entities: []\n')
const MISSING = '/no/existe/jamas/archivo.yaml'
const persistentDir = process.cwd() // existe y NO está bajo /tmp

describe('checkDeploymentConfig', () => {
  it('env vacío no produce hallazgos', () => {
    expect(checkDeploymentConfig({})).toEqual([])
  })

  it('un env de path definido pero ausente → error (¿volumen sin montar?)', () => {
    // VERGIS_IDENTITY_MAP referencia un path pero NO es env de gobierno → aísla la regla de path.
    const f = checkDeploymentConfig({ VERGIS_IDENTITY_MAP: MISSING })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'error', env: 'VERGIS_IDENTITY_MAP' })
  })

  it('un env de path que existe no produce error', () => {
    expect(checkDeploymentConfig({ VERGIS_IDENTITY_MAP: existingFile })).toEqual([])
  })

  // Issue #50: VERGIS_CONNECTIONS es dual — JSON inline o ruta a archivo.
  it('VERGIS_CONNECTIONS como RUTA ausente → error; como ruta existente o JSON inline → nada', () => {
    const f = checkDeploymentConfig({ VERGIS_CONNECTIONS: MISSING })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'error', env: 'VERGIS_CONNECTIONS' })
    expect(checkDeploymentConfig({ VERGIS_CONNECTIONS: existingFile })).toEqual([])
    expect(checkDeploymentConfig({ VERGIS_CONNECTIONS: '{"wh":{"server":"s","database":"d"}}' })).toEqual([])
  })

  it('un env de gobierno con path presente pero sin VERGIS_OUT → solo aviso de efímero', () => {
    const f = checkDeploymentConfig({ VERGIS_MASTER_DATA: existingFile })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'warn', env: 'VERGIS_OUT' })
  })

  it('VERGIS_POLICIES es lista: reporta solo los que faltan', () => {
    const f = checkDeploymentConfig({ VERGIS_POLICIES: `${existingFile},${MISSING}` })
    expect(f).toHaveLength(1)
    expect(f[0]?.message).toContain(MISSING)
  })

  it('gobierno pedido con VERGIS_OUT ausente → aviso de store efímero', () => {
    const f = checkDeploymentConfig({ VERGIS_ADMIN_SEED: 'a@b.com' })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'warn', env: 'VERGIS_OUT' })
  })

  it('gobierno pedido con VERGIS_OUT bajo /tmp → aviso de store efímero', () => {
    const f = checkDeploymentConfig({ VERGIS_ADMIN_SEED: 'a@b.com', VERGIS_OUT: '/tmp/vergis' })
    expect(f.some((x) => x.level === 'warn' && x.env === 'VERGIS_OUT')).toBe(true)
  })

  it('gobierno pedido con VERGIS_OUT persistente → sin aviso de efímero', () => {
    const f = checkDeploymentConfig({ VERGIS_ADMIN_SEED: 'a@b.com', VERGIS_OUT: persistentDir })
    expect(f).toEqual([])
  })

  it('sin envs de gobierno no exige VERGIS_OUT', () => {
    expect(checkDeploymentConfig({ VERGIS_ENGINE: 'fabric' })).toEqual([])
  })

  it('D2 · sirve PIs (VERGIS_SPECS_DIR) sin VERGIS_GATE_SECRET → aviso de gate bypasseable', () => {
    const f = checkDeploymentConfig({ VERGIS_SPECS_DIR: persistentDir })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'warn', env: 'VERGIS_GATE_SECRET' })
    expect(f[0]?.message).toContain('X-Forwarded')
  })

  it('D2 · sirve PIs CON VERGIS_GATE_SECRET → sin aviso de gate', () => {
    const f = checkDeploymentConfig({ VERGIS_SPECS_DIR: persistentDir, VERGIS_GATE_SECRET: 'proxy-token' })
    expect(f).toEqual([])
  })

  it('D2 · sin VERGIS_SPECS_DIR no exige el gate secret (no todo despliegue sirve PIs)', () => {
    expect(checkDeploymentConfig({ VERGIS_GATE_SECRET: '' })).toEqual([])
  })

  // Issue #76: el schema de slots (incl. `meta`) se valida al arranque, ANTES del try/catch de la admin.
  it('VERGIS_INTAKE con `meta` mal declarado → error ruidoso (no degrada en silencio)', () => {
    const bad = join(dir, 'slots-bad.yaml')
    writeFileSync(bad, 'slots:\n  - id: facturas\n    label: Facturas\n    target: { workspaceId: w, lakehouseId: l, path: Files/f }\n    meta:\n      - { id: empresa, label: Empresa, type: fecha }\n')
    const f = checkDeploymentConfig({ VERGIS_INTAKE: bad })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ level: 'error', env: 'VERGIS_INTAKE' })
    expect(f[0].message).toMatch(/type inválido/)
  })

  it('VERGIS_INTAKE bien declarado → sin hallazgos', () => {
    const good = join(dir, 'slots-ok.yaml')
    writeFileSync(good, 'slots:\n  - id: facturas\n    label: Facturas\n    target: { workspaceId: w, lakehouseId: l, path: Files/f }\n    meta:\n      - { id: empresa_rut, label: Empresa, type: rut, required: true }\n')
    expect(checkDeploymentConfig({ VERGIS_INTAKE: good })).toEqual([])
  })

  it('reproduce el incidente del avatar: master-data sin montar + admin seed + OUT efímero', () => {
    const f = checkDeploymentConfig({
      VERGIS_MASTER_DATA: '/master-data/entidades.yaml', // no montado
      VERGIS_ADMIN_SEED: 'cesar@x.com,arbol@y.com',
      VERGIS_OUT: '/tmp/vergis',
    })
    expect(f.filter((x) => x.level === 'error')).toHaveLength(1) // master-data ausente
    expect(f.filter((x) => x.level === 'warn')).toHaveLength(1) // store efímero
  })
})

describe('isEphemeralPath', () => {
  it('marca /tmp y el tmpdir del SO', () => {
    expect(isEphemeralPath('/tmp/x')).toBe(true)
    expect(isEphemeralPath(resolve(tmpdir(), 'y'))).toBe(true)
  })
  it('no marca un directorio persistente', () => {
    expect(isEphemeralPath('/governance')).toBe(false)
    expect(isEphemeralPath(process.cwd())).toBe(false)
  })
})

describe('configCheckMode', () => {
  it('default = strict', () => expect(configCheckMode({})).toBe('strict'))
  it('respeta warn/off (case-insensitive)', () => {
    expect(configCheckMode({ VERGIS_CONFIG_CHECK: 'WARN' })).toBe('warn')
    expect(configCheckMode({ VERGIS_CONFIG_CHECK: 'off' })).toBe('off')
  })
})

describe('reportDeploymentConfig', () => {
  const errs: ConfigFinding[] = [{ level: 'error', env: 'VERGIS_MASTER_DATA', message: 'falta' }]
  const warns: ConfigFinding[] = [{ level: 'warn', env: 'VERGIS_OUT', message: 'efímero' }]

  it('strict + errores → lanza', () => {
    expect(() => reportDeploymentConfig(errs, 'strict', () => {})).toThrow(/Configuración de despliegue inválida/)
  })
  it('warn + errores → NO lanza pero imprime', () => {
    const out: string[] = []
    expect(() => reportDeploymentConfig(errs, 'warn', (m) => out.push(m))).not.toThrow()
    expect(out.join('\n')).toContain('VERGIS_MASTER_DATA')
  })
  it('strict + solo avisos → NO lanza', () => {
    expect(() => reportDeploymentConfig(warns, 'strict', () => {})).not.toThrow()
  })
  it('off → no imprime nada', () => {
    const out: string[] = []
    reportDeploymentConfig(errs, 'off', (m) => out.push(m))
    expect(out).toEqual([])
  })
  it('sin hallazgos → no imprime nada', () => {
    const out: string[] = []
    reportDeploymentConfig([], 'strict', (m) => out.push(m))
    expect(out).toEqual([])
  })
})

// higiene: el fixture existe
it('fixture creado', () => expect(existsSync(existingFile)).toBe(true))
