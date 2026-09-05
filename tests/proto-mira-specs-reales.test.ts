// H0 (#289) · PARIDAD CONTRA LAS SPECS REALES del repo.
//
// El registro discrimina por presencia de `mira_version`, y hasta H0 nadie dependía de esa clave para
// SERVIR. Este test es el que mide que la migración no deja fuera ninguna spec real: recorre las
// specs del banco de anillos y los ejemplos, y exige que cada una caiga en el brazo que se midió el
// 2026-09-05. Si aparece una spec nueva sin `mira_version`, el test la NOMBRA y falla — es
// deliberado: la decisión de si esa spec debe declararla es de quien la escribió, no de este test.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createProtoRegistry } from '../server/proto-registry'
import { miraProtoBotlet } from '@vergis/mira'

const RAIZ = join(import.meta.dirname, '..')
const DIRS = ['deploy/rollout/bench/specs', 'examples']

/** La ÚNICA spec del repo sin `mira_version` el 2026-09-05: no es un PI (es una plantilla de jobs). */
const SIN_DISCRIMINADOR = ['examples/job-templates.yaml']

function specsDelRepo(): string[] {
  return DIRS.flatMap((d) =>
    readdirSync(join(RAIZ, d))
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => `${d}/${f}`),
  ).sort()
}

describe('proto-Botlets · paridad contra las specs reales del repo', () => {
  const reg = createProtoRegistry([miraProtoBotlet])
  const archivos = specsDelRepo()

  it('hay specs que medir (el test no puede pasar por vacío)', () => {
    expect(archivos.length).toBeGreaterThanOrEqual(15)
  })

  it('cada spec con `mira_version` discrimina como `mira`', () => {
    const esperadas = archivos.filter((f) => !SIN_DISCRIMINADOR.includes(f))
    const veredictos = esperadas.map((f) => {
      const v = reg.discriminate(readFileSync(join(RAIZ, f), 'utf8'))
      return `${f}: ${v.kind === 'ok' ? v.proto.type : v.kind}`
    })
    expect(veredictos).toEqual(esperadas.map((f) => `${f}: mira`))
  })

  it('las specs SIN `mira_version` son exactamente las conocidas — ninguna nueva se cuela', () => {
    const sin = archivos.filter((f) => reg.discriminate(readFileSync(join(RAIZ, f), 'utf8')).kind === 'sin-discriminador')
    expect(sin).toEqual(SIN_DISCRIMINADOR)
  })

  it('cada spec de PI del banco entrega capabilities e identidad al proto (no solo discrimina)', () => {
    const delBanco = archivos.filter((f) => f.startsWith('deploy/rollout/bench/specs/'))
    expect(delBanco.length).toBeGreaterThan(0)
    for (const f of delBanco) {
      const spec = miraProtoBotlet.parse(readFileSync(join(RAIZ, f), 'utf8'))
      expect(miraProtoBotlet.capabilitiesOf(spec).length, f).toBeGreaterThan(0)
      expect(miraProtoBotlet.identityOf(spec).code, f).not.toBe('pi')
    }
  })
})
