/**
 * ENSAMBLAR el Datadoc (`CAP-197`) — el cruce de los cinco insumos en un modelo que el render dibuja
 * sin pensar. Función pura: recibe datos, devuelve datos. No mide, no toca disco, no llama a nadie.
 *
 * Los insumos y de quién es cada uno:
 *
 *  · **Lo medido** (`modelos`): qué existe en cada conexión, su forma, su gobierno y sus conteos.
 *  · **Las specs de los PI** (`reports`): quién LEE cada tabla. Sale de `discover()`, o sea de
 *    `analyzeSqlTables` —la misma extracción del gate de gobernanza—, no de un regex propio.
 *  · **El registro de fuentes** (`sources`): de dónde viene cada tabla y con qué cadencia.
 *  · **Los escritores** (`writers`): quién la escribe. Declaración de instancia.
 *  · **La semántica** (`semantica`): qué significa. Declaración de instancia.
 *
 * ── LO QUE NO SE INVENTA, NUNCA ─────────────────────────────────────────────────────────────────
 * Sin `writers`, una tabla dice «escritor no declarado». Sin `semantica`, «sin descripción». Sin
 * `domains[].connections`, la conexión es un **dominio técnico** rotulado por su `database_ref` — y
 * no se infiere por parecido de nombre (`wh_finanzas` ≈ `finanzas` es una coincidencia, no un hecho).
 * Una conexión que no se pudo medir hoy aparece con su medición anterior y la marca de que es vieja.
 *
 * ── LA CLASIFICACIÓN ES POR HECHOS MEDIDOS ──────────────────────────────────────────────────────
 * `publicado` = es una vista · `interno` = tiene lector, escritor vigente o política · `deuda` = nada
 * de lo anterior. Las convenciones de nombre de una instancia (`_bak_*`, `raw_*`, prefijos de
 * plataforma) **no entran al motor**: son su alfabeto, no el del Producto, y quien las tenga las
 * expresa con `clase:` en su `semantica.yaml`. Un motor que conoce los prefijos de un cliente es un
 * motor que hay que editar cada vez que llega otro.
 *
 * ── UNA IMPRECISIÓN DECLARADA ───────────────────────────────────────────────────────────────────
 * `Report.tables` no dice en CUÁL de las conexiones del PI vive cada tabla: el descubrimiento las
 * junta. Un PI que lee dos conexiones se atribuye como lector de su tabla en **las dos**, si el
 * nombre existe en ambas. No es inferencia sobre datos que no se tienen: es la precisión que el dato
 * disponible da, y se declara acá en vez de fingir que el cruce es exacto.
 */

import type { Report } from './discovery'
import { escapeHtml, type DomainDecl, type SourcesConfig } from '@vergis/capabilities'
import type { ClaseGobierno, ModeloConexion, PoliticaConteos } from './datadoc-introspect'
import { escritoresDe, type WriterDecl, type WritersConfig } from './writers-config'
import { semanticaDe, semanticaEntidad, textoInline, type ClaseEntidad, type SemanticaConfig } from './semantica-config'

/** Una columna, ya con su significado resuelto (heredado de la base si es vista sin entrada propia). */
export interface ColumnaDatadoc {
  nombre: string
  tipo: string
  nulable: boolean
  /** HTML SEGURO (texto de instancia escapado + acentos graves). `''` = sin documentar. */
  significado: string
}

/** Lo que el catálogo dice de las filas de una entidad, y por qué. */
export interface FilasDatadoc {
  /** Texto listo para mostrar. */
  texto: string
  /** ¿Es un número medido? `false` cubre «no medidas», «= base» y «—». */
  medido: boolean
}

export interface LectorDatadoc {
  code: string
  /** La vista por la que lo consume, si no es directo. */
  via?: string
}

export interface EntidadDatadoc {
  /** `schema.tabla` en minúsculas. */
  ref: string
  conexion: string
  schema: string
  nombre: string
  esVista: boolean
  clase: ClaseEntidad
  /** `true` si la clase la forzó la instancia en `semantica.yaml` en vez de derivarse de lo medido. */
  claseForzada: boolean
  /** Solo para `deuda`: por qué lo es. */
  motivoDeuda?: string
  /** HTML seguro. `''` = sin descripción (hueco honesto y visible). */
  descripcion: string
  columnas: ColumnaDatadoc[]
  filas: FilasDatadoc
  lectores: LectorDatadoc[]
  /** HTML seguro con quién la escribe, o «sin escritor declarado». */
  escritor: string
  /** HTML seguro con de dónde proviene y su cadencia, si el registro de fuentes lo dice. */
  oferta?: string
  /** HTML seguro con el estado de gobierno medido. */
  gobierno: string
  claseGobierno: ClaseGobierno
  /** Para una vista: su tabla base (linaje de `sys`). */
  base?: string
  /** Para una tabla base: las vistas que la exponen. */
  vistas: string[]
}

export interface ConexionDatadoc {
  ref: string
  /** El dominio que la reclama, o su dominio técnico (cuyo `id` es el propio `ref`). */
  dominioId: string
  database: string | null
  server: string | null
  /** ¿Se midió en ESTA corrida? `false` con `medidoEn` presente = se muestra la medición vieja. */
  medidaHoy: boolean
  medidoEn: string | null
  ms: number | null
  /** Por qué no se midió hoy. `null` si se midió. */
  error: string | null
  errores: string[]
  intro: string
  joins: string[]
  entidades: EntidadDatadoc[]
  pis: { code: string; nombre: string }[]
  esquemas: string[]
}

export interface DominioDatadoc {
  id: string
  label: string
  /** `true` = no lo declaró nadie: es la conexión presentándose por sí sola. */
  tecnico: boolean
  conexiones: string[]
}

/** Números vivos de la página de seguridad — medidos, sin juicio de instancia encima. */
export interface SeguridadDatadoc {
  politicas: number
  abiertas: number
  filtradas: number
  indeterminadas: number
  /** `conexion · schema.tabla` de cada tabla con predicado que FILTRA. */
  conFiltro: string[]
}

export interface ModeloDatadoc {
  generadoEn: string
  dominios: DominioDatadoc[]
  conexiones: ConexionDatadoc[]
  /** Todas las entidades de todas las conexiones, para el índice global y el buscador. */
  entidades: EntidadDatadoc[]
  pis: { code: string; nombre: string }[]
  seguridad: SeguridadDatadoc
  conteos: PoliticaConteos
  /** El gobierno cambió desde la última medición: los conteos se retiran y la página lo declara. */
  rancio: { razon: string; desde: string } | null
  /** Texto de portada declarado por la instancia, ya seguro. */
  portada: string
  /** Texto de seguridad declarado por la instancia, ya seguro. */
  seguridadTexto: string
  /** Lo que se omitió o no se pudo cruzar, en una línea cada cosa. */
  avisos: string[]
}

export interface EntradaEnsamblado {
  /** Los modelos que hay: los medidos hoy y los conservados de corridas anteriores. */
  modelos: readonly ModeloConexion[]
  /** `ref` → por qué NO se midió hoy. Una entrada acá con modelo presente = medición vieja. */
  fallidas?: Readonly<Record<string, string>>
  /** Las conexiones declaradas, aunque nunca se hayan medido (para que el sello las nombre). */
  refs?: readonly string[]
  reports?: readonly Report[]
  domains?: readonly DomainDecl[]
  writers?: WritersConfig
  semantica?: SemanticaConfig
  sources?: SourcesConfig | Record<string, never>
  conteos?: PoliticaConteos
  rancio?: { razon: string; desde: string } | null
  now?: () => Date
}

const OFERTA_LEGIBLE: Record<string, string> = {
  P1D: 'diaria',
  P1W: 'semanal',
  P1M: 'mensual (cierre de mes)',
  evento: 'por evento (cuando llega la carga; sin cadencia periódica)',
}

const nf = (n: number): string => Number(n).toLocaleString('es-CL')

/** `schema.tabla` de una referencia cualquiera, o `null`. Mismo criterio que el registro de escritores. */
function normRef(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/[[\]]/g, '')
    .trim()
    .toLowerCase()
  const partes = s.split('.')
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null
  return `${partes[0]}.${partes[1]}`
}

/** El HTML de quién escribe una tabla. Vigente → proceso registrado → declarado no vigente → nada. */
function escritorHtml(
  writers: WritersConfig | undefined,
  sources: SourcesConfig | Record<string, never> | undefined,
  ref: string,
  tabla: string,
): string {
  const todos = escritoresDe(writers, tabla, ref)
  const vigentes = todos.filter((w) => w.estado === 'vigente')
  const linea = (w: WriterDecl): string => `<b>${escapeHtml(w.id)}</b> (${escapeHtml(w.tipo)}) — disparo: ${escapeHtml(w.disparo)}`
  if (vigentes.length) return vigentes.map(linea).join('<br>')
  // Sin escritor vigente: el registro de fuentes puede saber qué proceso la produce. Se dice CON esas
  // palabras —«sin declaración en el registro de escritores»— para que el hueco siga visible.
  const salidas = (sources as SourcesConfig)?.processOutputs ?? []
  const procesos = (sources as SourcesConfig)?.processes ?? []
  const salida = salidas.find((o) => normRef(o.tableRef) === tabla)
  const proceso = salida ? procesos.find((p) => p.id === salida.processId) : undefined
  if (proceso)
    return (
      `<b>${escapeHtml(proceso.id)}</b> — ${escapeHtml(proceso.label ?? '')} ` +
      `<i>(proceso del registro de fuentes; sin declaración en el registro de escritores)</i>`
    )
  if (todos.length) return todos.map((w) => `${escapeHtml(w.id)} <i>(${escapeHtml(w.estado)})</i>`).join('<br>')
  return '<i>escritor no declarado</i>'
}

/** De dónde proviene la tabla y con qué cadencia, según el registro de fuentes. */
function ofertaHtml(sources: SourcesConfig | Record<string, never> | undefined, tabla: string): string | undefined {
  const mapeos = (sources as SourcesConfig)?.tableSources ?? []
  const fuentes = (sources as SourcesConfig)?.sources ?? []
  const mapeo = mapeos.find((t) => normRef(t.tableRef) === tabla)
  if (!mapeo) return undefined
  const fuente = fuentes.find((s) => s.id === mapeo.sourceId)
  if (!fuente) return undefined
  const cadencia = OFERTA_LEGIBLE[fuente.oferta] ?? fuente.oferta
  return `${escapeHtml(fuente.label)} — actualización <b>${escapeHtml(cadencia)}</b>`
}

/** El texto del estado de gobierno de una entidad, medido. */
function gobiernoHtml(modelo: ModeloConexion, ref: string, esVista: boolean, secpolCaida: boolean): string {
  if (esVista) {
    const propia = Object.entries(modelo.gobierno).filter(([k]) => k === ref)
    if (propia.length && propia[0][1].politicas.length)
      return `⚠ la vista aparece como objetivo de una política de seguridad (${propia[0][1].politicas.map((p) => escapeHtml(p.secpol)).join(', ')}) — inesperado, verificar.`
    return 'hereda el gobierno de su tabla base (sin política propia).'
  }
  const g = modelo.gobierno[ref]
  if (!g) return 'no medido en esta corrida.'
  if (g.clase === 'no gobernada') return 'sin política de seguridad de fila (el motor no la filtra por consumidor).'
  if (g.clase === 'indeterminada' && !g.politicas.length)
    return secpolCaida
      ? 'no se pudo determinar: el barrido de políticas de seguridad falló en esta conexión (ver los sub-errores del dominio).'
      : 'política presente, predicado no localizado — <b>indeterminado</b>.'
  return g.politicas
    .map((p) => {
      const estado =
        p.clase === 'abierta'
          ? 'predicado <b>abierto</b> (allow-all explícito: deja pasar todo)'
          : p.clase === 'filtrada'
            ? `predicado <b>con filtro</b>${p.funcion ? ` (<code>${escapeHtml(p.funcion)}</code>)` : ''} — <b>no</b> es allow-all`
            : 'predicado <b>indeterminado</b> (su función no se localizó en <code>sys.sql_modules</code>)'
      return `política <code>${escapeHtml(p.secpol)}</code>${p.habilitada ? '' : ' <b>(deshabilitada)</b>'} · ${estado}`
    })
    .join('<br>')
}

/**
 * El texto de filas de una entidad — y la razón cuando no hay número.
 *
 * ⚠ El orden de estas guardas ES la regla, no estilo. Los conteos viven en el MODELO CACHEADO, que
 * sobrevive a las corridas: preguntar primero «¿hay número?» y solo después «¿se puede publicar?»
 * republicaría, bajo un gobierno que cambió, un número calculado bajo el anterior. Por eso las dos
 * condiciones que lo prohíben —el build rancio y los conteos apagados— se evalúan ANTES de mirar el
 * número, y también para las vistas, que lo heredan de su base.
 */
function filasDe(
  modelo: ModeloConexion,
  ent: { ref: string; esVista: boolean },
  base: string | undefined,
  conteos: PoliticaConteos,
  rancio: boolean,
): FilasDatadoc {
  if (rancio) return { texto: 'no medidas (catálogo marcado rancio: el gobierno cambió desde la medición)', medido: false }
  if (conteos === 'off') return { texto: 'no medidas (los conteos están apagados en esta plataforma)', medido: false }
  if (ent.esVista) {
    if (base && modelo.conteos[base] != null) return { texto: `${nf(modelo.conteos[base])} (= base)`, medido: true }
    return { texto: '= base', medido: false }
  }
  const n = modelo.conteos[ent.ref]
  if (n != null) return { texto: nf(n), medido: true }
  const clase = modelo.gobierno[ent.ref]?.clase
  if (clase === 'filtrada') return { texto: 'no medidas (tabla gobernada por RLS con filtro)', medido: false }
  if (clase === 'indeterminada') return { texto: 'no medidas (gobierno indeterminado: no se pregunta)', medido: false }
  return { texto: '—', medido: false }
}

/**
 * Ensambla el modelo completo. **Pura**: mismo `entrada`, mismo resultado (salvo `generadoEn`, que
 * viene del reloj que se le pase).
 */
export function ensamblar(entrada: EntradaEnsamblado): ModeloDatadoc {
  const ahora = entrada.now ?? ((): Date => new Date())
  const conteos: PoliticaConteos = entrada.conteos ?? 'abiertas'
  const rancio = entrada.rancio ?? null
  const avisos: string[] = []
  const porRef = new Map(entrada.modelos.map((m) => [m.ref, m]))
  const fallidas = entrada.fallidas ?? {}
  // Universo de conexiones: las declaradas (aunque nunca se hayan medido) ∪ las que tienen modelo ∪
  // las que fallaron. Una conexión declarada y jamás medida TIENE que aparecer en el sello: su
  // ausencia se leería como «no existe», que es distinto de «nunca respondió».
  const refs = [...new Set([...(entrada.refs ?? []), ...porRef.keys(), ...Object.keys(fallidas)])].sort()

  // ── Dominios: los declarados que reclaman alguna conexión viva, más un técnico por cada huérfana ──
  const dominios: DominioDatadoc[] = []
  const dominioDe = new Map<string, string>()
  for (const d of entrada.domains ?? []) {
    const suyas = (d.connections ?? []).filter((r) => refs.includes(r))
    const reclamadasAusentes = (d.connections ?? []).filter((r) => !refs.includes(r))
    for (const r of reclamadasAusentes)
      avisos.push(`el dominio '${d.id}' reclama la conexión '${r}', que no está declarada en VERGIS_CONNECTIONS — se ignora.`)
    if (!suyas.length) continue
    dominios.push({ id: d.id, label: d.label, tecnico: false, conexiones: suyas })
    for (const r of suyas) dominioDe.set(r, d.id)
  }
  for (const r of refs) {
    if (dominioDe.has(r)) continue
    // Dominio TÉCNICO: la conexión se presenta por sí sola. No se le busca un dominio parecido.
    dominios.push({ id: r, label: r, tecnico: true, conexiones: [r] })
    dominioDe.set(r, r)
  }

  // ── PIs: lectores por tabla, y qué PI toca cada conexión ──────────────────────────────────────
  const reports = entrada.reports ?? []
  const pisDe = (ref: string): { code: string; nombre: string }[] =>
    reports.filter((r) => r.databaseRefs.includes(ref)).map((r) => ({ code: r.code, nombre: r.name }))
  const pisTodos = [...reports].map((r) => ({ code: r.code, nombre: r.name })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))

  // ── Escritores declarados sobre conexiones que nadie declaró ───────────────────────────────────
  for (const w of entrada.writers?.writers ?? [])
    if (!refs.includes(w.conexion)) avisos.push(`el escritor '${w.id}' declara la conexión '${w.conexion}', desconocida para el nodo — sus tablas no se pueden atribuir.`)
  for (const c of entrada.semantica?.conexiones ?? [])
    if (!refs.includes(c.conexion)) avisos.push(`la semántica declara la conexión '${c.conexion}', desconocida para el nodo — se ignora.`)
  for (const w of entrada.writers?.writers ?? []) {
    if (!w.proceso) continue
    const procesos = (entrada.sources as SourcesConfig)?.processes ?? []
    if (!procesos.some((p) => p.id === w.proceso))
      avisos.push(`el escritor '${w.id}' enlaza al proceso '${w.proceso}', que el registro de fuentes no declara — el enlace no se dibuja.`)
  }
  avisos.push(...(entrada.writers?.warnings ?? []))
  avisos.push(...(entrada.semantica?.warnings ?? []))

  // ── Conexión por conexión ──────────────────────────────────────────────────────────────────────
  const conexiones: ConexionDatadoc[] = []
  const todasLasEntidades: EntidadDatadoc[] = []
  const seguridad: SeguridadDatadoc = { politicas: 0, abiertas: 0, filtradas: 0, indeterminadas: 0, conFiltro: [] }

  for (const ref of refs) {
    const sem = semanticaDe(entrada.semantica, ref)
    const error = fallidas[ref] ?? null
    const modelo = porRef.get(ref)
    const conexion: ConexionDatadoc = {
      ref,
      dominioId: dominioDe.get(ref) ?? ref,
      database: modelo?.database ?? null,
      server: modelo?.server ?? null,
      medidaHoy: modelo != null && error == null,
      medidoEn: modelo?.medidoEn ?? null,
      ms: modelo?.ms ?? null,
      error,
      errores: modelo?.errores ?? [],
      intro: textoInline(sem?.intro),
      joins: (sem?.joins ?? []).map((j) => textoInline(j)),
      entidades: [],
      pis: pisDe(ref),
      esquemas: modelo?.esquemas ?? [],
    }
    conexiones.push(conexion)
    if (!modelo) continue

    const secpolCaida = modelo.errores.some((e) => e.startsWith('sys.security_policies:'))
    // Linaje: vista → bases, y base → vistas. De `sys`, no de un regex sobre la definición.
    const basesDe = new Map<string, string[]>()
    const vistasDe = new Map<string, string[]>()
    const empujar = (m: Map<string, string[]>, k: string, v: string): void => {
      const lista = m.get(k)
      if (lista) lista.push(v)
      else m.set(k, [v])
    }
    for (const l of modelo.linaje) {
      empujar(basesDe, l.vista, l.base)
      empujar(vistasDe, l.base, l.vista)
    }

    const lectoresDirectos = (tabla: string): string[] =>
      reports.filter((r) => r.databaseRefs.includes(ref) && r.tables.includes(tabla)).map((r) => r.code)

    for (const o of modelo.objetos) {
      const bases = basesDe.get(o.ref) ?? []
      const base = o.esVista ? bases[0] : undefined
      // Lectores EFECTIVOS: los directos más, para una tabla base, los que la consumen a través de
      // una vista que la expone — el patrón vigente es leer el hecho por su vista-contrato, y sin
      // propagar, un hecho en pleno uso saldría «sin consumidor», que es una afirmación falsa.
      const lectores = new Map<string, string | undefined>()
      for (const c of lectoresDirectos(o.ref)) lectores.set(c, undefined)
      if (!o.esVista) {
        for (const v of vistasDe.get(o.ref) ?? []) for (const c of lectoresDirectos(v)) if (!lectores.has(c)) lectores.set(c, v)
      }
      const lista: LectorDatadoc[] = [...lectores.entries()]
        .map(([code, via]) => (via ? { code, via } : { code }))
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))

      const escritores = escritoresDe(entrada.writers, o.ref, ref)
      const claseGobierno: ClaseGobierno = o.esVista ? 'no gobernada' : (modelo.gobierno[o.ref]?.clase ?? 'indeterminada')
      const tienePolitica = !o.esVista && (modelo.gobierno[o.ref]?.politicas.length ?? 0) > 0

      // Clase POR HECHOS MEDIDOS. La instancia puede forzarla; nada más la mueve.
      let clase: ClaseEntidad = o.esVista
        ? 'publicado'
        : lista.length || escritores.some((w) => w.estado === 'vigente') || tienePolitica
          ? 'interno'
          : 'deuda'
      const semEnt = semanticaEntidad(entrada.semantica, ref, o.ref)
      const claseForzada = semEnt?.clase != null && semEnt.clase !== clase
      if (semEnt?.clase) clase = semEnt.clase

      // Semántica de columnas: una vista sin entrada propia hereda la de su base (el consumidor lee
      // por la vista, y repetir el diccionario en las dos sería la forma más barata de hacerlo driftar).
      const semColumnas = semEnt?.columnas ?? (o.esVista && base ? semanticaEntidad(entrada.semantica, ref, base)?.columnas : undefined) ?? {}
      const descHeredada = o.esVista && !semEnt?.descripcion && base ? semanticaEntidad(entrada.semantica, ref, base)?.descripcion : undefined
      const columnas: ColumnaDatadoc[] = (modelo.columnas[o.ref] ?? []).map((c) => ({
        nombre: c.nombre,
        tipo: c.tipo,
        nulable: c.nulable,
        significado: textoInline(semColumnas[c.nombre.toLowerCase()]),
      }))

      const ent: EntidadDatadoc = {
        ref: o.ref,
        conexion: ref,
        schema: o.schema,
        nombre: o.nombre,
        esVista: o.esVista,
        clase,
        claseForzada,
        descripcion: textoInline(semEnt?.descripcion ?? descHeredada),
        columnas,
        filas: filasDe(modelo, o, base, conteos, rancio != null),
        lectores: lista,
        escritor: o.esVista ? '' : escritorHtml(entrada.writers, entrada.sources, ref, o.ref),
        gobierno: gobiernoHtml(modelo, o.ref, o.esVista, secpolCaida),
        claseGobierno,
        vistas: o.esVista ? [] : [...new Set(vistasDe.get(o.ref) ?? [])].sort(),
      }
      const of = ofertaHtml(entrada.sources, o.esVista && base ? base : o.ref)
      if (of) ent.oferta = of
      if (base) ent.base = base
      if (clase === 'deuda')
        ent.motivoDeuda = 'sin consumidor: ningún PI la lee, ningún escritor la declara, ninguna política la gobierna.'
      conexion.entidades.push(ent)
      todasLasEntidades.push(ent)
    }
    conexion.entidades.sort((a, b) => a.ref.localeCompare(b.ref))

    // Números vivos de seguridad: se cuentan las POLÍTICAS medidas, sin juicio de instancia encima
    // (el generador de instancia contaba además las que apuntan a `_bak_*`, que es su alfabeto).
    for (const [tabla, g] of Object.entries(modelo.gobierno)) {
      for (const p of g.politicas) {
        seguridad.politicas += 1
        if (p.clase === 'abierta') seguridad.abiertas += 1
        else if (p.clase === 'filtrada') {
          seguridad.filtradas += 1
          seguridad.conFiltro.push(`${ref} · ${tabla}`)
        } else seguridad.indeterminadas += 1
      }
    }
  }

  todasLasEntidades.sort((a, b) => a.nombre.localeCompare(b.nombre) || a.conexion.localeCompare(b.conexion))

  return {
    generadoEn: ahora().toISOString(),
    dominios,
    conexiones,
    entidades: todasLasEntidades,
    pis: pisTodos,
    seguridad,
    conteos,
    rancio,
    portada: textoInline(entrada.semantica?.portada),
    seguridadTexto: textoInline(entrada.semantica?.seguridad),
    avisos,
  }
}
