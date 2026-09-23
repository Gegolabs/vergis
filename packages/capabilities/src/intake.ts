/**
 * Intake de archivos — contrato declarativo de los SLOTS de ingestión (genérico, agnóstico de
 * instancia). Es el ESPEJO de la publicación de data maestra: ahí el dato SALE (proyección
 * `__replica`), acá el archivo ENTRA (a una landing zone OneLake).
 *
 * Mira intermedia la ingesta: el usuario sube el archivo a UN solo lugar y Mira lo ubica en el destino
 * correcto (staging `Files/...` de un Lakehouse), SIN que el usuario sepa la ruta. El pipeline de
 * ingestión existente (notebook/CopyJob) lee de ahí — Mira intermedia, NO reemplaza el transform.
 *
 * Este módulo define SOLO el contrato y las funciones puras (parse/match/validate). El write físico a
 * OneLake y el disparo del pipeline viven en `intake-onelake.ts`; los slots concretos los declara la
 * INSTANCIA en `intake/slots.yaml`.
 *
 * ── El bloque `watch:` de un slot (issue #161) ──────────────────────────────────────────────────
 *
 * Declara la VIGILANCIA del slot. Es OPCIONAL: **ausente = los defaults del producto**, exactamente la
 * conducta previa a su existencia (compatibilidad total con los YAML ya desplegados).
 *
 *     watch: false               # opt-out TOTAL de la vigilancia del slot
 *     # — o —
 *     watch:
 *       max_age_minutes: 1440    # edad máxima en el landing (entero > 0)
 *       max_run_minutes: 90      # corrida colgada (entero > 0; requiere `trigger`)
 *
 * **Qué apaga `watch: false`, con todas sus letras:** el slot sale del lazo COMPLETO — sin observación,
 * sin proyección que se refresque, sin control positivo, sin conteo del contrato `_logs/` **y sin
 * resolver de desenlaces (#162)**: sus cargas nuevas quedan sin desenlace y sin aviso al usuario, y la
 * consola vuelve a la página pre-#161 para ese slot (sin banner de vigilancia). Es el opt-out del slot
 * donde la vigilancia entera carece de sentido.
 *
 * **El slot legítimamente lento NO se apaga: se le sube el umbral.** `max_age_minutes` alto conserva
 * todo lo demás (desenlaces, contradicciones, medida) y solo corre la línea de «varados». Un slot
 * land-only sin `max_age_minutes` no emite jamás `varados` (el consumidor externo tiene su propio
 * ritmo, que el producto no conoce); declararlo es su opt-in a esa señal.
 *
 * Fail-closed sin excepción: `watch: true`, el bloque vacío, una clave desconocida dentro del bloque,
 * un valor no entero o ≤ 0, y `max_run_minutes` en un slot sin `trigger` **lanzan** — el chequeo de
 * arranque los acusa y el hot-reload rechaza el swap conservando los slots vigentes.
 */

import { requireRootKey } from './config-root'

/** Destino OneLake del crudo: carpeta `Files/...` de un Lakehouse (landing zone / staging). */
export interface IntakeTarget {
  workspaceId: string
  lakehouseId: string
  /** Ruta dentro del Lakehouse, p.ej. `Files/intake/saldos`. El pipeline lee de aquí. */
  path: string
  /**
   * #269·V11 · Dónde ARCHIVA el proceso lo que procesó de este slot (contrato de ingesta §5.6).
   * Ausente = la convención de siempre, `<padre del landing>/_processed`. `false` = el proceso de
   * este slot NO archiva (un catálogo que se reemplaza entero y se lee siempre del landing): su
   * archivo en el landing es el vigente, no un residuo ni un varado.
   *
   * Existe porque la convención no calza con todos los procesos reales: uno archiva junto a su
   * landing (`Files/intake/facturas/_processed`), otro en un directorio común a varios landings.
   * Preguntar por el directorio equivocado devolvía 404 y la consola decía «sin procesados».
   */
  processed?: string | false
}

/** Disparo opcional del pipeline tras aterrizar el archivo (land-and-trigger). */
export interface IntakeTrigger {
  /** Item Fabric a correr (run-now). Omitir el trigger entero = land-only. */
  processRef: string
  /** Workspace del item (si difiere del target). Default: el del target. */
  workspaceId?: string
  /** jobType del item Fabric (default `Pipeline`). */
  jobType?: string
}

/** Tipo de un campo de metadata requerida en la subida (issue #76). */
export type IntakeMetaType = 'string' | 'number' | 'enum' | 'rut'

/**
 * Derivación de un campo de metadata DESDE EL NOMBRE DEL ARCHIVO (issue #95).
 *
 * La metadata sigue siendo **declarada** (#76): cambia dónde la escribe el usuario — del formulario al
 * nombre del archivo, que en la práctica ya escribe igual. El motor NO infiere: aplica una convención
 * que la instancia declaró explícitamente y **falla** cuando el archivo no la cumple. La diferencia con
 * adivinar es que aquí existe una regla escrita y verificable, y su incumplimiento es un error.
 */
export interface IntakeFromFilename {
  /**
   * Patrones de nombre, en orden de prueba (el primero que calza gana). Sintaxis: texto literal +
   * los comodines de `accept` (`*`, `?`) + **exactamente un** marcador `{nombre}` que captura el token
   * a resolver. Case-insensitive. El token capturado admite `[A-Za-z0-9_-]+` (sin espacios ni puntos):
   * un nombre que no calce es un error explícito, nunca una imputación silenciosa.
   */
  patterns: string[]
  /**
   * Catálogo `token → valor` declarado por la instancia. Un token fuera del catálogo hace **fallar** la
   * carga. Sin catálogo, el token capturado ES el valor (igual validado contra el `type` del campo).
   * La búsqueda es exacta y, si no hay match, case-insensitive (el parse rechaza claves que colisionen
   * al ignorar mayúsculas, para que esa segunda pasada nunca tenga que elegir).
   */
  catalog?: Record<string, string>
  /**
   * Columna del extracto cuyo valor —donde venga informado— debe coincidir con lo derivado del nombre;
   * si contradice, la carga se rechaza.
   *
   * **Quién lo hace cumplir:** el convertidor (pipeline/SJD), único actor que lee el CONTENIDO del
   * archivo — Mira no parsea planillas (ADR-001: sin supply-chain para leer formatos). Vergis lo
   * **declara y lo propaga** en el sidecar (`verify`), donde el convertidor lo lee. Es una directiva
   * declarada una sola vez, en el slot, en vez de cableada dentro de cada pipeline.
   */
  verifyAgainst?: string
}

/**
 * Opción de un `enum` de metadata, ya NORMALIZADA (issue #109): las opciones inline del slot y las que
 * vienen de un catálogo de la instancia (`options_ref`) convergen en esta única forma. `value` es el dato
 * que viaja (sidecar/SJD); `label` es puro display y JAMÁS viaja.
 */
export interface IntakeMetaOption {
  value: string
  label: string
}

/**
 * Catálogo de opciones declarado por la INSTANCIA en el bloque raíz `catalogs:` del mismo YAML de intake
 * (issue #109). Un campo `enum` lo referencia por id con `options_ref` y hereda sus opciones resueltas en
 * parse-time: el `IntakeSlot` resultante es autocontenido (nada más transporta catálogos).
 */
export interface IntakeCatalog {
  /** Slug estable, único entre catálogos; es lo que un campo nombra en `options_ref`. */
  id: string
  /** Nombre legible (documentación/UI); default = id. */
  label: string
  /** Lista NO vacía de opciones, con `value` único dentro del catálogo. */
  options: IntakeMetaOption[]
}

/**
 * Campo de metadata requerida por un slot (issue #76). El archivo de algunos slots NO se puede convertir
 * sin un dato que no viene en su contenido y que por política JAMÁS se infiere (identidad explícita,
 * fail-closed): a qué empresa se imputa un extracto, qué versión trae un presupuesto. La UI lo solicita
 * en el acto de subir y el valor viaja con el archivo (sidecar) hasta el SJD.
 */
export interface IntakeMetaField {
  /** Slug estable, usado como llave en el sidecar y en el name del control del form. */
  id: string
  /** Nombre legible para la UI. */
  label: string
  type: IntakeMetaType
  /** Sin valor bloquea la subida (validación server-side; la del browser es cortesía). */
  required?: boolean
  /** Opciones RESUELTAS de un type `enum`: inline o copiadas del catálogo de `options_ref` en parse-time
   *  (issue #109). Sin etiqueta declarada, `label = value`. */
  options?: IntakeMetaOption[]
  /** Id del catálogo del que salieron las `options` (issue #109). Solo para mensajes/UI: el valor ya
   *  viene resuelto en `options`; nadie vuelve a mirar el bloque `catalogs` después del parse. */
  optionsRef?: string
  /** Convención de nombre que resuelve este campo sin preguntárselo al usuario (issue #95). Presente =
   *  el formulario NO lo pide y el valor sale del nombre; ausente = comportamiento de #76 (formulario). */
  fromFilename?: IntakeFromFilename
  /** #269·§4.4 · texto de ayuda que la página de carga muestra junto al campo («0 es la línea base…»). */
  ayuda?: string
}

/**
 * #269·§4.4 · La FICHA de un tipo de archivo: lo que quien sube necesita saber antes de subir (qué
 * es, de dónde se saca, cómo se llama, qué pasa con lo que ya estaba, qué va junto y qué subir antes).
 * La declara la instancia —el dato no existe en ningún otro lado— y el Producto solo la dibuja: sin
 * un campo, su bloque no se dibuja (nunca se rellena con un texto del Producto que la instancia no
 * validó).
 */
export interface IntakeFicha {
  /** De dónde se saca el archivo («Portal B2B de Sodimac»). */
  origen?: string
  /** Cómo tiene que llamarse, en palabras. Ausente = `describirPatron(accept)`. */
  nombre?: string
  /** Un nombre real de ejemplo. */
  ejemplo?: string
  /** Qué pasa con lo que ya estaba: `acumula` (por clave), `reemplaza` (la lista entera), `version`. */
  regimen?: 'acumula' | 'reemplaza' | 'version'
  /** La clave con la que acumula («la OC»). Obligatoria con `acumula`. */
  clave?: string
  /** Qué tiene que venir junto. */
  juego?: string
  /** Qué subir antes: otro tipo de archivo del mismo archivo de intake, con el porqué. */
  requiere?: { slot: string; motivo: string }[]
  /** Cuándo lo toma el proceso, para un tipo que no se carga en el momento. */
  cadencia?: string
}

export interface IntakeSlot {
  /** Slug estable, usado en rutas y como id lógico (p.ej. `saldos_cartera`). */
  id: string
  /** Nombre legible para la UI. */
  label: string
  description?: string
  /** Dominio al que pertenece el slot (tag; deriva la gestión de dominio). */
  domain?: string
  /** Glob del nombre de archivo aceptado (p.ej. `Antigüedad de saldos *.xlsx`). */
  accept?: string
  /** Tamaño máximo en bytes. Default 25 MB. */
  maxBytes?: number
  target: IntakeTarget
  trigger?: IntakeTrigger
  /** Ruta (dentro del MISMO lakehouse del target) del log que escribe el proceso de conversión —
   * Frescura lo expone para reconfirmar una carga (filas, semana, commit) sin acceso a Fabric.
   * Default `Files/code/_ingest_log.txt`; `log: false` en el YAML lo deshabilita. */
  log?: string | false
  /** Metadata requerida en la subida (issue #76). Ausente = sin cambio (regresión cero). */
  meta?: IntakeMetaField[]
  /**
   * La instancia DECLARA que el convertidor de este slot cumple el contrato de reversión (issue #63):
   * al inicio de la corrida ejecuta el DELETE de la clave de cada manifiesto `_revert_<clave>.meta.json`
   * del landing y lo elimina. Solo con esta declaración Vergis escribe manifiestos; sin ella, la clave
   * que la carga INTRODUJO se reporta como no-compensable y no se toca (fail-closed: mover el archivo
   * dejando el dato materializado sería mentir).
   */
  revertDelete?: boolean
  /**
   * Vigilancia declarada del slot (issue #161, §4.1 de su diseño). **Ausente = defaults del producto**
   * (conducta vigente, sin cambio). Tipado inline a propósito: nadie transporta este bloque suelto.
   *
   * - `false` — opt-out TOTAL del lazo de vigilancia (ver la cabecera del módulo: apaga también el
   *   resolver de desenlaces de #162).
   * - mapa — umbrales propios del slot; lo no declarado cae al default del producto.
   */
  watch?: false | { maxAgeMinutes?: number; maxRunMinutes?: number }
  /**
   * #269·§3.1 · Desde cuándo el proceso de este slot DECLARA por archivo en su log (contrato `_logs/`
   * §2). ISO. Es un HECHO de la instancia, no algo que el Producto deduzca: los logs se podan (el
   * escritor conserva los últimos 60) y un ancla deducida de los logs que sobreviven se correría
   * hacia adelante con cada poda.
   *
   * Ancla el ÚNICO puente del resolvedor de estado: una carga subida ANTES de esta fecha, que ninguna
   * corrida declaró porque ninguna declaraba todavía, se da por cargada si su copia está archivada.
   * Una carga subida desde esta fecha nunca cruza ese puente. Sin la clave NO hay puente (fail-closed):
   * sus cargas sin declaración quedan «sin informe», que es la verdad.
   */
  contratoDesde?: string
  /**
   * #269·V12 · A quién le avisa el usuario cuando la plataforma no sabe qué pasó con su archivo.
   * Se declara en la RAÍZ del archivo de intake (`contacto:`) y cada slot lo hereda; un slot puede
   * declarar el suyo. Ausente = la línea «Avísale a …» no se dibuja, y la consola técnica lo señala.
   */
  contacto?: string
  /** #269·§4.4 · la ficha del tipo de archivo (opcional; parser estricto dentro del bloque). */
  ficha?: IntakeFicha
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/

/**
 * #269·P2 (juez P2-03) · Ids de slot RESERVADOS: son subrutas de la puerta `/cargar/<id>` que no son un
 * tipo de archivo. Un slot con uno de estos ids perdería su página o su subida en silencio; se acusa al
 * parsear, como las rutas reservadas del nodo.
 */
export const IDS_RESERVADOS_DE_LA_PUERTA: readonly string[] = ['revisar', 'tarjetas']
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/**
 * Valida y normaliza la config declarativa de intake (`{ catalogs?: [...], slots: [...] }`).
 *
 * `catalogs` (issue #109) es OPCIONAL —ausente = cero catálogos, legítimo— y se valida ANTES que los
 * slots: un campo con `options_ref` resuelve contra él en parse-time. Cualquier duda (ref rota, catálogo
 * vacío, value duplicado) **lanza**, y ese `throw` es toda la invariante: el chequeo de arranque lo acusa
 * como ERROR ruidoso y el hot-reload rechaza el swap conservando los slots vigentes.
 */
export function parseIntakeConfig(doc: unknown): IntakeSlot[] {
  const raw = requireRootKey(doc, 'intake', 'slots')
  if (!Array.isArray(raw)) throw new Error('intake: `slots` debe ser una lista.')
  const catalogs = parseCatalogs((doc as Record<string, unknown>)['catalogs'])
  const contacto = parseContacto((doc as Record<string, unknown>)['contacto'], 'intake: contacto')
  const seen = new Set<string>()
  const out = raw.map((s, i) => {
    const slot = parseSlot(s, i, seen, catalogs)
    // #269·V12 · el contacto de la raíz viaja EN cada slot: así llega a todo consumidor (lazo,
    // consola, correo) sin que la forma del resultado de este parser cambie para nadie.
    if (slot.contacto == null && contacto != null) slot.contacto = contacto
    return slot
  })
  // #269·§4.4 · un `requiere` que nombra un slot inexistente se acusa al parsear: la ficha diría
  // «sube antes X» apuntando a nada.
  for (const s of out) for (const r of s.ficha?.requiere ?? [])
    if (!seen.has(r.slot)) throw new Error(`intake: '${s.id}'.ficha.requiere: el slot '${r.slot}' no existe.`)
  return out
}

/** `contacto` (#269·V12): una dirección de correo. Otra cosa se acusa al parsear — un contacto que
 *  no es una dirección se dibujaría como instrucción al usuario y no llevaría a nadie. */
function parseContacto(raw: unknown, where: string): string | undefined {
  if (raw == null) return undefined
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) throw new Error(`${where} debe ser una dirección de correo (recibido: '${String(raw)}').`)
  return v
}

/** `contrato_desde` (#269·§3.1): fecha ISO parseable. Se acusa al parsear: un ancla ilegible
 *  apagaría el puente en silencio (o lo abriría, que es peor). */
function parseContratoDesde(raw: unknown, slotId: string): string {
  const v = raw instanceof Date ? raw.toISOString() : typeof raw === 'string' ? raw.trim() : ''
  if (!v || !Number.isFinite(Date.parse(v))) throw new Error(`intake: '${slotId}'.contrato_desde debe ser una fecha ISO (recibido: '${String(raw)}').`)
  return new Date(Date.parse(v)).toISOString()
}

/** Valida el bloque raíz `catalogs` (issue #109) y lo indexa por id. Ausente = mapa vacío. */
function parseCatalogs(raw: unknown): Map<string, IntakeCatalog> {
  const out = new Map<string, IntakeCatalog>()
  if (raw == null) return out
  if (!Array.isArray(raw)) throw new Error('intake: `catalogs` debe ser una lista.')
  raw.forEach((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>
    const id = String(o['id'] ?? '')
    if (!SLUG_RE.test(id)) throw new Error(`intake: catálogo #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
    if (out.has(id)) throw new Error(`intake: id de catálogo duplicado '${id}'.`)
    const opts = o['options']
    if (!Array.isArray(opts) || opts.length === 0) throw new Error(`intake: catálogo '${id}' requiere 'options' (lista no vacía).`)
    out.set(id, { id, label: String(o['label'] ?? id), options: parseOptions(opts, `intake: catálogo '${id}'`) })
  })
  return out
}

/**
 * Normaliza una lista de opciones de `enum` a `IntakeMetaOption[]` (issue #109). Una entrada puede ser un
 * string (`'OTRO'` ≡ `{ value: 'OTRO', label: 'OTRO' }`) o un mapa `{ value, label? }`. `value` vacío o
 * duplicado dentro de la lista = error: una opción ambigua no se resuelve al subir, se rechaza al parsear.
 */
function parseOptions(raw: unknown[], where: string): IntakeMetaOption[] {
  const seen = new Set<string>()
  return raw.map((entry, i) => {
    const esMapa = entry != null && typeof entry === 'object' && !Array.isArray(entry)
    const o = esMapa ? (entry as Record<string, unknown>) : null
    const value = String((o ? o['value'] : entry) ?? '').trim()
    if (!value) throw new Error(`${where}: opción #${i} sin 'value'.`)
    if (seen.has(value)) throw new Error(`${where}: value duplicado '${value}'.`)
    seen.add(value)
    const label = o && o['label'] != null ? String(o['label']).trim() : value
    return { value, label: label || value }
  })
}

function parseSlot(s: unknown, i: number, seen: Set<string>, catalogs: Map<string, IntakeCatalog>): IntakeSlot {
  const o = (s ?? {}) as Record<string, unknown>
  const id = String(o['id'] ?? '')
  if (!SLUG_RE.test(id)) throw new Error(`intake: slot #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
  if (seen.has(id)) throw new Error(`intake: id de slot duplicado '${id}'.`)
  if (IDS_RESERVADOS_DE_LA_PUERTA.includes(id))
    throw new Error(`intake: el id de slot '${id}' está reservado (es una ruta de la puerta /cargar: ${IDS_RESERVADOS_DE_LA_PUERTA.join(', ')}); usa otro id.`)
  seen.add(id)
  const target = parseTarget(o['target'], id)
  const out: IntakeSlot = { id, label: String(o['label'] ?? id), target }
  if (o['description'] != null) out.description = String(o['description'])
  if (o['domain'] != null) out.domain = String(o['domain'])
  // #269·0.35.1 (juez m1) · el patrón se lleva a NFC igual que el nombre al subir: un `accept` escrito
  // en forma descompuesta no calzaría con ningún nombre canonizado (0.34.0 lo aceptaba).
  if (o['accept'] != null) out.accept = String(o['accept']).normalize('NFC')
  if (o['maxBytes'] != null) {
    const n = Number(o['maxBytes'])
    if (!Number.isInteger(n) || n <= 0) throw new Error(`intake: '${id}'.maxBytes debe ser un entero positivo.`)
    out.maxBytes = n
  }
  if (o['trigger'] != null) {
    const t = (o['trigger'] ?? {}) as Record<string, unknown>
    const processRef = String(t['processRef'] ?? '')
    if (!processRef) throw new Error(`intake: '${id}'.trigger sin processRef.`)
    const trig: IntakeTrigger = { processRef }
    if (t['workspaceId'] != null) trig.workspaceId = String(t['workspaceId'])
    if (t['jobType'] != null) trig.jobType = String(t['jobType'])
    out.trigger = trig
  }
  if (o['log'] === false) out.log = false
  else if (o['log'] != null) {
    const p = String(o['log'])
    if (!/^Files\//.test(p)) throw new Error(`intake: '${id}'.log debe empezar en 'Files/' (vive en el mismo Lakehouse del target).`)
    out.log = p
  }
  // #63 · capacidad declarada de reversión. Booleano ESTRICTO: un `'si'` o un `1` que se leyeran como
  // verdaderos harían que Vergis escriba manifiestos que nadie ejecuta — el fallo se acusa al parsear.
  if (o['revert_delete'] != null) {
    const v = o['revert_delete']
    if (typeof v !== 'boolean') throw new Error(`intake: '${id}'.revert_delete debe ser booleano (true | false).`)
    if (v) out.revertDelete = true
  }
  if (o['meta'] != null) {
    const meta = parseMeta(o['meta'], id, catalogs)
    if (meta.length) out.meta = meta
  }
  // `!== undefined`, no `!= null`: `watch:` sin valor (null en YAML) es una declaración que no declara
  // nada — se acusa, no se cae al default en silencio.
  if (o['watch'] !== undefined) out.watch = parseWatch(o['watch'], id, out.trigger != null)
  if (o['contrato_desde'] != null) out.contratoDesde = parseContratoDesde(o['contrato_desde'], id)
  if (o['contacto'] != null) out.contacto = parseContacto(o['contacto'], `intake: '${id}'.contacto`)
  if (o['ficha'] !== undefined) out.ficha = parseFicha(o['ficha'], id)
  return out
}

/** Claves admitidas dentro del bloque `ficha` (#269·§4.4). El bloque nace ESTRICTO, como `watch`. */
const FICHA_KEYS = new Set(['origen', 'nombre', 'ejemplo', 'regimen', 'clave', 'juego', 'requiere', 'cadencia'])
const REGIMENES = new Set(['acumula', 'reemplaza', 'version'])

/**
 * Valida el bloque `ficha:` de un slot (#269·§4.4). Fail-closed: una clave desconocida, un texto
 * vacío, un régimen fuera de `acumula | reemplaza | version`, `acumula` sin `clave` o un `requiere`
 * mal formado **lanzan** — el chequeo de arranque lo acusa y el hot-reload conserva los slots
 * vigentes. Que el slot de un `requiere` exista se verifica después, con todos los slots leídos
 * (`parseIntakeConfig`).
 */
export function parseFicha(raw: unknown, slotId: string): IntakeFicha {
  const where = `intake: '${slotId}'.ficha`
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} debe ser un mapa (${[...FICHA_KEYS].join(', ')}).`)
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!FICHA_KEYS.has(k)) throw new Error(`${where}: clave desconocida '${k}' (esperadas: ${[...FICHA_KEYS].join(', ')}).`)
  const texto = (k: string): string | undefined => {
    if (o[k] == null) return undefined
    const v = typeof o[k] === 'string' ? (o[k] as string).trim() : ''
    if (!v) throw new Error(`${where}.${k} debe ser un texto no vacío.`)
    return v.normalize('NFC')
  }
  const out: IntakeFicha = {}
  for (const k of ['origen', 'nombre', 'ejemplo', 'clave', 'juego', 'cadencia'] as const) {
    const v = texto(k)
    if (v != null) out[k] = v
  }
  if (o['regimen'] != null) {
    const r = String(o['regimen'])
    if (!REGIMENES.has(r)) throw new Error(`${where}.regimen inválido '${r}' (acumula | reemplaza | version).`)
    out.regimen = r as IntakeFicha['regimen']
  }
  if (out.regimen === 'acumula' && !out.clave) throw new Error(`${where}: 'regimen: acumula' requiere 'clave' (qué carga cada archivo, p.ej. «la OC»).`)
  if (o['requiere'] != null) {
    if (!Array.isArray(o['requiere']) || !o['requiere'].length) throw new Error(`${where}.requiere debe ser una lista no vacía de { slot, motivo }.`)
    out.requiere = o['requiere'].map((x, i) => {
      const r = (x ?? {}) as Record<string, unknown>
      for (const k of Object.keys(r)) if (k !== 'slot' && k !== 'motivo') throw new Error(`${where}.requiere #${i}: clave desconocida '${k}' (esperadas: slot, motivo).`)
      const slot = String(r['slot'] ?? '')
      const motivo = typeof r['motivo'] === 'string' ? r['motivo'].trim() : ''
      if (!SLUG_RE.test(slot)) throw new Error(`${where}.requiere #${i}: 'slot' inválido '${slot}'.`)
      if (slot === slotId) throw new Error(`${where}.requiere #${i}: un tipo de archivo no puede requerirse a sí mismo.`)
      if (!motivo) throw new Error(`${where}.requiere #${i}: falta 'motivo'.`)
      return { slot, motivo }
    })
  }
  return out
}

/** Claves admitidas dentro del bloque `watch` — el bloque nace ESTRICTO (ver `parseWatch`). */
const WATCH_KEYS = new Set(['max_age_minutes', 'max_run_minutes'])

/**
 * Valida y normaliza el bloque `watch` de un slot (issue #161). Fail-closed en todas sus formas: una
 * vigilancia mal declarada rompe el arranque (y el hot-reload rechaza el swap conservando los slots
 * vigentes) en vez de caer en silencio a los defaults — un control que se apaga sin avisar es peor que
 * no tenerlo.
 *
 * `watch: true` es error: no declara nada que el default no diga ya, y admitirlo crearía dos formas de
 * escribir lo mismo. El mapa vacío también: una declaración que no declara nada es un typo, no una
 * intención. Y la clave desconocida DENTRO del bloque es error aunque el nivel-slot tolere claves
 * sobrantes por historia — el bloque nuevo no hereda esa deuda.
 */
function parseWatch(raw: unknown, slotId: string, tieneTrigger: boolean): false | { maxAgeMinutes?: number; maxRunMinutes?: number } {
  const where = `intake: '${slotId}'.watch`
  if (raw == null) throw new Error(`${where} está vacío (declara max_age_minutes y/o max_run_minutes, o 'watch: false' para el opt-out).`)
  if (typeof raw === 'boolean') {
    if (raw) throw new Error(`${where}: 'true' no declara nada (usa 'false' para el opt-out, o el mapa con max_age_minutes / max_run_minutes).`)
    return false
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} debe ser 'false' o un mapa (max_age_minutes, max_run_minutes).`)
  }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!WATCH_KEYS.has(k)) throw new Error(`${where}: clave desconocida '${k}' (esperadas: ${[...WATCH_KEYS].join(', ')}).`)
  }
  const out: { maxAgeMinutes?: number; maxRunMinutes?: number } = {}
  if (o['max_age_minutes'] != null) out.maxAgeMinutes = enteroPositivo(o['max_age_minutes'], `${where}.max_age_minutes`)
  if (o['max_run_minutes'] != null) {
    // Coherencia declarativa (familia del aviso #56): un slot land-only no dispara corridas, así que un
    // umbral de corrida colgada no mide nada. Se acusa al parsear, no se ignora al vigilar.
    if (!tieneTrigger) throw new Error(`${where}.max_run_minutes requiere 'trigger' (un slot land-only no tiene corridas que medir).`)
    out.maxRunMinutes = enteroPositivo(o['max_run_minutes'], `${where}.max_run_minutes`)
  }
  // Un mapa que no dejó ningún umbral: el mapa vacío (`watch: {}`) y el mapa cuyas claves venían todas
  // en null (`max_age_minutes:` sin valor) caen los dos acá — declarar sin declarar nada es un typo.
  if (!Object.keys(out).length) throw new Error(`${where} está vacío (declara max_age_minutes y/o max_run_minutes, o 'watch: false' para el opt-out).`)
  return out
}

/**
 * Entero positivo o error nombrando la clave — mismo registro de mensaje que `maxBytes`, pero SIN su
 * coerción: acá el tipo se exige (`'30'` y `true` se acusan). El bloque `watch` nace estricto, igual
 * que con sus claves desconocidas; `maxBytes` tolera la coerción por historia y no se toca.
 */
function enteroPositivo(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${where} debe ser un entero positivo.`)
  return v
}

const META_TYPES = new Set<IntakeMetaType>(['string', 'number', 'enum', 'rut'])

/** Llaves que el sidecar usa para sí mismo: un campo de metadata no puede llamarse así (pisaría el
 *  manifiesto que lee el convertidor). Fail-closed al parsear la config, no al subir. */
const META_ID_RESERVADOS = new Set(['slot', 'uploadedby', 'uploadedat', 'verify'])

/** Valida y normaliza el bloque `meta` de un slot (issue #76). Mal formado = fallo ruidoso. */
function parseMeta(raw: unknown, slotId: string, catalogs: Map<string, IntakeCatalog>): IntakeMetaField[] {
  if (!Array.isArray(raw)) throw new Error(`intake: '${slotId}'.meta debe ser una lista.`)
  const seen = new Set<string>()
  return raw.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>
    const id = String(o['id'] ?? '')
    if (!SLUG_RE.test(id)) throw new Error(`intake: '${slotId}'.meta #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
    if (seen.has(id)) throw new Error(`intake: '${slotId}'.meta con id duplicado '${id}'.`)
    if (META_ID_RESERVADOS.has(id.toLowerCase())) {
      throw new Error(`intake: '${slotId}'.meta '${id}': id reservado del sidecar (${[...META_ID_RESERVADOS].join(', ')}).`)
    }
    seen.add(id)
    const type = String(o['type'] ?? '') as IntakeMetaType
    if (!META_TYPES.has(type)) throw new Error(`intake: '${slotId}'.meta '${id}' con type inválido '${type}' (string | number | enum | rut).`)
    const field: IntakeMetaField = { id, label: String(o['label'] ?? id), type }
    if (o['required'] != null) {
      if (typeof o['required'] !== 'boolean') throw new Error(`intake: '${slotId}'.meta '${id}'.required debe ser booleano.`)
      field.required = o['required']
    }
    // #109 · las opciones de un enum vienen inline o de un catálogo de la instancia (`options_ref`), y
    // exactamente de una de las dos: declarar ambas o ninguna es ambigüedad, no un default silencioso.
    const where = `intake: '${slotId}'.meta '${id}'`
    const ref = o['options_ref'] != null ? String(o['options_ref']).trim() : null
    if (type === 'enum') {
      const opts = o['options']
      if (opts != null && ref) throw new Error(`${where}: declara 'options' u 'options_ref', no ambos.`)
      if (opts == null && !ref) throw new Error(`${where} (enum) requiere 'options' (lista no vacía) u 'options_ref' (id de catálogo).`)
      if (ref) {
        const cat = catalogs.get(ref)
        if (!cat) {
          const declarados = catalogs.size ? `(declarados: ${[...catalogs.keys()].join(', ')})` : '(no hay catálogos declarados — bloque `catalogs:`)'
          throw new Error(`${where}.options_ref: catálogo desconocido '${ref}' ${declarados}.`)
        }
        // La copia hace autocontenido al slot: `validateMeta`, el render y el diff del hot-reload leen
        // `field.options` sin conocer el bloque `catalogs`.
        field.options = cat.options
        field.optionsRef = cat.id
      } else {
        if (!Array.isArray(opts) || opts.length === 0) throw new Error(`${where} (enum) requiere 'options' (lista no vacía).`)
        field.options = parseOptions(opts, where)
      }
    } else {
      if (o['options'] != null) throw new Error(`${where}: 'options' solo aplica a type enum.`)
      if (ref) throw new Error(`${where}: 'options_ref' solo aplica a type enum.`)
    }
    if (o['from_filename'] != null) field.fromFilename = parseFromFilename(o['from_filename'], slotId, id)
    if (o['ayuda'] != null) {
      const a = typeof o['ayuda'] === 'string' ? o['ayuda'].trim() : ''
      if (!a) throw new Error(`${where}.ayuda debe ser un texto no vacío.`)
      field.ayuda = a
    }
    return field
  })
}

/** El marcador `{nombre}` del patrón: nombra el token capturado (documentación; exactamente uno). */
const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]*)\}/g

/** Valida y normaliza el bloque `from_filename` de un campo de metadata (issue #95). */
function parseFromFilename(raw: unknown, slotId: string, fieldId: string): IntakeFromFilename {
  const o = (raw ?? {}) as Record<string, unknown>
  const where = `intake: '${slotId}'.meta '${fieldId}'.from_filename`
  const one = o['pattern']
  const many = o['patterns']
  if (one != null && many != null) throw new Error(`${where}: declara 'pattern' o 'patterns', no ambos.`)
  const list = many != null ? many : one != null ? [one] : null
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where}: requiere 'pattern' (texto) o 'patterns' (lista no vacía).`)
  const patterns = list.map((p) => {
    const s = String(p ?? '').trim()
    if (!s) throw new Error(`${where}: patrón vacío.`)
    const n = [...s.matchAll(PLACEHOLDER_RE)].length
    if (n !== 1) throw new Error(`${where}: el patrón «${s}» debe traer exactamente un marcador {nombre} (trae ${n}).`)
    return s
  })
  const out: IntakeFromFilename = { patterns }
  if (o['catalog'] != null) {
    const c = o['catalog']
    if (typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}.catalog debe ser un mapa token → valor.`)
    const catalog: Record<string, string> = {}
    const lower = new Set<string>()
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
      const key = String(k).trim()
      const val = String(v ?? '').trim()
      if (!key || !val) throw new Error(`${where}.catalog: entrada con token o valor vacío ('${key}').`)
      // La resolución cae a case-insensitive si no hubo match exacto: dos claves que solo difieren en
      // mayúsculas la obligarían a elegir. Se rechaza al parsear, no al subir.
      if (lower.has(key.toLowerCase())) throw new Error(`${where}.catalog: '${key}' colisiona con otro token al ignorar mayúsculas.`)
      lower.add(key.toLowerCase())
      catalog[key] = val
    }
    if (!Object.keys(catalog).length) throw new Error(`${where}.catalog está vacío.`)
    out.catalog = catalog
  }
  if (o['verify_against'] != null) {
    const col = String(o['verify_against']).trim()
    if (!col) throw new Error(`${where}.verify_against vacío.`)
    out.verifyAgainst = col
  }
  return out
}

/** Ruta efectiva del log de conversión de un slot (null = deshabilitado). */
export const DEFAULT_INGEST_LOG = 'Files/code/_ingest_log.txt'
export const slotLogPath = (slot: IntakeSlot): string | null =>
  slot.log === false ? null : slot.log ?? DEFAULT_INGEST_LOG

/** Directorio de logs POR CORRIDA del slot (issue #99): hermano `_logs/` del log declarado.
 *  Default (`Files/code/_ingest_log.txt`) → `Files/code/_logs`. null si `log: false`. */
export const slotRunLogsDir = (slot: IntakeSlot): string | null => {
  const p = slotLogPath(slot)
  if (!p) return null
  return `${p.includes('/') ? p.replace(/\/[^/]*$/, '') : p}/_logs`
}

function parseTarget(raw: unknown, slotId: string): IntakeTarget {
  const o = (raw ?? {}) as Record<string, unknown>
  const workspaceId = String(o['workspaceId'] ?? '')
  const lakehouseId = String(o['lakehouseId'] ?? '')
  const path = String(o['path'] ?? '')
  if (!workspaceId || !lakehouseId || !path) {
    throw new Error(`intake: '${slotId}'.target requiere workspaceId, lakehouseId y path.`)
  }
  if (!/^Files\//.test(path)) {
    throw new Error(`intake: '${slotId}'.target.path debe empezar en 'Files/' (staging del Lakehouse, no 'Tables/').`)
  }
  const out: IntakeTarget = { workspaceId, lakehouseId, path: path.replace(/\/+$/, '') }
  // #269·V11 · `processed: <ruta> | false`. Ruta dentro del MISMO lakehouse (`Files/…`), o `false`.
  const processed = o['processed']
  if (processed === false) out.processed = false
  else if (processed != null) {
    const p = typeof processed === 'string' ? processed.trim().replace(/\/+$/, '') : ''
    if (!/^Files\//.test(p)) throw new Error(`intake: '${slotId}'.target.processed debe ser una ruta que empiece en 'Files/' o 'false'.`)
    out.processed = p
  }
  return out
}

/** Directorio de lo PROCESADO de un slot (#269·V11): lo declarado, o `<padre del landing>/_processed`.
 *  `null` = el slot declaró `processed: false` (su proceso no archiva). */
export function slotProcessedDir(slot: IntakeSlot): string | null {
  const d = slot.target.processed
  if (d === false) return null
  if (d) return d
  const p = slot.target.path
  return `${p.includes('/') ? p.replace(/\/[^/]*$/, '') : p}/_processed`
}

/**
 * La forma canónica de un nombre de archivo (#269·D7): NFC. Una descarga en macOS llega a veces en
 * forma descompuesta («u» + diéresis combinante): es la misma cadena para una persona y otra para un
 * patrón — `Antig?edad` calza la forma NFC y no la NFD, porque `?` calza UNA unidad. Normalizar no es
 * tolerar: es escribir la misma cadena de una sola manera antes de validar, registrar y aterrizar.
 */
export const nombreCanonico = (filename: string): string => String(filename ?? '').normalize('NFC')

/**
 * Los slots cuyo `accept` DECLARADO calza con el nombre (#269·§4.1, D12) — la prueba de la puerta.
 * Un slot sin `accept` no participa: acepta cualquier nombre y nombrarlo como destino sería adivinar.
 * El nombre se compara en su forma canónica.
 */
export function slotsQueCalzan(slots: IntakeSlot[], filename: string): IntakeSlot[] {
  const name = nombreCanonico(filename).trim()
  if (!name) return []
  return slots.filter((s) => !!s.accept && globToRegExp(s.accept).test(name))
}

/** Firma de los patrones declarados (#269·0.35.1): una medida de disjunción vale solo para la
 *  configuración con la que se tomó. */
export const firmaDePatrones = (slots: IntakeSlot[]): string => JSON.stringify(slots.map((s) => [s.id, s.accept ?? null]))

/**
 * Pares de tipos cuyos patrones SE PISAN con certeza (#269·0.35.1): el testigo mínimo de uno (cada
 * `*` vacío, cada `?` una letra) calza con el patrón del otro. Es condición SUFICIENTE, no necesaria
 * —dos patrones «contiene» pueden intersecarse sin que su testigo lo muestre—, y por eso se combina
 * con la medida sobre los nombres reales. Cinco slots con `*.xlsx` se pisan todos entre sí.
 */
export function patronesQueSePisan(slots: IntakeSlot[]): [string, string][] {
  const con = slots.filter((s) => !!s.accept)
  const testigo = (glob: string): string => glob.replace(/\*/g, '').replace(/\?/g, 'x')
  const out: [string, string][] = []
  for (let i = 0; i < con.length; i++)
    for (let j = i + 1; j < con.length; j++) {
      const a = con[i]!, b = con[j]!
      if (globToRegExp(b.accept!).test(testigo(a.accept!)) || globToRegExp(a.accept!).test(testigo(b.accept!))) out.push([a.id, b.id])
    }
  return out
}

/**
 * Nombres del registro que calzan con DOS o más tipos (#269·§4.1): la señal posterior a cada recarga.
 * La disjunción entre PATRONES no es alcanzable con patrones «contiene»; la que importa es sobre los
 * nombres reales, y esa se mide acá. PURA.
 */
export function nombresAmbiguos(slots: IntakeSlot[], nombres: string[]): { nombre: string; slots: string[] }[] {
  const out: { nombre: string; slots: string[] }[] = []
  for (const n of [...new Set(nombres.map((x) => nombreCanonico(x).trim()).filter(Boolean))].sort()) {
    const calzan = slotsQueCalzan(slots, n)
    if (calzan.length >= 2) out.push({ nombre: n, slots: calzan.map((s) => s.id) })
  }
  return out
}

/** El tope de tamaño efectivo de un slot. */
export const slotMaxBytes = (slot: IntakeSlot): number => slot.maxBytes ?? DEFAULT_MAX_BYTES

/**
 * Compila un glob de nombre de archivo (`*`, `?`) a RegExp anclada, case-insensitive. Solo esos dos
 * comodines; el resto del patrón se escapa (injection-safe).
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

const EXT_LEGIBLE: Record<string, string> = { xlsx: 'un Excel', xls: 'un Excel', xlsm: 'un Excel', csv: 'un CSV', txt: 'un texto', json: 'un JSON', pdf: 'un PDF', xml: 'un XML', zip: 'un ZIP' }

/**
 * #269·§4.4 · El patrón de nombre dicho en palabras, para la ficha que no declara `ficha.nombre`.
 * `*x*` → «tiene que contener «x»»; `x*` → «tiene que empezar con «x»»; `*x` → «tiene que terminar
 * en «x»»; la extensión → «y ser un Excel (.xlsx)». Lo que no cae en esas formas se muestra tal cual,
 * con qué significa cada comodín. Nunca afirma más de lo que el patrón exige: la comparación ignora
 * mayúsculas y lo dice.
 */
export function describirPatron(accept: string | undefined): string {
  if (!accept) return 'Puede llamarse como sea.'
  const g = accept.normalize('NFC')
  const ext = /\.([A-Za-z0-9]{2,5})$/.exec(g)
  const cuerpo = ext ? g.slice(0, -ext[0].length) : g
  const tipo = ext ? `${EXT_LEGIBLE[ext[1]!.toLowerCase()] ?? 'un archivo'} (.${ext[1]!.toLowerCase()})` : null
  const q = cuerpo.includes('?') ? ' («?» es una letra cualquiera)' : ''
  const fin = (base: string): string => `${base}${tipo ? `${base ? ' y' : 'Tiene que'} ser ${tipo}` : ''}.`
  const lit = (x: string): boolean => !/[*]/.test(x)
  let base: string
  if (cuerpo === '' || cuerpo === '*') base = ''
  else if (lit(cuerpo)) base = `Tiene que llamarse «${cuerpo}»${q}`
  else if (/^\*[^*]+\*$/.test(cuerpo)) base = `El nombre tiene que contener «${cuerpo.slice(1, -1)}»${q}`
  else if (/^[^*]+\*$/.test(cuerpo)) base = `El nombre tiene que empezar con «${cuerpo.slice(0, -1).trimEnd()}»${q}`
  else if (/^\*[^*]+$/.test(cuerpo)) base = `El nombre tiene que terminar en «${cuerpo.slice(1).trimStart()}»${q}`
  else base = `El nombre tiene que calzar con «${cuerpo}» («*» es cualquier texto${cuerpo.includes('?') ? ', «?» una letra cualquiera' : ''})`
  if (!base && !tipo) return 'Puede llamarse como sea.'
  return `${fin(base)} No importan las mayúsculas.`
}

/** El primer slot cuyo `accept` matchea el nombre. Un slot sin `accept` acepta cualquier nombre. */
export function matchSlot(slots: IntakeSlot[], filename: string): IntakeSlot | undefined {
  return slots.find((s) => !s.accept || globToRegExp(s.accept).test(filename))
}

/**
 * Los OTROS slots que SÍ aceptarían este archivo (issue #178): el destino computable de un rechazo.
 *
 * Distinto de `matchSlot` en las dos cosas que lo vuelven publicable como consejo al usuario:
 * devuelve TODOS los candidatos (si hay varios, se listan — no se elige uno) y exige `accept`
 * DECLARADO. Un slot sin `accept` acepta cualquier nombre: nombrarlo como el destino correcto sería
 * adivinar, y el requisito prohíbe la heurística — solo se nombra un slot cuyo patrón declarado
 * matchea el nombre real.
 */
export function slotsQueAceptan(slots: IntakeSlot[], filename: string, exceptSlotId: string): IntakeSlot[] {
  const name = (filename ?? '').trim()
  if (!name) return []
  return slots.filter((s) => s.id !== exceptSlotId && !!s.accept && globToRegExp(s.accept).test(name))
}

/**
 * `reason` identifica el motivo del rechazo cuando el llamador puede hacer algo con él: hoy solo
 * `'accept'` (patrón de nombre), que es el único con un destino alternativo computable (#178). Los
 * demás rechazos no lo llevan — no hay nada que ofrecer para un archivo vacío o sobredimensionado.
 */
export type ValidateResult = { ok: true } | { ok: false; error: string; reason?: 'accept' }

/** Valida un upload contra el slot: patrón de nombre y tamaño. Resultado accionable. */
export function validateUpload(slot: IntakeSlot, filename: string, size: number): ValidateResult {
  const name = (filename ?? '').trim()
  if (!name) return { ok: false, error: 'El archivo no tiene nombre.' }
  if (name === '.' || name === '..') return { ok: false, error: `Nombre de archivo inválido: '${name}'.` }
  // Separadores de ruta, traversal y caracteres que rompen el encoding del path DFS (`#`/`?` cortan
  // el path / inyectan query params; `%` habilita doble-encoding; control chars). El nombre va directo
  // a la URL de OneLake — se trata como hoja, nunca como ruta.
  // eslint-disable-next-line no-control-regex
  if (/[/\\?#%\x00-\x1f]/.test(name)) return { ok: false, error: `Nombre de archivo inválido (sin rutas ni caracteres especiales): '${name}'.` }
  if (slot.accept && !globToRegExp(slot.accept).test(name)) {
    return { ok: false, error: `El nombre '${name}' no coincide con el patrón esperado «${slot.accept}».`, reason: 'accept' }
  }
  if (size <= 0) return { ok: false, error: 'El archivo está vacío.' }
  const max = slotMaxBytes(slot)
  if (size > max) {
    return { ok: false, error: `El archivo (${size} bytes) excede el máximo del slot (${max} bytes).` }
  }
  return { ok: true }
}

// ─── Metadata requerida por slot (issue #76) ────────────────────────────────

/**
 * Valida un RUT chileno con su dígito verificador (módulo 11). Acepta `12345678-9` / `12.345.678-9` /
 * `12345678-K` (puntos y espacios se ignoran; el DV `K`/`k` cuenta). Sin guion, sin cuerpo o con cuerpo
 * de más de 8 dígitos → inválido. No infiere ni corrige: es una compuerta booleana.
 */
export function validateRut(raw: string): boolean {
  const cleaned = (raw ?? '').replace(/[.\s]/g, '').toUpperCase()
  const m = /^(\d{1,8})-([\dK])$/.exec(cleaned)
  if (!m) return false
  const [, body, dv] = m
  let sum = 0
  let mul = 2
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * mul
    mul = mul === 7 ? 2 : mul + 1
  }
  const res = 11 - (sum % 11)
  const expected = res === 11 ? '0' : res === 10 ? 'K' : String(res)
  return expected === dv
}

// ─── Metadata derivada del nombre del archivo (issue #95) ───────────────────

/** Lo que captura un marcador `{nombre}`: un token, sin espacios ni puntos (no se «adivina» de más). */
const TOKEN_RE_SRC = '([A-Za-z0-9_-]+)'

/**
 * Compila un patrón de nombre con marcador (`Listado EasyDoc {codigo}.xlsx`) a RegExp anclada,
 * case-insensitive, con el token como grupo 1. Los comodines `*` y `?` valen como en `accept`; el resto
 * del patrón se escapa (injection-safe).
 */
export function filenamePatternToRegExp(pattern: string): RegExp {
  const literales = pattern.split(/\{[a-z][a-z0-9_]*\}/).map((p) =>
    p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'),
  )
  return new RegExp(`^${literales.join(TOKEN_RE_SRC)}$`, 'i')
}

/** El token que el nombre declara para este campo, o `null` si ningún patrón calza. */
export function tokenFromFilename(from: IntakeFromFilename, filename: string): string | null {
  for (const p of from.patterns) {
    const m = filenamePatternToRegExp(p).exec(filename ?? '')
    if (m) return m[1]
  }
  return null
}

export type DeriveResult = { ok: true; value: string } | { ok: false; error: string }

/**
 * Resuelve el valor de un campo desde el nombre del archivo. Falla explícita —nombrando qué se
 * esperaba— cuando el nombre no sigue la convención o el token no está en el catálogo. Nunca imputa un
 * default ni ingiere a medias.
 */
export function deriveMetaFromFilename(field: IntakeMetaField, filename: string): DeriveResult {
  const from = field.fromFilename
  if (!from) return { ok: false, error: `«${field.label}» no declara una convención de nombre.` }
  const token = tokenFromFilename(from, filename)
  if (token == null) {
    return {
      ok: false,
      error: `El nombre '${filename}' no declara «${field.label}»: se esperaba ${from.patterns.map((p) => `«${p}»`).join(' o ')}.`,
    }
  }
  if (!from.catalog) return { ok: true, value: token }
  const exact = from.catalog[token]
  if (exact != null) return { ok: true, value: exact }
  const hit = Object.entries(from.catalog).find(([k]) => k.toLowerCase() === token.toLowerCase())
  if (hit) return { ok: true, value: hit[1] }
  return {
    ok: false,
    error: `El código '${token}' del nombre '${filename}' no está en el catálogo de «${field.label}» (${Object.keys(from.catalog).join(', ')}).`,
  }
}

export type ValidateMetaResult =
  | { ok: true; values: Record<string, string>; verify?: Record<string, string> }
  | { ok: false; error: string }

/**
 * Valida los valores de metadata de UN archivo contra el bloque `meta` del slot. Devuelve SOLO los
 * campos declarados (normalizados/trim) — lo que viaja al sidecar; ignora extras. Un `required` sin
 * valor o un valor que no calza el tipo rechaza el lote (server-side; la del browser es cortesía).
 *
 * Un campo con `from_filename` (#95) NO se lee del formulario: sale del `filename` y, si el nombre no
 * cumple la convención, la carga falla explícita. Sin `filename` un slot con derivación no resuelve
 * (fail-closed) — por eso la validación es **por archivo**, no por lote.
 */
export function validateMeta(slot: IntakeSlot, submitted: Record<string, string>, filename?: string): ValidateMetaResult {
  const values: Record<string, string> = {}
  const verify: Record<string, string> = {}
  for (const f of slot.meta ?? []) {
    let raw: string
    if (f.fromFilename) {
      if (!filename) return { ok: false, error: `«${f.label}» se deriva del nombre del archivo y no se recibió un nombre.` }
      const d = deriveMetaFromFilename(f, filename)
      if (!d.ok) return { ok: false, error: d.error }
      raw = d.value
      if (f.fromFilename.verifyAgainst) verify[f.id] = f.fromFilename.verifyAgainst
    } else {
      raw = (submitted[f.id] ?? '').trim()
    }
    if (!raw) {
      if (f.required) return { ok: false, error: `Falta el campo requerido «${f.label}».` }
      continue // opcional sin valor: no viaja
    }
    switch (f.type) {
      case 'number':
        if (!Number.isFinite(Number(raw))) return { ok: false, error: `«${f.label}» debe ser un número (recibido: '${raw}').` }
        break
      case 'enum': {
        // `options` siempre está presente y resuelta (el parse rechaza un enum sin `options` ni
        // `options_ref`, y una `options_ref` que no apunte a un catálogo declarado). La pertenencia se
        // mide por `value`: el `label` es display y nunca viaja. Esta ES la compuerta del POST — el
        // `<select>` del browser es cortesía y manipular el HTML no la salta (issue #109).
        if (!(f.options ?? []).some((o) => o.value === raw)) {
          if (!f.optionsRef) return { ok: false, error: `«${f.label}»: '${raw}' no es una opción válida.` }
          return {
            ok: false,
            error: f.fromFilename
              ? `El valor '${raw}' derivado del nombre '${filename}' no está en el catálogo «${f.optionsRef}» de «${f.label}».`
              : `«${f.label}»: '${raw}' no está en el catálogo «${f.optionsRef}».`,
          }
        }
        break
      }
      case 'rut':
        if (!validateRut(raw)) return { ok: false, error: `«${f.label}»: RUT inválido (dígito verificador no cuadra): '${raw}'.` }
        break
      case 'string':
        break
    }
    values[f.id] = raw
  }
  return Object.keys(verify).length ? { ok: true, values, verify } : { ok: true, values }
}

/** ¿El slot resuelve toda su metadata desde el nombre del archivo? (el formulario no pide nada). */
export const metaEsDerivada = (slot: IntakeSlot): boolean =>
  (slot.meta?.length ?? 0) > 0 && (slot.meta ?? []).every((f) => !!f.fromFilename)

/** Nombre del sidecar de metadata de un archivo: `<archivo>.meta.json`. */
export const sidecarName = (filename: string): string => `${filename}.meta.json`

/** ¿El nombre es un sidecar de metadata (no un archivo de datos)? Para filtrar listados del landing. */
export const isSidecarName = (name: string): boolean => name.endsWith('.meta.json')

/**
 * Construye el JSON del sidecar (issue #76). Orden: `slot` → campos de metadata → `verify` (#95) →
 * auditoría (`uploadedBy`/`uploadedAt`). El SJD lo lee para imputar la metadata sin intervención humana.
 *
 * `verify` (`{ campo: columna }`) es la directiva de contraste contra el CONTENIDO: donde esa columna
 * venga informada, su valor debe coincidir con el del campo o la carga se rechaza. La hace cumplir el
 * convertidor —único que lee el archivo—; Vergis la declara y la propaga.
 */
export function buildSidecar(
  slotId: string,
  values: Record<string, string>,
  uploadedBy: string,
  uploadedAt: string,
  verify?: Record<string, string>,
): string {
  const verifyPart = verify && Object.keys(verify).length ? { verify } : {}
  return JSON.stringify({ slot: slotId, ...values, ...verifyPart, uploadedBy, uploadedAt }, null, 2)
}
