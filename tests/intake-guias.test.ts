import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  FAMILIAS_PRODUCTO,
  LINEA_ACTOR,
  DATO_NO_INFORMADO,
  parseIntakeConfig,
  parseIntakeGuias,
  parseIntakeGuiasConfig,
  resolverGuia,
  familiaDe,
  formatoLista,
  interpolarGuia,
  guiasDelSlot,
  type GuiaDecl,
} from '@vergis/capabilities'
import { reloadLiveList } from '../server/hot-reload'

/**
 * H2 de #346 · familias, catálogo de la instancia y resolución de la guía.
 *
 * El YAML de prueba reproduce la forma del `slots.yaml` de una instancia real (slots + bloque `guias:`)
 * y los textos de las guías semilla del diseño (doc 264 §9 del lab de A.R.B.O.L.).
 */
const SLOTS_YAML = `
slots:
  - id: oc_crossdocking_maestro
    label: Maestro de tiendas
    target: { workspaceId: W, lakehouseId: L, path: Files/intake/maestro }
  - id: oc_crossdocking_distribuciones
    label: Distribuciones de OC
    target: { workspaceId: W, lakehouseId: L, path: Files/intake/dist }
  - id: saldos_cartera
    label: Saldos de cartera
    target: { workspaceId: W, lakehouseId: L, path: Files/intake/saldos }
`
const GUIAS_YAML = `
guias:
  familias:
    - familia: vigencia-vencida
      actor: usuario
      titulo: "El archivo es de un período que ya no se acepta"
      que_paso: "El período {periodo} ya está cerrado."
      que_hacer: ["Sube el archivo del período vigente."]
  entradas:
    - codigo: catalogo-incompleto/maestro-tiendas
      slots: [oc_crossdocking_maestro]
      titulo: "El maestro de tiendas tiene que venir completo"
      que_paso: "Este archivo reemplaza la lista entera de tiendas. El que subiste trae {tiendas_archivo} tiendas y dejaría fuera {n} que ya tienen despachos cargados, así que no se aplicó nada."
      que_hacer:
        - "Parte del maestro completo, no de una planilla nueva."
        - "Agrega las tiendas nuevas con su zona, sin borrar ninguna."
        - "Súbelo completo y después vuelve a subir la distribución que había fallado."
    - codigo: referencia-ausente/tienda-sin-zona
      titulo: "La OC trae tiendas que todavía no están en el maestro"
      que_paso: "La distribución de la OC {oc} manda producto a tiendas que el maestro no conoce: {faltan}."
      que_hacer: ["Agrega {faltan} al maestro de tiendas, con nombre y zona.", "Vuelve a subir esta distribución."]
    - codigo: formato
      titulo: "El archivo no tiene la forma que se espera"
      que_paso: "El archivo no calza con el formato de «{slot}»."
      que_hacer: ["Descárgalo de nuevo desde el sistema de origen.", "Súbelo de nuevo."]
    - codigo: formato
      slots: [saldos_cartera]
      titulo: "La planilla de saldos no tiene la forma esperada"
      que_paso: "La planilla {archivo} no calza."
      que_hacer: ["Descárgala de nuevo."]
    - codigo: falla-plataforma
      titulo: "No es por tu archivo: falló el proceso de carga"
      que_paso: "El proceso se detuvo."
      que_hacer: ["No lo corrijas ni lo vuelvas a subir."]
`
const doc = (extra = GUIAS_YAML): unknown => parseYaml(SLOTS_YAML + extra)
const catalogo = (): GuiaDecl[] => parseIntakeGuiasConfig(doc())
const MAESTRO = { id: 'oc_crossdocking_maestro', label: 'Maestro de tiendas' }
const DIST = { id: 'oc_crossdocking_distribuciones', label: 'Distribuciones de OC' }
const SALDOS = { id: 'saldos_cartera', label: 'Saldos de cartera' }

describe('#346·H2 · las 14 familias del Producto', () => {
  it('son 14, con actor fijo y guía genérica completa, sin nombres repetidos', () => {
    expect(FAMILIAS_PRODUCTO).toHaveLength(14)
    expect(new Set(FAMILIAS_PRODUCTO.map((f) => f.familia)).size).toBe(14)
    for (const f of FAMILIAS_PRODUCTO) {
      expect(['usuario', 'operador', 'nadie']).toContain(f.actor)
      expect(f.guia.titulo && f.guia.quePaso && f.guia.queHacer.length).toBeTruthy()
    }
    const actor = Object.fromEntries(FAMILIAS_PRODUCTO.map((f) => [f.familia, f.actor]))
    expect(actor).toMatchObject({ 'falla-plataforma': 'operador', 'en-espera': 'nadie', desplazado: 'nadie', 'bloqueado-por-otro': 'nadie', 'volumen-anomalo': 'usuario', formato: 'usuario' })
  })

  it('bloqueado-por-otro (D-228 del lab A.R.B.O.L.): nombra al causante y se lee bien con uno y con dos', () => {
    const g1 = resolverGuia(MAESTRO, 'bloqueado-por-otro', { causante: ['a.xlsx'] }, [])!
    expect(g1).toMatchObject({ familia: 'bloqueado-por-otro', actor: 'nadie', nivel: 'familia-generica', deInstancia: false })
    expect(g1.titulo).toBe('La carga se detuvo antes de llegar a este archivo')
    expect(g1.quePaso).toBe('La carga se detuvo por un problema al procesar «a.xlsx» y no alcanzó a llegar a este archivo. Nada indica que este archivo tenga un problema: sigue en espera.')
    expect(g1.queHacer).toEqual([
      'No tienes que corregir este archivo ni subirlo de nuevo.',
      'Se vuelve a intentar en cada carga, pero mientras no se resuelva el problema de «a.xlsx», este archivo volverá a quedar detenido.',
      'Si no fuiste tú quien subió «a.xlsx», avísale a quien lo hizo.',
    ])
    const g2 = resolverGuia(MAESTRO, 'bloqueado-por-otro', { causante: ['a.xlsx', 'b.xlsx'] }, [])!
    expect(g2.quePaso).toContain('al procesar «a.xlsx y b.xlsx» y no alcanzó')
    expect(g2.queHacer[1]).toContain('el problema de «a.xlsx y b.xlsx», este archivo')
    expect(g2.queHacer[2]).toBe('Si no fuiste tú quien subió «a.xlsx y b.xlsx», avísale a quien lo hizo.')
  })

  it('las genéricas del Producto no hablan el vocabulario de ninguna instancia', () => {
    const todo = JSON.stringify(FAMILIAS_PRODUCTO).toLowerCase()
    for (const palabra of ['tienda', 'maestro de', 'oc ', 'sodimac', 'plantación', 'dbo.']) expect(todo).not.toContain(palabra)
  })
})

describe('#346·H2 · el bloque `guias:` y su parser separado', () => {
  it('parseIntakeConfig devuelve EXACTAMENTE lo mismo con o sin el bloque `guias:`', () => {
    expect(parseIntakeConfig(doc())).toEqual(parseIntakeConfig(doc('')))
  })

  it('sin el bloque, el catálogo es vacío (legítimo)', () => {
    expect(parseIntakeGuiasConfig(doc(''))).toEqual([])
  })

  it('parsea familias propias y entradas en el orden declarado', () => {
    const c = catalogo()
    expect(c.map((d) => (d.tipo === 'familia' ? `F:${d.familia}` : `E:${d.codigo}${d.slots ? `@${d.slots.join(',')}` : ''}`))).toEqual([
      'F:vigencia-vencida',
      'E:catalogo-incompleto/maestro-tiendas@oc_crossdocking_maestro',
      'E:referencia-ausente/tienda-sin-zona',
      'E:formato',
      'E:formato@saldos_cartera',
      'E:falla-plataforma',
    ])
  })

  it('una familia propia con actor válido se resuelve con SU actor', () => {
    const g = resolverGuia(MAESTRO, 'vigencia-vencida/periodo', { periodo: '2026-01' }, catalogo())
    expect(g).toMatchObject({ familia: 'vigencia-vencida', actor: 'usuario', nivel: 'familia-generica', deInstancia: true })
    expect(g!.quePaso).toBe('El período 2026-01 ya está cerrado.')
    const operador = parseIntakeGuiasConfig(doc(`
guias:
  familias:
    - { familia: sin-red, actor: operador, titulo: t, que_paso: q, que_hacer: [h] }
`))
    expect(resolverGuia(MAESTRO, 'sin-red', undefined, operador)!.actor).toBe('operador')
  })

  const errores: [string, string, RegExp][] = [
    ['familia propia sin actor', `
guias:
  familias:
    - { familia: nueva, titulo: t, que_paso: q, que_hacer: [h] }`, /familia de guía 'nueva'.*'actor' es obligatorio/],
    ['familia propia con actor inválido', `
guias:
  familias:
    - { familia: nueva, actor: cliente, titulo: t, que_paso: q, que_hacer: [h] }`, /'actor' es obligatorio y debe ser usuario \| operador \| nadie/],
    ['familia propia que repite una del Producto', `
guias:
  familias:
    - { familia: formato, actor: nadie, titulo: t, que_paso: q, que_hacer: [h] }`, /familia de guía 'formato'.*ya es una familia del Producto/],
    ['la instancia no redeclara bloqueado-por-otro (un solo hogar: el Producto, D-228)', `
guias:
  familias:
    - { familia: bloqueado-por-otro, actor: usuario, titulo: t, que_paso: q, que_hacer: [h] }`, /familia de guía 'bloqueado-por-otro'.*ya es una familia del Producto/],
    ['EL ACTOR NO SE SOBRESCRIBE DESDE LA GUÍA: una entrada con `actor:`', `
guias:
  entradas:
    - { codigo: falla-plataforma, actor: usuario, titulo: t, que_paso: q, que_hacer: [h] }`, /guía 'falla-plataforma': no admite 'actor'/],
    ['entrada de familia desconocida', `
guias:
  entradas:
    - { codigo: inventada/algo, titulo: t, que_paso: q, que_hacer: [h] }`, /guía 'inventada\/algo': la familia 'inventada' no es del Producto/],
    ['entrada con slot inexistente', `
guias:
  entradas:
    - { codigo: formato, slots: [no_existe], titulo: t, que_paso: q, que_hacer: [h] }`, /guía 'formato': el slot 'no_existe' no existe/],
    ['entrada con que_hacer vacío', `
guias:
  entradas:
    - { codigo: formato, titulo: t, que_paso: q, que_hacer: [] }`, /guía 'formato'.*que_hacer debe ser una lista con al menos un paso/],
    ['entrada sin título', `
guias:
  entradas:
    - { codigo: formato, que_paso: q, que_hacer: [h] }`, /guía 'formato'.*titulo debe ser un texto no vacío/],
    ['código con mayúscula', `
guias:
  entradas:
    - { codigo: Formato, titulo: t, que_paso: q, que_hacer: [h] }`, /guía 'Formato': 'codigo' inválido/],
    ['dos entradas del mismo código para el mismo alcance', `
guias:
  entradas:
    - { codigo: formato, titulo: t, que_paso: q, que_hacer: [h] }
    - { codigo: formato, titulo: t2, que_paso: q, que_hacer: [h] }`, /guía 'formato': duplicada para todos los slots/],
    ['clave desconocida en el bloque', `
guias:
  entradaz: []`, /clave desconocida 'entradaz'/],
  ]
  for (const [nombre, yaml, re] of errores) {
    it(`error de validación · ${nombre}`, () => {
      expect(() => parseIntakeGuiasConfig(doc(yaml))).toThrow(re)
    })
  }

  it('parseIntakeGuias valida contra los slots que se le pasan (los del mismo documento)', () => {
    const d = doc()
    expect(() => parseIntakeGuias(d, [])).toThrow(/el slot 'oc_crossdocking_maestro' no existe/)
    expect(parseIntakeGuias(d, parseIntakeConfig(d))).toEqual(catalogo())
  })
})

describe('#346·H2 · recarga en caliente: validar antes de cambiar', () => {
  it('una recarga con una guía rota CONSERVA las guías vigentes; una buena las intercambia', () => {
    const live: GuiaDecl[] = []
    const errs: string[] = []
    const logs: string[] = []
    let texto = SLOTS_YAML + GUIAS_YAML
    const load = (): GuiaDecl[] => parseIntakeGuiasConfig(parseYaml(texto))
    expect(reloadLiveList(live, load, 'guías de carga', 'boot', (m) => logs.push(m), (m) => errs.push(m), 'guías')).toBe(true)
    const vigentes = JSON.stringify(live)
    expect(live).toHaveLength(6)
    // Rota: una entrada con `actor:`. La recarga falla, lo dice, y lo vigente queda intacto.
    texto = SLOTS_YAML + GUIAS_YAML.replace('    - codigo: falla-plataforma\n', '    - codigo: falla-plataforma\n      actor: usuario\n')
    expect(reloadLiveList(live, load, 'guías de carga', 'watch', (m) => logs.push(m), (m) => errs.push(m), 'guías')).toBe(false)
    expect(JSON.stringify(live)).toBe(vigentes)
    expect(errs.join('\n')).toMatch(/recarga de guías de carga falló \(watch\); guías vigentes conservados: .*no admite 'actor'/)
    // Buena y distinta: se intercambia.
    texto = SLOTS_YAML
    expect(reloadLiveList(live, load, 'guías de carga', 'watch', (m) => logs.push(m), (m) => errs.push(m), 'guías')).toBe(true)
    expect(live).toEqual([])
  })
})

describe('#346·H2 · resolverGuia: la precedencia, un test por nivel', () => {
  it('1 · entrada exacta con `slots` que incluye el slot', () => {
    const g = resolverGuia(MAESTRO, 'catalogo-incompleto/maestro-tiendas', { n: '50', tiendas_archivo: '2' }, catalogo())
    expect(g).toMatchObject({ nivel: 'entrada-slot', actor: 'usuario', deInstancia: true, titulo: 'El maestro de tiendas tiene que venir completo' })
    expect(g!.quePaso).toContain('trae 2 tiendas y dejaría fuera 50 que ya tienen')
  })

  it('1 · …y la misma entrada NO aplica a otro slot: cae a la genérica de la familia del Producto', () => {
    const g = resolverGuia(DIST, 'catalogo-incompleto/maestro-tiendas', { n: '50' }, catalogo())
    expect(g).toMatchObject({ nivel: 'familia-generica', deInstancia: false, titulo: 'El archivo tiene que venir completo' })
  })

  it('2 · entrada exacta sin `slots`', () => {
    const g = resolverGuia(DIST, 'referencia-ausente/tienda-sin-zona', { oc: '17525983', faltan: ['58', '88'] }, catalogo())
    expect(g).toMatchObject({ nivel: 'entrada', actor: 'usuario' })
    expect(g!.quePaso).toBe('La distribución de la OC 17525983 manda producto a tiendas que el maestro no conoce: 58 y 88.')
    expect(g!.queHacer[0]).toBe('Agrega 58 y 88 al maestro de tiendas, con nombre y zona.')
  })

  it('3 · entrada con el código de la familia sola, con `slots` (gana sobre la de sin slots)', () => {
    const g = resolverGuia(SALDOS, 'formato/columnas', undefined, catalogo(), 'saldos 2026W38.xlsx')
    expect(g).toMatchObject({ nivel: 'familia-slot', titulo: 'La planilla de saldos no tiene la forma esperada' })
    expect(g!.quePaso).toBe('La planilla saldos 2026W38.xlsx no calza.')
  })

  it('4 · entrada con el código de la familia sola, sin `slots` — `{slot}` lo pone la plataforma', () => {
    const g = resolverGuia(MAESTRO, 'formato/hoja-ambigua', undefined, catalogo())
    expect(g).toMatchObject({ nivel: 'familia-entrada', codigo: 'formato/hoja-ambigua', familia: 'formato' })
    expect(g!.quePaso).toBe('El archivo no calza con el formato de «Maestro de tiendas».')
  })

  it('5 · sin guía de instancia: la genérica de la familia del Producto, con su actor', () => {
    const g = resolverGuia(MAESTRO, 'en-espera/trio', undefined, catalogo())
    expect(g).toMatchObject({ nivel: 'familia-generica', actor: 'nadie', deInstancia: false })
    expect(g!.titulo).toBe(FAMILIAS_PRODUCTO.find((f) => f.familia === 'en-espera')!.guia.titulo)
  })

  it('6 · sin guía: sin código, código inválido o familia desconocida', () => {
    expect(resolverGuia(MAESTRO, undefined, undefined, catalogo())).toBeNull()
    expect(resolverGuia(MAESTRO, 'Formato', undefined, catalogo())).toBeNull()
    expect(resolverGuia(MAESTRO, 'desconocida/x', undefined, catalogo())).toBeNull()
    expect(familiaDe('desconocida/x', catalogo())).toBeNull()
  })

  it('el ACTOR sale siempre de la familia: la guía de instancia de falla-plataforma sigue siendo del operador', () => {
    const g = resolverGuia(MAESTRO, 'falla-plataforma', undefined, catalogo())
    expect(g).toMatchObject({ nivel: 'entrada', actor: 'operador', deInstancia: true })
    expect(LINEA_ACTOR[g!.actor]).toBe('No es por tu archivo: el proceso de carga tuvo un problema propio')
  })
})

describe('#346·H2 · interpolación', () => {
  it('lista corta, lista mediana y lista larga', () => {
    expect(formatoLista(['58'])).toBe('58')
    expect(formatoLista(['58', '88'])).toBe('58 y 88')
    expect(formatoLista(['58', '88', '95', '7'])).toBe('58, 88, 95 y 7')
    expect(formatoLista(['58', '88', '95', '1', '2', '3', '4', '5', '6', '7'])).toBe('58, 88, 95 y 7 más')
  })

  it('un marcador sin dato no rompe: queda «(dato no informado)»; las llaves que no son marcador quedan', () => {
    expect(interpolarGuia('faltan {faltan} en {oc}; {Otra} {no-marcador}', { faltan: ['58', '88'] })).toBe(
      `faltan 58 y 88 en ${DATO_NO_INFORMADO}; {Otra} {no-marcador}`,
    )
    const g = resolverGuia(MAESTRO, 'catalogo-incompleto/maestro-tiendas', {}, catalogo())
    expect(g!.quePaso).toContain(`trae ${DATO_NO_INFORMADO} tiendas`)
  })

  it('`{slot}` y `{archivo}` son de la plataforma: el job no los pisa', () => {
    const g = resolverGuia(MAESTRO, 'formato', { slot: 'falso', archivo: 'falso.xlsx' }, catalogo())
    expect(g!.quePaso).toBe('El archivo no calza con el formato de «Maestro de tiendas».')
  })
})

describe('#346·H2 · guías que aplican a un slot (insumo de «Errores frecuentes»)', () => {
  it('entradas sin slots + las del slot + familias propias; un código aparece una vez', () => {
    expect(guiasDelSlot(MAESTRO, catalogo())).toEqual(['vigencia-vencida', 'catalogo-incompleto/maestro-tiendas', 'referencia-ausente/tienda-sin-zona', 'formato', 'falla-plataforma'])
    expect(guiasDelSlot(SALDOS, catalogo())).toEqual(['vigencia-vencida', 'referencia-ausente/tienda-sin-zona', 'formato', 'falla-plataforma'])
  })
})
