// El ENSAMBLADO del Datadoc (CAP-197): el cruce de los cinco insumos.
//
// Lo que se mide acá es lo que el catálogo dice CUANDO FALTA ALGO — que es el caso normal, no el
// excepcional. Sin escritores declarados, sin diccionario, sin dominios, con una conexión caída: en
// los cuatro el catálogo tiene que salir, con el hueco dicho con sus palabras y jamás con un valor
// inventado ni un `undefined` en la página.

import { describe, it, expect } from 'vitest'
import { ensamblar } from '../server/datadoc-modelo'
import type { ModeloConexion } from '../server/datadoc-introspect'
import { parseWritersConfig } from '../server/writers-config'
import { parseSemanticaConfig } from '../server/semantica-config'
import { parseDomainsConfig } from '@vergis/capabilities'
import type { Report } from '../server/discovery'

const T0 = '2026-09-21T12:00:00.000Z'
const reloj = (): Date => new Date(T0)

function modeloDe(over: Partial<ModeloConexion> = {}): ModeloConexion {
  return {
    ref: 'finanzas',
    database: 'wh_finanzas',
    server: 'endpoint.example',
    medidoEn: T0,
    ms: 120,
    objetos: [
      { ref: 'dbo.fact_saldos', schema: 'dbo', nombre: 'fact_saldos', esVista: false },
      { ref: 'dbo.huerfana', schema: 'dbo', nombre: 'huerfana', esVista: false },
      { ref: 'dbo.v_saldos', schema: 'dbo', nombre: 'v_saldos', esVista: true },
    ],
    columnas: {
      'dbo.fact_saldos': [{ nombre: 'Fecha_Carga', ordinal: 1, tipo: 'date', nulable: false }],
      'dbo.v_saldos': [{ nombre: 'Fecha_Carga', ordinal: 1, tipo: 'date', nulable: false }],
    },
    vistasDef: { 'dbo.v_saldos': 'CREATE VIEW …' },
    linaje: [{ vista: 'dbo.v_saldos', base: 'dbo.fact_saldos', schemabound: true }],
    gobierno: {
      'dbo.fact_saldos': { clase: 'abierta', politicas: [{ secpol: 'secpol_x', habilitada: true, predicado: '([dbo].[fn]())', funcion: 'dbo.fn', clase: 'abierta' }] },
      'dbo.huerfana': { clase: 'no gobernada', politicas: [] },
    },
    conteos: { 'dbo.fact_saldos': 1234 },
    esquemas: ['dbo'],
    errores: [],
    ...over,
  }
}

const PI: Report = {
  code: 'PI-07',
  slug: 'pi-07',
  name: 'Cartera',
  specName: 'Cartera',
  specPath: 'x.yaml',
  proto: 'mira',
  tables: ['dbo.v_saldos'],
  databaseRefs: ['finanzas'],
}

const base = { modelos: [modeloDe()], refs: ['finanzas'], now: reloj }

describe('ensamblar · sin NINGUNA declaración de instancia', () => {
  const m = ensamblar(base)
  it('el catálogo sale igual y la conexión se presenta como DOMINIO TÉCNICO, rotulada por su ref', () => {
    expect(m.dominios).toEqual([{ id: 'finanzas', label: 'finanzas', tecnico: true, conexiones: ['finanzas'] }])
  })
  it('«escritor no declarado», con esas palabras — nunca una atribución adivinada', () => {
    const e = m.entidades.find((x) => x.ref === 'dbo.fact_saldos')!
    expect(e.escritor).toBe('<i>escritor no declarado</i>')
  })
  it('sin descripción: cadena vacía, jamás `undefined` en la página', () => {
    for (const e of m.entidades) {
      expect(e.descripcion).toBe('')
      for (const c of e.columnas) expect(c.significado).toBe('')
    }
  })
  it('una tabla sin lector, sin escritor y sin política es DEUDA, con su motivo', () => {
    const h = m.entidades.find((x) => x.ref === 'dbo.huerfana')!
    expect(h.clase).toBe('deuda')
    expect(h.motivoDeuda).toMatch(/sin consumidor/)
  })
})

describe('ensamblar · la clasificación sale de HECHOS medidos', () => {
  it('una vista es `publicado`; una tabla con política es `interno` aunque nadie la lea', () => {
    const m = ensamblar(base)
    expect(m.entidades.find((e) => e.ref === 'dbo.v_saldos')!.clase).toBe('publicado')
    expect(m.entidades.find((e) => e.ref === 'dbo.fact_saldos')!.clase).toBe('interno')
  })
  it('un escritor VIGENTE basta para que deje de ser deuda', () => {
    const writers = parseWritersConfig({
      writers: [{ id: 'w', conexion: 'finanzas', tipo: 'sjd', estado: 'vigente', disparo: 'nocturno', tablas: ['dbo.huerfana'] }],
    })
    const m = ensamblar({ ...base, writers })
    const h = m.entidades.find((e) => e.ref === 'dbo.huerfana')!
    expect(h.clase).toBe('interno')
    expect(h.escritor).toContain('<b>w</b>')
    expect(h.escritor).toContain('disparo: nocturno')
  })
  it('las convenciones de nombre de la instancia NO entran al motor: `_bak_x` sale deuda por el hecho, no por el prefijo', () => {
    const mod = modeloDe({ objetos: [{ ref: 'dbo._bak_viejo', schema: 'dbo', nombre: '_bak_viejo', esVista: false }], gobierno: {}, conteos: {} })
    const m = ensamblar({ ...base, modelos: [mod] })
    expect(m.entidades[0].clase).toBe('deuda')
    expect(m.entidades[0].claseForzada).toBe(false)
  })
  it('…y la instancia la fuerza por entidad, que es donde su alfabeto vive', () => {
    const semantica = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'finanzas', entidades: { 'dbo.huerfana': { clase: 'interno' } } }] } })
    const m = ensamblar({ ...base, semantica })
    const h = m.entidades.find((e) => e.ref === 'dbo.huerfana')!
    expect(h.clase).toBe('interno')
    expect(h.claseForzada).toBe(true)
  })
})

describe('ensamblar · lectores efectivos', () => {
  it('un PI que lee la VISTA se propaga a la tabla base, declarando el camino', () => {
    const m = ensamblar({ ...base, reports: [PI] })
    const f = m.entidades.find((e) => e.ref === 'dbo.fact_saldos')!
    // REFUTARÍA: sin propagar, un hecho en pleno uso saldría «sin consumidor» — afirmación falsa.
    expect(f.lectores).toEqual([{ code: 'PI-07', via: 'dbo.v_saldos' }])
    expect(m.entidades.find((e) => e.ref === 'dbo.v_saldos')!.lectores).toEqual([{ code: 'PI-07' }])
  })
  it('un PI de OTRA conexión no atribuye lectores acá', () => {
    const m = ensamblar({ ...base, reports: [{ ...PI, databaseRefs: ['ventas'] }] })
    expect(m.entidades.flatMap((e) => e.lectores)).toEqual([])
  })
})

describe('ensamblar · dominios declarados', () => {
  it('`domains[].connections` agrupa conexiones bajo su etiqueta', () => {
    const domains = parseDomainsConfig({ domains: [{ id: 'fin', label: 'Finanzas', connections: ['finanzas'] }] })
    const m = ensamblar({ ...base, domains })
    expect(m.dominios).toEqual([{ id: 'fin', label: 'Finanzas', tecnico: false, conexiones: ['finanzas'] }])
    expect(m.conexiones[0].dominioId).toBe('fin')
  })
  it('un dominio que reclama una conexión inexistente avisa y no inventa nada', () => {
    const domains = parseDomainsConfig({ domains: [{ id: 'fin', label: 'Finanzas', connections: ['finanzas', 'fantasma'] }] })
    const m = ensamblar({ ...base, domains })
    expect(m.avisos.some((a) => /reclama la conexión 'fantasma'/.test(a))).toBe(true)
    expect(m.dominios[0].conexiones).toEqual(['finanzas'])
  })
  it('NO se infiere el dominio por parecido de nombre', () => {
    // `wh_finanzas` ≈ `finanzas` es una coincidencia, no un hecho.
    const domains = parseDomainsConfig({ domains: [{ id: 'finanzas', label: 'Finanzas' }] })
    const m = ensamblar({ ...base, domains })
    expect(m.dominios).toEqual([{ id: 'finanzas', label: 'finanzas', tecnico: true, conexiones: ['finanzas'] }])
  })
})

describe('ensamblar · una conexión que HOY no respondió', () => {
  it('conserva su modelo anterior, lo marca con el motivo y NO desaparece del catálogo', () => {
    const m = ensamblar({ ...base, fallidas: { finanzas: 'ETIMEDOUT' } })
    const c = m.conexiones[0]
    // REFUTARÍA: entidades ausentes afirmarían que no existen — más fuerte y más falso que «hoy no
    // la pude mirar».
    expect(c.medidaHoy).toBe(false)
    expect(c.error).toBe('ETIMEDOUT')
    expect(c.medidoEn).toBe(T0)
    expect(m.entidades.length).toBeGreaterThan(0)
  })
  it('una conexión declarada y NUNCA medida aparece en el sello, sin entidades', () => {
    const m = ensamblar({ ...base, refs: ['finanzas', 'ventas'], fallidas: { ventas: 'nunca medida' } })
    const v = m.conexiones.find((c) => c.ref === 'ventas')!
    expect(v.medidaHoy).toBe(false)
    expect(v.entidades).toEqual([])
    expect(v.database).toBeNull()
  })
})

describe('ensamblar · filas: el texto dice POR QUÉ no hay número', () => {
  const con = (clase: 'filtrada' | 'indeterminada') =>
    ensamblar({ ...base, modelos: [modeloDe({ gobierno: { 'dbo.fact_saldos': { clase, politicas: [] } }, conteos: {} })] })
  it('una tabla filtrada dice «no medidas (tabla gobernada por RLS con filtro)», no un guion mudo', () => {
    const e = con('filtrada').entidades.find((x) => x.ref === 'dbo.fact_saldos')!
    expect(e.filas.medido).toBe(false)
    expect(e.filas.texto).toBe('no medidas (tabla gobernada por RLS con filtro)')
  })
  it('una indeterminada dice que no se pregunta', () => {
    expect(con('indeterminada').entidades.find((x) => x.ref === 'dbo.fact_saldos')!.filas.texto).toMatch(/no se pregunta/)
  })
  it('con `conteos: off` lo dice con esas palabras', () => {
    const m = ensamblar({ ...base, modelos: [modeloDe({ conteos: {} })], conteos: 'off' })
    expect(m.entidades.find((e) => e.ref === 'dbo.fact_saldos')!.filas.texto).toMatch(/conteos están apagados/)
  })
  it('un build RANCIO retira el número aunque el modelo lo traiga', () => {
    const m = ensamblar({ ...base, rancio: { razon: 'watch:policies', desde: T0 } })
    // REFUTARÍA: publicar 1.234 acá sería republicar, bajo un gobierno nuevo, un número calculado
    // bajo el anterior.
    expect(m.entidades.find((e) => e.ref === 'dbo.fact_saldos')!.filas.texto).toMatch(/rancio/)
    expect(m.entidades.find((e) => e.ref === 'dbo.fact_saldos')!.filas.medido).toBe(false)
  })
  it('una vista muestra «= base» con el número de su base', () => {
    const m = ensamblar(base)
    expect(m.entidades.find((e) => e.ref === 'dbo.v_saldos')!.filas.texto).toBe('1.234 (= base)')
  })
})

describe('ensamblar · semántica', () => {
  const semantica = parseSemanticaConfig({
    semantica: {
      conexiones: [
        {
          conexion: 'finanzas',
          intro: 'Antigüedad de `saldos`',
          entidades: { 'dbo.fact_saldos': { descripcion: 'El hecho', columnas: { fecha_carga: 'Semana de la carga' } } },
        },
      ],
    },
  })
  it('una VISTA sin entrada propia hereda la semántica de su base (linaje de `sys`)', () => {
    const m = ensamblar({ ...base, semantica })
    const v = m.entidades.find((e) => e.ref === 'dbo.v_saldos')!
    // El consumidor lee por la vista; repetir el diccionario en las dos es la forma más barata de
    // hacerlo driftar.
    expect(v.descripcion).toBe('El hecho')
    expect(v.columnas[0].significado).toBe('Semana de la carga')
  })
  it('el texto de instancia llega ESCAPADO al modelo, con el acento grave convertido', () => {
    const m = ensamblar({ ...base, semantica })
    expect(m.conexiones[0].intro).toBe('Antigüedad de <code>saldos</code>')
  })
  it('una conexión declarada que el nodo no conoce avisa y se ignora', () => {
    const s = parseSemanticaConfig({ semantica: { conexiones: [{ conexion: 'fantasma', intro: 'x' }] } })
    expect(ensamblar({ ...base, semantica: s }).avisos.some((a) => /'fantasma', desconocida/.test(a))).toBe(true)
  })
})

describe('ensamblar · números vivos de seguridad', () => {
  it('cuenta políticas por su clase medida y nombra las que filtran', () => {
    const mod = modeloDe({
      gobierno: {
        'dbo.fact_saldos': { clase: 'filtrada', politicas: [{ secpol: 'p1', habilitada: true, predicado: 'x', clase: 'filtrada' }] },
        'dbo.huerfana': { clase: 'abierta', politicas: [{ secpol: 'p2', habilitada: true, predicado: 'y', clase: 'abierta' }] },
      },
      conteos: {},
    })
    const s = ensamblar({ ...base, modelos: [mod] }).seguridad
    expect(s).toMatchObject({ politicas: 2, abiertas: 1, filtradas: 1, indeterminadas: 0 })
    expect(s.conFiltro).toEqual(['finanzas · dbo.fact_saldos'])
  })
})
