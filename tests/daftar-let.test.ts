/**
 * LA SUPERFICIE DEL LET (H3 · §3.5), fila por fila y con su BRAZO NEGATIVO — que es donde vive lo
 * que importa: 403 de la guía ajena, 403 sin claim, 409 en standby, 400 por `guideId` que no calza,
 * 403 del progreso bloqueado, 503 sin store, `..` rechazado en los recursos.
 *
 * El store es el REAL (`SqliteEvaluacionesStore` en memoria) y los instrumentos son archivos en un
 * `mkdtemp` con guías SINTÉTICAS: los de Daftar los escriben menores de edad y no entran al repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteEvaluacionesStore } from '@vergis/capabilities'
import { createDaftarProto, crearInstrumentos, parseDaftarSpec, type Instrumentos } from '@vergis/daftar'
import type { LetInvocation, LetResponse, ProtoBotlet } from '@vergis/botler'

const SPEC = parseDaftarSpec(`daftar_version: "1.0"
identity: { code: estudios, display_name: "Daftar · Estudios" }
estudiantes:
  ana:  { name: "Ana Sintética", grade: "1° Medio" }
  beto: { name: "Beto Sintético", grade: "2° Medio" }
`)

const guiaDe = (student: string, id: string) => ({
  title: `Guía ${id}`,
  subtitle: 'sub',
  student,
  subject: 'Materia',
  group: id,
  sprint: 'S1',
  mode: 'practice',
  code: id.toUpperCase(),
  institution: 'Instituto Sintético',
  sections: [
    {
      id: 'a',
      title: 'Sección',
      type: 'multiple_choice',
      exercises: [{ text: '<img src="/preu/clase-01/q01.png"> ¿2+2?', options: ['3', '4'], answer: 1 }],
    },
  ],
})

let dir: string
let store: SqliteEvaluacionesStore
let instrumentos: Instrumentos
let proto: ProtoBotlet<typeof SPEC>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'h3-let-'))
  mkdirSync(join(dir, 'guides'), { recursive: true })
  mkdirSync(join(dir, 'reports'), { recursive: true })
  mkdirSync(join(dir, 'recursos', 'preu', 'clase-01'), { recursive: true })
  writeFileSync(join(dir, 'guides', 'g-ana.json'), JSON.stringify(guiaDe('ana', 'g-ana')))
  writeFileSync(join(dir, 'guides', 'g-beto.json'), JSON.stringify(guiaDe('beto', 'g-beto')))
  writeFileSync(join(dir, 'reports', 'r-ana.json'), JSON.stringify({ student: 'ana', titulo: 'Devolución', content_html: '<p>ojo</p>' }))
  writeFileSync(join(dir, 'reports', 'r-beto.json'), JSON.stringify({ student: 'beto', titulo: 'Devolución B', content_html: '<p>x</p>' }))
  writeFileSync(join(dir, 'recursos', 'preu', 'clase-01', 'q01.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'recursos', 'secreto.txt'), 'no debe salir por preu')
  store = await SqliteEvaluacionesStore.open(null)
  instrumentos = crearInstrumentos({ dir, log: () => {} })
  proto = createDaftarProto({ instrumentos, store: () => store, ahora: () => '2026-09-05T12:00:00.000Z', log: () => {} }) as ProtoBotlet<typeof SPEC>
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface Quien {
  email?: string
  student?: string[]
  control?: boolean
}
const ANA: Quien = { email: 'ana@x.test', student: ['ana'] }
const ADMIN: Quien = { email: 'jefa@x.test', student: ['*'] }

function inv(path: string, q: Quien, over: Partial<LetInvocation> = {}): LetInvocation {
  return {
    method: 'GET',
    path,
    query: {},
    rawUrl: `/estudios/${path}`,
    headers: {},
    identity: { agent: 'vergis', ...(q.email ? { user: q.email } : {}), ...(q.student ? { claims: { student: q.student } } : {}) },
    hasControl: q.control !== false,
    activeHolder: 'vergis-0.26.0@nodo-1 (época 7)',
    base: '/estudios',
    ...over,
  }
}

const pedir = async (path: string, q: Quien, over: Partial<LetInvocation> = {}): Promise<LetResponse | null> =>
  proto.invoke(SPEC, '/specs/daftar.yaml', inv(path, q, over))

const cuerpo = (r: LetResponse | null): unknown => JSON.parse(String(r!.body))

// ── Identidad ───────────────────────────────────────────────────────────────────────────────────
describe('daftar-let · el estudiante es el login (B4)', () => {
  it('sin claim `student` → 403 que dice a quién pedirle acceso y nombra el email que entró', async () => {
    const r = await pedir('', { email: 'nadie@x.test' })
    expect(r!.status).toBe(403)
    expect(String(r!.body)).toContain('nadie@x.test')
    expect(String(r!.body)).toContain('student')
  })

  it('sin identidad del gate → 403 igual: JAMÁS se cae a un estudiante por defecto', async () => {
    const r = await pedir('', {})
    expect(r!.status).toBe(403)
    expect(String(r!.body)).toContain('sin identidad')
  })

  it('el shell declara el estudiante del claim, no el de `?s=`', async () => {
    const r = await pedir('', ANA, { query: { s: 'beto' } })
    expect(r!.status).toBe(200)
    expect(String(r!.body)).toContain('"student":"ana"')
    expect(String(r!.body)).toContain('"admin":false')
  })

  it('`student: ["*"]` es admin: sin `?s=` ve todo, con `?s=` toma el foco de ese estudiante', async () => {
    expect(String((await pedir('', ADMIN))!.body)).toContain('"student":null,"admin":true')
    expect(String((await pedir('', ADMIN, { query: { s: 'beto' } }))!.body)).toContain('"student":"beto"')
  })
})

// ── Catálogo ────────────────────────────────────────────────────────────────────────────────────
describe('daftar-let · catálogo', () => {
  it('`api/guides` lista SOLO las del estudiante y no filtra su clave `student` al cliente', async () => {
    const filas = (await pedir('api/guides', ANA))!
    expect(cuerpo(filas)).toEqual([expect.objectContaining({ id: 'g-ana', title: 'Guía g-ana', sectionCount: 1 })])
    expect(String(filas.body)).not.toContain('"student"')
  })

  it('el admin sin foco ve las dos; con `?s=beto` ve la de Beto', async () => {
    expect((cuerpo(await pedir('api/guides', ADMIN)) as unknown[]).length).toBe(2)
    expect((cuerpo(await pedir('api/guides', ADMIN, { query: { s: 'beto' } })) as { id: string }[]).map((g) => g.id)).toEqual(['g-beto'])
  })

  it('`api/guides/<id>` ajeno → 403; propio → 200 con `/preu/` REESCRITO al prefijo del Let', async () => {
    expect((await pedir('api/guides/g-beto', ANA))!.status).toBe(403)
    const r = (await pedir('api/guides/g-ana', ANA))!
    expect(r.status).toBe(200)
    expect(String(r.body)).toContain('src=\\"/estudios/recursos/preu/clase-01/q01.png\\"')
    expect(String(r.body)).not.toContain('src=\\"/preu/')
  })

  it('`api/guides/<id>` inexistente → 404', async () => {
    expect((await pedir('api/guides/no-existe', ANA))!.status).toBe(404)
  })

  it('`api/students` devuelve el padrón de la spec', async () => {
    expect(cuerpo(await pedir('api/students', ANA))).toEqual(SPEC.estudiantes)
  })
})

// ── Recursos ────────────────────────────────────────────────────────────────────────────────────
describe('daftar-let · recursos', () => {
  it('sirve el PNG con su content-type', async () => {
    const r = (await pedir('recursos/preu/clase-01/q01.png', ANA))!
    expect(r.status).toBe(200)
    expect(r.headers!['content-type']).toBe('image/png')
    expect(Buffer.from(r.body as Uint8Array)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it.each([
    'recursos/../guides/g-beto.json',
    'recursos/preu/../../guides/g-beto.json',
    'recursos//etc/passwd',
    'recursos/preu/%2e%2e/secreto.txt',
  ])('rechaza el traversal: %s', async (ruta) => {
    const r = await pedir(ruta, ANA)
    expect(r === null || r.status === 404).toBe(true)
  })
})

// ── Progreso ────────────────────────────────────────────────────────────────────────────────────
const PROG = { guideId: 'g-ana', currentSection: 0, totalSections: 1, sections: { '0': { answers: [{ choice: 1, conf: 'S' }], checked: true, score: { correct: 1, total: 1 } } } }

describe('daftar-let · progreso', () => {
  it('POST guarda y GET lo devuelve IGUAL (el round-trip del store, no una copia en memoria)', async () => {
    expect(cuerpo(await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) }))).toEqual({ ok: true })
    const leido = cuerpo(await pedir('api/progress/g-ana', ANA)) as Record<string, unknown>
    expect(leido).toMatchObject({ ...PROG, last_updated: '2026-09-05T12:00:00.000Z' })
    expect(cuerpo(await pedir('api/progress', ANA))).toEqual({ 'g-ana': leido })
  })

  it('sin intento, GET devuelve `{}` (como el Daftar de archivos)', async () => {
    expect(cuerpo(await pedir('api/progress/g-ana', ANA))).toEqual({})
  })

  it('409 SIN CONTROL, nombrando al activo — y el GET sigue sirviendo', async () => {
    const r = (await pedir('api/progress/g-ana', { ...ANA, control: false }, { method: 'POST', body: JSON.stringify(PROG) }))!
    expect(r.status).toBe(409)
    expect(String(r.body)).toContain('vergis-0.26.0@nodo-1 (época 7)')
    expect(String(r.body)).toContain('standby')
    expect((await pedir('api/progress/g-ana', { ...ANA, control: false }))!.status).toBe(200)
  })

  it('400 si el `guideId` del cuerpo no calza con la URL', async () => {
    const r = (await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify({ ...PROG, guideId: 'otra' }) }))!
    expect(r.status).toBe(400)
    expect(String(r.body)).toContain('guideId mismatch')
  })

  it('403 si el progreso está bloqueado (`locked`)', async () => {
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
    store.bloquear('g-ana::ana')
    const r = (await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) }))!
    expect(r.status).toBe(403)
    expect(cuerpo(r)).toEqual({ ok: false, error: 'locked' })
  })

  it('403 al escribir sobre la guía de otro', async () => {
    expect((await pedir('api/progress/g-beto', ANA, { method: 'POST', body: JSON.stringify(PROG) }))!.status).toBe(403)
  })

  it('503 con motivo si el store no abrió — y el CATÁLOGO se sigue sirviendo', async () => {
    const sinStore = createDaftarProto({ instrumentos, store: () => null, log: () => {} }) as ProtoBotlet<typeof SPEC>
    const r = (await sinStore.invoke(SPEC, '/s.yaml', inv('api/progress/g-ana', ANA)))!
    expect(r.status).toBe(503)
    expect(String(r.body)).toContain('store')
    expect((await sinStore.invoke(SPEC, '/s.yaml', inv('api/guides', ANA)))!.status).toBe(200)
  })

  it('el intento deja registrado el instrumento como ESPEJO idempotente (D-75)', async () => {
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
    const i = store.instrumento('g-ana')
    expect(i?.estudiante).toBe('ana')
    expect(i?.totalItems).toBe(1)
  })
})

// ── Revisión y reset (solo admin) ───────────────────────────────────────────────────────────────
describe('daftar-let · revisión y reset', () => {
  beforeEach(async () => {
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
  })

  it('`api/review` de un no-admin → 403; del admin → guarda la revisión verbatim', async () => {
    const body = JSON.stringify({ sections: { '0': { score: '7/10', form: 'C', comments: ['ojo'] } } })
    expect((await pedir('api/review/g-ana', ANA, { method: 'POST', body }))!.status).toBe(403)
    expect((await pedir('api/review/g-ana', ADMIN, { method: 'POST', body }))!.status).toBe(200)
    const leido = cuerpo(await pedir('api/progress/g-ana', ANA)) as { sections: Record<string, { review?: unknown }> }
    expect(leido.sections['0']!.review).toEqual({ score: '7/10', form: 'C', comments: ['ojo'] })
  })

  it('`api/reset` de un no-admin → 403; del admin → el intento desaparece', async () => {
    expect((await pedir('api/reset/g-ana', ANA, { method: 'POST' }))!.status).toBe(403)
    expect((await pedir('api/reset/g-ana', ADMIN, { method: 'POST' }))!.status).toBe(200)
    expect(cuerpo(await pedir('api/progress/g-ana', ANA))).toEqual({})
    expect(cuerpo(await pedir('api/progress', ANA))).toEqual({})
  })

  it('reset y review sin control → 409 antes de tocar nada', async () => {
    expect((await pedir('api/reset/g-ana', { ...ADMIN, control: false }, { method: 'POST' }))!.status).toBe(409)
    expect(store.intento('g-ana', 'ana')).not.toBeNull()
  })
})

// ── Reportes de devolución (archivos) ───────────────────────────────────────────────────────────
describe('daftar-let · reportes', () => {
  it('lista solo los del estudiante y omite el `content_html` del listado', async () => {
    const filas = cuerpo(await pedir('api/reports', ANA)) as { id: string }[]
    expect(filas.map((f) => f.id)).toEqual(['r-ana'])
    expect(String((await pedir('api/reports', ANA))!.body)).not.toContain('content_html')
  })
  it('el detalle ajeno → 403; el propio → 200 con su contenido', async () => {
    expect((await pedir('api/reports/r-beto', ANA))!.status).toBe(403)
    expect(cuerpo(await pedir('api/reports/r-ana', ANA))).toMatchObject({ content_html: '<p>ojo</p>' })
  })
})

// ── Reporte corregido e imprimible ──────────────────────────────────────────────────────────────
describe('daftar-let · report/ y print/', () => {
  it('`report/<id>` propio → 200 HTML con el prefijo del Let; ajeno → 403', async () => {
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
    const r = (await pedir('report/g-ana', ANA))!
    expect(r.status).toBe(200)
    expect(r.headers!['content-type']).toContain('text/html')
    expect(String(r.body)).toContain('href="/estudios/"')
    expect(String(r.body)).toContain('Ana Sintética')
    expect((await pedir('report/g-beto', ANA))!.status).toBe(403)
  })

  it('`print/<id>?blank=1` ignora el progreso (es la hoja para llenar a mano)', async () => {
    await pedir('api/progress/g-ana', ANA, { method: 'POST', body: JSON.stringify(PROG) })
    expect(String((await pedir('print/g-ana', ANA))!.body)).toContain('Guía completada por el estudiante')
    expect(String((await pedir('print/g-ana', ANA, { query: { blank: '1' } }))!.body)).toContain('Versión en blanco')
  })
})

// ── Lo que no es suyo ───────────────────────────────────────────────────────────────────────────
describe('daftar-let · rutas ajenas', () => {
  it.each(['pdf', 'config', 'imprimir', 'api/otra-cosa', 'admin'])('`%s` → null (el nodo responde 404)', async (p) => {
    expect(await pedir(p, ANA)).toBeNull()
  })

  it('un 404 de ruta NO depende de quién pregunta: sin claim también da null, no 403', async () => {
    expect(await pedir('api/otra-cosa', { email: 'nadie@x.test' })).toBeNull()
  })

  it('un método de escritura sobre una ruta de lectura → null', async () => {
    expect(await pedir('api/guides', ANA, { method: 'POST' })).toBeNull()
  })
})
