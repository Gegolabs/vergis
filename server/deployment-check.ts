/**
 * Auto-chequeo de coherencia del despliegue — el CONTRATO Producto→Infra, verificado al arranque.
 *
 * El Producto es el único que sabe qué envs + montajes necesita para encender cada capacidad (en
 * particular la app de Administración: avatar Perfil/Gestión/Configuración). Cuando ese contrato se
 * rompe —un env que referencia un archivo/directorio NO montado, o el gobierno pedido con un store
 * EFÍMERO— hoy el arranque degrada en SILENCIO: el bloque de gobierno lee el path con readFileSync,
 * revienta, y su try/catch se traga la excepción → la Administración desaparece sin dejar rastro
 * (incidente del avatar, 2026-07). Este módulo convierte esa clase de error en una falla RUIDOSA
 * (y, en modo estricto, aborta el arranque) antes de que el daño quede escondido.
 *
 * Es genérico: no conoce ninguna instancia. Solo mira el env contra el disco.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export interface ConfigFinding {
  level: 'error' | 'warn'
  env: string
  message: string
}

/**
 * Envs que referencian un archivo o directorio en disco. Si están definidos pero el path no existe
 * (típicamente: el volumen no se montó), el Producto los lee con readFileSync y REVIENTA. Este chequeo
 * lo detecta antes y lo reporta de forma legible.
 */
const PATH_ENVS: { env: string; list?: boolean }[] = [
  { env: 'VERGIS_SPECS_DIR' },
  { env: 'VERGIS_POLICIES', list: true },
  { env: 'VERGIS_IDENTITY_MAP' },
  { env: 'VERGIS_MASTER_DATA' },
  { env: 'VERGIS_DOMAINS' },
  { env: 'VERGIS_GROUPS' },
  { env: 'VERGIS_INTAKE' },
  { env: 'VERGIS_SOURCES' },
  { env: 'VERGIS_PI_OWNERS' },
  { env: 'VERGIS_DATASETS' },
]

/** Presencia de cualquiera de estos ⇒ la instancia QUIERE la app de Administración / gobierno. */
const GOVERNANCE_ENVS = ['VERGIS_ADMIN_SEED', 'VERGIS_MASTER_DATA', 'VERGIS_DOMAINS', 'VERGIS_GROUPS', 'VERGIS_PI_OWNERS', 'VERGIS_SOURCES']

/** ¿`p` cae en un directorio efímero (se pierde entre reinicios del contenedor)? */
export function isEphemeralPath(p: string): boolean {
  const abs = resolve(p)
  const tmp = resolve(tmpdir())
  return abs === tmp || abs.startsWith(tmp + '/') || abs === '/tmp' || abs.startsWith('/tmp/')
}

/** Evalúa la coherencia del despliegue contra el env dado. No imprime ni lanza: solo reporta hallazgos. */
export function checkDeploymentConfig(env: NodeJS.ProcessEnv = process.env): ConfigFinding[] {
  const findings: ConfigFinding[] = []
  const has = (k: string): boolean => (env[k] ?? '').trim().length > 0

  // 1) Path referenciado pero ausente (volumen sin montar) → ERROR.
  for (const { env: name, list } of PATH_ENVS) {
    const raw = (env[name] ?? '').trim()
    if (!raw) continue
    const paths = list ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw]
    for (const p of paths) {
      if (!existsSync(resolve(p))) {
        findings.push({ level: 'error', env: name, message: `${name}=${p} está definido pero el path no existe (¿volumen sin montar?).` })
      }
    }
  }

  // 2) Gobierno pedido pero GovernanceStore EFÍMERO → WARN. Sin VERGIS_OUT (o bajo /tmp), el store de
  //    admins/dueños/auditoría no sobrevive un restart: el avatar de Administración reaparece vacío.
  if (GOVERNANCE_ENVS.some(has)) {
    const out = (env['VERGIS_OUT'] ?? '').trim()
    if (out === '') {
      findings.push({
        level: 'warn',
        env: 'VERGIS_OUT',
        message: 'la instancia declara gobierno (admins/dominios/dueños) pero VERGIS_OUT no está definido: el GovernanceStore es EFÍMERO y se reinicia en cada restart. Monta un volumen persistente y apunta VERGIS_OUT a él.',
      })
    } else if (isEphemeralPath(out)) {
      findings.push({
        level: 'warn',
        env: 'VERGIS_OUT',
        message: `VERGIS_OUT=${out} es un directorio efímero: el GovernanceStore (admins/dueños/auditoría) NO sobrevive un restart. Usa un volumen persistente.`,
      })
    }
  }

  return findings
}

export type ConfigCheckMode = 'strict' | 'warn' | 'off'

/** Modo del chequeo desde el env. Default: `strict` (los errores abortan el arranque). */
export function configCheckMode(env: NodeJS.ProcessEnv = process.env): ConfigCheckMode {
  const v = (env['VERGIS_CONFIG_CHECK'] ?? 'strict').toLowerCase()
  return v === 'off' ? 'off' : v === 'warn' ? 'warn' : 'strict'
}

/**
 * Imprime un banner ruidoso con los hallazgos y, en modo `strict`, LANZA si hay errores (aborta el
 * arranque: mejor un contenedor que crashea visiblemente que uno que sirve a medias en silencio).
 */
export function reportDeploymentConfig(
  findings: ConfigFinding[],
  mode: ConfigCheckMode,
  log: (m: string) => void = (m) => console.error(m),
): void {
  if (mode === 'off' || findings.length === 0) return
  const errors = findings.filter((f) => f.level === 'error')
  const warns = findings.filter((f) => f.level === 'warn')
  const bar = '━'.repeat(76)
  log(`[vergis-rls] ${bar}`)
  log(`[vergis-rls] ⚠ REVISIÓN DE CONFIGURACIÓN DE DESPLIEGUE — ${errors.length} error(es) · ${warns.length} aviso(s)`)
  for (const f of errors) log(`[vergis-rls]   ✖ ${f.env}: ${f.message}`)
  for (const f of warns) log(`[vergis-rls]   ⚠ ${f.env}: ${f.message}`)
  log(`[vergis-rls] Contrato de despliegue: deploy/compose.reference.yml`)
  log(`[vergis-rls] ${bar}`)
  if (mode === 'strict' && errors.length > 0) {
    throw new Error(
      `Configuración de despliegue inválida: ${errors.length} error(es). Corrige los envs/montajes ` +
        `o define VERGIS_CONFIG_CHECK=warn para arrancar de todos modos.`,
    )
  }
}
