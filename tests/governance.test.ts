// RLS por construcción (charter 012 §2a/§10): la gobernanza data-anchored es invariante de
// validación, no opcional. Un PI no se publica abierto por accidente (fail-closed por omisión),
// y un PI gobernado no puede servir datos por una vía que no aplica la policy (no-bypass).

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ex = (n: string) => join(ROOT, 'examples', n)

let work: string
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'gov-')) })
afterAll(() => { rmSync(work, { recursive: true, force: true }) })

describe('Gobernanza data-anchored · RLS por construcción', () => {
  it('fail-closed por omisión: un PI sin audiencia se rechaza (no se asume público)', async () => {
    await expect(
      runSpec({ specPath: ex('bad-no-audience.yaml'), baseDir: work }),
    ).rejects.toMatchObject({ structured: { error: 'mira/spec-invalid', code: 'audience-undeclared' } })
  })

  it('no-bypass: un PI gobernado servido por capability cruda (static-data) se rechaza', async () => {
    await expect(
      runSpec({ specPath: ex('bad-governed-rawcap.yaml'), baseDir: work }),
    ).rejects.toMatchObject({
      structured: { error: 'mira/spec-invalid', code: 'governed-data-needs-enforcing-capability', path: 'data.estado.capability' },
    })
  })

  it('un PI público explícito (rls: public) se publica con cualquier capability', async () => {
    const out = await runSpec({ specPath: ex('hello.yaml'), baseDir: work })
    expect(out.ok).toBe(true) // hello usa static-data + rls: public → válido
  })
})
