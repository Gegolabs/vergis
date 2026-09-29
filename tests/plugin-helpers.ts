/**
 * Utilidades compartidas por las pruebas del plugin `vergis` (`tests/plugin-*.test.ts`).
 *
 * Las declaraciones de prueba se escriben en directorios TEMPORALES fuera del repo: la prueba de D3
 * (`plugin-frontera.test.ts`) prohíbe un `vergis-ops.json` fuera de `tests/fixtures/`, y un temporal
 * no deja rastro en el árbol.
 */
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const RAIZ = resolve(__dirname, '..')
export const PLUGIN = join(RAIZ, 'plugins/vergis')
export const CLI = join(PLUGIN, 'bin/vergis-ops.mjs')
export const FIX = join(RAIZ, 'tests/fixtures/plugin')

export interface Corrida {
  code: number
  out: string
  err: string
  all: string
}

/** Corre el CLI con `node`, sin lanzar: el código de salida ES el objeto de estudio. */
export function cli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Corrida {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    env: { ...process.env, VERGIS_OPS_RETRY_WAITS: '0,0', ...opts.env },
    encoding: 'utf8',
  })
  const out = r.stdout ?? ''
  const err = r.stderr ?? ''
  return { code: r.status ?? -1, out, err, all: out + err }
}

/** Igual que `cli` pero asíncrono (para correr dos a la vez). */
export function cliAsync(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Corrida> {
  return new Promise((res) => {
    const c = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      env: { ...process.env, VERGIS_OPS_RETRY_WAITS: '0,0', ...opts.env },
    })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (code) => res({ code: code ?? -1, out, err, all: out + err }))
  })
}

export function tmp(prefix = 'vergis-ops-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Escribe una declaración en un directorio temporal nuevo y devuelve ese directorio. */
export function declarar(doc: unknown, extra: Record<string, string> = {}): string {
  const dir = tmp()
  writeFileSync(join(dir, 'vergis-ops.json'), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2))
  for (const [rel, txt] of Object.entries(extra)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, txt)
  }
  return dir
}

/** La declaración MÍNIMA: las cuatro claves obligatorias y nada más. */
export function minima(over: Record<string, unknown> = {}, root = '/tmp/vergis-ops-no-existe'): any {
  return {
    $schema: 'https://raw.githubusercontent.com/Gegolabs/vergis/v0.0.0/plugins/vergis/schema/vergis-ops.schema.json',
    schema_version: 1,
    installations: [
      {
        id: 'prueba',
        transport: { kind: 'local' },
        host: { root },
        rings: { env: { RINGS_EDGE: 'borde', RINGS_DIR: './rings' } },
        ...over,
      },
    ],
  }
}

/**
 * Importa un módulo del CLI por RUTA calculada: el CLI es JavaScript sin tipos (el plugin se instala
 * como directorio, sin build), y la ruta dinámica evita pedirle a `tsc` declaraciones que no existen.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lib(nombre: string): Promise<any> {
  const { pathToFileURL } = await import('node:url')
  return import(pathToFileURL(join(PLUGIN, 'lib', nombre)).href)
}
