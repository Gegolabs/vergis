import { describe, it, expect } from 'vitest'
import {
  SqliteNotasStore,
  NotasConflict,
  canonicalJson,
  canonicalKey,
  normalizeEntityRef,
  substrateHash,
  SESSION_WINDOW_MS,
} from '@vergis/capabilities'

const abrir = (s: SqliteNotasStore, over: Partial<Parameters<SqliteNotasStore['abrirImpresion']>[0]> = {}, opts?: { now?: number }) =>
  s.abrirImpresion({ piSlug: 'pi-12', owner: 'Ana@X.com', frozen: { type: 'table', rows: [] }, ...over }, opts)

describe('notas-store · helpers puros', () => {
  it('canonicalJson ordena las claves en todo nivel', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([2, { y: 1, x: 0 }])).toBe('[2,{"x":0,"y":1}]')
  })

  it('normalizeEntityRef deja `schema.tabla` en minúscula, sin corchetes ni comillas', () => {
    expect(normalizeEntityRef('[dbo].[Dim_Empleado]')).toBe('dbo.dim_empleado')
    expect(normalizeEntityRef('"Silver"."FCT_Cartera"')).toBe('silver.fct_cartera')
    expect(normalizeEntityRef('dbo.dim_empleado')).toBe('dbo.dim_empleado')
  })

  it('substrateHash cambia con la vista, el ctx, el watermark y el spec (regla D4)', () => {
    const base = { piSlug: 'pi-12', page: 'p1', ctxJson: '{"a":1}', watermark: '2026-07-01', specVersion: 'v1' }
    const h = substrateHash(base)
    expect(substrateHash(base)).toBe(h)
    expect(substrateHash({ ...base, page: 'p2' })).not.toBe(h)
    expect(substrateHash({ ...base, ctxJson: '{"a":2}' })).not.toBe(h)
    expect(substrateHash({ ...base, watermark: '2026-07-02' })).not.toBe(h)
    expect(substrateHash({ ...base, specVersion: 'v2' })).not.toBe(h)
  })
})

describe('notas-store · impresiones', () => {
  it('abre una impresión normalizando el owner y congelando el árbol', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    expect(imp.owner).toBe('ana@x.com')
    expect(imp.explicita).toBe(false)
    expect(JSON.parse(imp.frozenJson)).toEqual({ type: 'table', rows: [] })
    expect(await s.getImpresion(imp.id)).toMatchObject({ id: imp.id, piSlug: 'pi-12' })
  })

  it('dedupe por sustrato dentro de la ventana de sesión; watermark nuevo ⇒ impresión NUEVA (D4)', async () => {
    const s = await SqliteNotasStore.open(null)
    const t0 = Date.parse('2026-07-01T10:00:00.000Z')
    const a = await abrir(s, { watermark: '2026-06-30' }, { now: t0 })
    const b = await abrir(s, { watermark: '2026-06-30' }, { now: t0 + 3_600_000 })
    expect(b.id).toBe(a.id) // misma vista, mismo watermark, misma sesión
    const c = await abrir(s, { watermark: '2026-07-01' }, { now: t0 + 3_600_000 })
    expect(c.id).not.toBe(a.id) // watermark nuevo
  })

  it('pasada la ventana sin actividad, la vista repetida abre impresión NUEVA', async () => {
    const s = await SqliteNotasStore.open(null)
    const t0 = Date.parse('2026-07-01T10:00:00.000Z')
    const a = await abrir(s, { watermark: '2026-06-30' }, { now: t0 })
    const d = await abrir(s, { watermark: '2026-06-30' }, { now: t0 + SESSION_WINDOW_MS + 1000 })
    expect(d.id).not.toBe(a.id)
  })

  it('otro owner, otra impresión — y «Imprimir» explícito jamás reutiliza', async () => {
    const s = await SqliteNotasStore.open(null)
    const t0 = Date.now()
    const a = await abrir(s, {}, { now: t0 })
    const otro = await abrir(s, { owner: 'beto@x.com' }, { now: t0 })
    expect(otro.id).not.toBe(a.id)
    const e1 = await abrir(s, { explicita: true }, { now: t0 })
    const e2 = await abrir(s, { explicita: true }, { now: t0 })
    expect(e2.id).not.toBe(e1.id)
    expect(e1.explicita).toBe(true)
  })

  it('el ctx canónico no depende del orden de las claves', async () => {
    const s = await SqliteNotasStore.open(null)
    const a = await abrir(s, { ctx: { semana: '24', area: 'RH' } })
    const b = await abrir(s, { ctx: { area: 'RH', semana: '24' } })
    expect(b.id).toBe(a.id)
  })

  it('listImpresiones devuelve solo las del owner, por actividad descendente', async () => {
    const s = await SqliteNotasStore.open(null)
    await abrir(s, { page: 'p1' })
    await abrir(s, { page: 'p2' })
    await abrir(s, { owner: 'beto@x.com', page: 'p3' })
    const mias = await s.listImpresiones('ANA@x.com')
    expect(mias).toHaveLength(2)
    expect(mias.every((i) => i.owner === 'ana@x.com')).toBe(true)
  })

  it('borrar una impresión arrastra notas, comparticiones y entregas', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    const n = await s.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: 'ojo', impresionId: imp.id, objetivoTipo: 'impresion' })
    await s.compartir(imp.id, 'ana@x.com', 'beto@x.com')
    await s.registrarEntrega(imp.id, 'beto@x.com', 'enlace', 'ana@x.com')
    await s.borrarImpresion(imp.id)
    expect(await s.getImpresion(imp.id)).toBeNull()
    expect(await s.getNota(n.id)).toBeNull()
    expect(await s.comparticionesDe(imp.id)).toHaveLength(0)
    expect(await s.entregasDe(imp.id)).toHaveLength(0)
  })
})

describe('notas-store · notas (las dos especies)', () => {
  it('una anotación exige impresión; un comentario exige entidad Y llave', async () => {
    const s = await SqliteNotasStore.open(null)
    await expect(s.crearNota({ especie: 'anotacion', autor: 'a@x.com', contenido: 'x' })).rejects.toBeInstanceOf(NotasConflict)
    await expect(s.crearNota({ especie: 'comentario', autor: 'a@x.com', contenido: 'x' })).rejects.toBeInstanceOf(NotasConflict)
    await expect(
      s.crearNota({ especie: 'comentario', autor: 'a@x.com', contenido: 'x', entityRef: 'dbo.t' }),
    ).rejects.toBeInstanceOf(NotasConflict)
  })

  it('el índice por llave (nota_llave) se puebla en AMBAS especies', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    await s.crearNota({ especie: 'anotacion', autor: 'a@x.com', contenido: 'a', impresionId: imp.id, objetivoTipo: 'fila', llave: { rut: '4021' } })
    await s.crearNota({ especie: 'comentario', autor: 'a@x.com', contenido: 'c', entityRef: 'dbo.dim_empleado', llave: { rut: '4021' } })
    const resumen = await s.comentariosDe('DBO.Dim_Empleado', [{ rut: '4021' }])
    expect(resumen).toHaveLength(1)
    expect(resumen[0].count).toBe(1) // la anotación NO cuenta como comentario
  })

  it('comentariosDe solo devuelve llaves de las filas servidas (render escaso)', async () => {
    const s = await SqliteNotasStore.open(null)
    const mk = (rut: string, campo?: string) =>
      s.crearNota({ especie: 'comentario', autor: 'a@x.com', contenido: 'ok', entityRef: 'dbo.dim_empleado', llave: { rut }, campo })
    await mk('4021')
    await mk('4021', 'sueldo')
    await mk('9999')
    const out = await s.comentariosDe('dbo.dim_empleado', [{ rut: '4021' }])
    expect(out).toHaveLength(1)
    expect(out[0].llave).toBe(canonicalKey({ rut: '4021' }))
    expect(out[0].count).toBe(2)
    expect(out[0].porCampo).toEqual({ '': 1, sueldo: 1 })
  })

  it('editar/borrar es solo del autor; borrar con respuestas VACÍA (el hilo no se rompe)', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    const raiz = await s.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: 'raíz', impresionId: imp.id })
    await expect(s.editarNota(raiz.id, 'beto@x.com', 'hack')).rejects.toBeInstanceOf(NotasConflict)
    await expect(s.borrarNota(raiz.id, 'beto@x.com')).rejects.toBeInstanceOf(NotasConflict)
    const hija = await s.crearNota({ especie: 'anotacion', autor: 'beto@x.com', contenido: 'respondo', impresionId: imp.id, parentId: raiz.id })
    expect(await s.borrarNota(raiz.id, 'ana@x.com')).toEqual({ vaciada: true })
    expect((await s.getNota(raiz.id))?.contenido).toBe('')
    expect(await s.getNota(hija.id)).not.toBeNull()
    expect(await s.borrarNota(hija.id, 'beto@x.com')).toEqual({ vaciada: false })
  })

  it('hiloDe devuelve la conversación completa, se entre por donde se entre', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    const a = await s.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: '1', impresionId: imp.id })
    const b = await s.crearNota({ especie: 'anotacion', autor: 'beto@x.com', contenido: '2', impresionId: imp.id, parentId: a.id })
    const c = await s.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: '3', impresionId: imp.id, parentId: b.id })
    const ids = (await s.hiloDe(c.id)).map((n) => n.id)
    expect(ids).toEqual([a.id, b.id, c.id])
    expect((await s.hiloDe(a.id)).map((n) => n.id)).toEqual([a.id, b.id, c.id])
  })

  it('marcarRefRota marca, jamás borra (D15)', async () => {
    const s = await SqliteNotasStore.open(null)
    const n = await s.crearNota({ especie: 'comentario', autor: 'a@x.com', contenido: 'x', entityRef: 'dbo.t', llave: { id: 1 } })
    await s.marcarRefRota(n.id)
    const after = await s.getNota(n.id)
    expect(after?.refRota).toBe(true)
    expect(after?.contenido).toBe('x')
  })

  it('la estructura de voz existe (contenido_tipo/audio_ref) aunque v1 no la escriba', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    const n = await s.crearNota({ especie: 'anotacion', autor: 'a@x.com', contenido: '(transcripción)', contenidoTipo: 'voz', audioRef: 'blob://1', impresionId: imp.id })
    expect((await s.getNota(n.id))?.contenidoTipo).toBe('voz')
    expect((await s.getNota(n.id))?.audioRef).toBe('blob://1')
  })

  it('una nota refresca last_activity de su impresión (base de la retención)', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s, {}, { now: Date.parse('2026-01-01T00:00:00.000Z') })
    await s.crearNota({ especie: 'anotacion', autor: 'a@x.com', contenido: 'x', impresionId: imp.id })
    const after = await s.getImpresion(imp.id)
    expect(after!.lastActivity > imp.lastActivity).toBe(true)
  })
})

describe('notas-store · compartición gobernada (D8)', () => {
  it('solo el dueño comparte y revoca; la revocación es hacia adelante', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    await expect(s.compartir(imp.id, 'beto@x.com', 'caro@x.com')).rejects.toBeInstanceOf(NotasConflict)
    await s.compartir(imp.id, 'ANA@x.com', 'Beto@X.com')
    expect(await s.tieneComparticionVigente(imp.id, 'beto@x.com')).toBe(true)
    expect((await s.listCompartidasCon('beto@x.com'))[0].impresion.id).toBe(imp.id)
    await expect(s.revocar(imp.id, 'beto@x.com', 'beto@x.com')).rejects.toBeInstanceOf(NotasConflict)
    await s.revocar(imp.id, 'ana@x.com', 'beto@x.com')
    expect(await s.tieneComparticionVigente(imp.id, 'beto@x.com')).toBe(false)
    expect(await s.listCompartidasCon('beto@x.com')).toHaveLength(0)
    // El registro persiste: es auditoría, no un flag.
    const cs = await s.comparticionesDe(imp.id)
    expect(cs).toHaveLength(1)
    expect(cs[0].revocadaAt).toBeTruthy()
  })

  it('compartir dos veces no duplica el registro vigente', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    const c1 = await s.compartir(imp.id, 'ana@x.com', 'beto@x.com')
    const c2 = await s.compartir(imp.id, 'ana@x.com', 'beto@x.com')
    expect(c2.id).toBe(c1.id)
  })
})

describe('notas-store · entrega (estructura D13) y retención (A7)', () => {
  it('el canal de entrega solo admite `enlace` (A6: nada viaja como contenido)', async () => {
    const s = await SqliteNotasStore.open(null)
    const imp = await abrir(s)
    await s.registrarEntrega(imp.id, 'beto@x.com', 'enlace', 'ana@x.com')
    expect((await s.entregasDe(imp.id))[0].canal).toBe('enlace')
    await expect(
      s.registrarEntrega(imp.id, 'beto@x.com', 'adjunto' as unknown as 'enlace', 'ana@x.com'),
    ).rejects.toBeTruthy()
  })

  it('la purga borra lo anterior al corte y respeta la actividad reciente', async () => {
    const s = await SqliteNotasStore.open(null)
    const vieja = await abrir(s, { page: 'vieja' }, { now: Date.parse('2025-01-01T00:00:00.000Z') })
    const nueva = await abrir(s, { page: 'nueva' }, { now: Date.parse('2026-07-01T00:00:00.000Z') })
    const purgados = await s.purgarPorRetencion('2025-07-01T00:00:00.000Z')
    expect(purgados).toEqual([vieja.id])
    expect(await s.getImpresion(vieja.id)).toBeNull()
    expect(await s.getImpresion(nueva.id)).not.toBeNull()
  })
})
