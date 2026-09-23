/**
 * LA PUERTA ÚNICA de carga de archivos — `/cargar` (#269·§4, hito P2).
 *
 * Una sola superficie para quien sube: la zona general que enruta cada archivo por su nombre, una
 * tarjeta por tipo de archivo con su estado, y la página de cada tipo con su FICHA (qué es, de dónde
 * se saca, cómo se llama, qué reemplaza, qué va junto, qué subir antes), su zona de subida, sus cargas
 * con el estado vivo y sus problemas frecuentes. La vista técnica (Cargas) queda para quien opera.
 *
 * Tres reglas que este módulo sostiene y que no se negocian:
 *  · **Vista de usuario sin jerga** (§4.3): esta página no muestra corridas, logs, rutas, códigos ni
 *    ids, ni las palabras de la operación. Los textos son los de §4.2, al pie de la letra.
 *  · **La puerta nunca es más estricta que la subida con tipo elegido** (D-222 del lab): el nombre
 *    enruta solo lo inequívoco; lo que calza con dos o más tipos —o con ninguno pero hay un tipo que
 *    acepta cualquier nombre— se manda a ELEGIR, nunca se rechaza en duro. Con el tipo elegido, la
 *    validación es exactamente la de la subida a una casilla (`validarEnLaPuerta`, 0.35.1).
 *  · **El request path no lista el almacenamiento ni consulta el motor** para dibujar estados: lee el
 *    registro de cargas y la PROYECCIÓN del vigilante. El estado vivo (fragmento cada 10 s) también.
 *
 * El gate es el de la gestión de dominio (`canMng`, admin.ts): quien gestiona un dominio sube a sus
 * tipos de archivo. El enrutamiento solo considera los tipos de los dominios del usuario.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  escapeHtml,
  redactSecrets,
  validateUpload,
  validateMeta,
  buildSidecar,
  slotMaxBytes,
  tokenFromFilename,
  resolverGuia,
  guiasDelSlot,
  DEFAULT_MAX_AGE_MINUTES,
  DEFAULT_MAX_RUN_MINUTES,
  type DomainDecl,
  type IntakeSlot,
  type IntakeUploadRow,
  type IntakeUploadStore,
  type RunRecord,
  type DesenlaceCodigoConteo,
  type GuiaResuelta,
} from '@vergis/capabilities'
import { nombreCanonico, slotsQueCalzan, describirPatron } from '../packages/capabilities/src/intake'
import { readMultipart } from './multipart'
import { shellNav, send, redirect, readForm, requireCsrf, chip, aviso, ficha, filaCarga, pasos, plegado, zonaSubida, fecha, FECHAS_LOCALES_JS } from './ui'
import { estadoVisible, guiaDeCarga, historiaDeIntentos, lineaDeAviso, motivoDeRechazo, cargasHref, type ContextoEstado, type IntakeUploadEvent } from './admin-cargas'
import type { AdminDeps } from './admin'

// ─── La decisión del destino (la puerta) ────────────────────────────────────────────────────────

/**
 * Cómo se NOMBRA la carga original en el aviso de duplicado (issue #62).
 *
 * Formato ya en producción para las cargas vividas (`<filename> · <YYYY-MM-DD HH:MM> UTC`): el audit
 * log lo trae escrito así desde 0.7.0 y no se re-formatea. Para una fila derivada del indexado
 * retroactivo de `_processed/` lo único que se sabe es que el archivo YA fue procesado, y eso dice.
 */
export function dupLabel(row: Pick<IntakeUploadRow, 'filename' | 'uploadedAt' | 'origen'>): string {
  const cuando = `${row.uploadedAt.slice(0, 16).replace('T', ' ')} UTC`
  return row.origen === 'retro' ? `${row.filename} · procesado el ${cuando}` : `${row.filename} · ${cuando}`
}

/**
 * La subida a un TIPO ELEGIDO por el usuario (#269·0.35.1, D-222 del lab): la validación de siempre
 * del slot, y nada más. **Un nombre que calza con el tipo elegido se acepta SIEMPRE**, aunque calce
 * también con otros: el usuario ya dijo a cuál va, y su patrón lo confirma. Que calce con otros es un
 * defecto de la CONFIGURACIÓN, no del archivo: se devuelve (`tambienCalza`) para señalarlo al
 * operador, jamás para rechazar. Por construcción, ninguna configuración de instancia puede volver
 * esta puerta más estricta que la de 0.34.0 (en 0.35.0 lo hizo: con cinco casillas en `*.xlsx`
 * rechazaba toda subida — INC-09).
 */
export function validarEnLaPuerta(slots: IntakeSlot[], slot: IntakeSlot, filename: string, size: number): { ok: true; tambienCalza: IntakeSlot[] } | { ok: false; error: string; reason?: 'accept' } {
  const v = validateUpload(slot, filename, size)
  if (!v.ok) return v.reason ? { ok: false, error: v.error, reason: v.reason } : { ok: false, error: v.error }
  return { ok: true, tambienCalza: slotsQueCalzan(slots, filename).filter((s) => s.id !== slot.id) }
}

/**
 * La puerta SIN tipo elegido (#269·§4.1, D12): el nombre decide el destino. Con exactamente un tipo
 * que calza, ese; con ninguno, `ninguno`; con dos o más, `ambiguo` — no se puede saber a cuál va, y
 * adivinar es el «archivo en el tipo equivocado» que el invariante vuelve imposible. `slots` son los
 * tipos del USUARIO (juez 0.35.1 · m2): un tipo de otro dominio no vuelve ambiguo un nombre.
 */
export function enrutarPorNombre(slots: IntakeSlot[], filename: string): { kind: 'uno'; slot: IntakeSlot } | { kind: 'ninguno' } | { kind: 'ambiguo'; slots: IntakeSlot[] } {
  const calzan = slotsQueCalzan(slots, filename)
  if (calzan.length === 1) return { kind: 'uno', slot: calzan[0]! }
  return calzan.length === 0 ? { kind: 'ninguno' } : { kind: 'ambiguo', slots: calzan }
}

/** El destino de UN archivo en la puerta (#269·§4.1-4.2). */
export type Destino =
  /** Calza con el tipo de la página donde se soltó (o es el que el usuario eligió). */
  | { kind: 'aqui'; slot: IntakeSlot }
  /** Calza con un único tipo, distinto de la página: se enruta allá. */
  | { kind: 'va'; slot: IntakeSlot }
  /** No se puede decidir por el nombre: el usuario elige entre `candidatos`. Nunca es un rechazo. */
  | { kind: 'elegir'; candidatos: IntakeSlot[] }
  /** Ningún tipo del usuario lo aceptaría, ni eligiéndolo: es el único rechazo por nombre. */
  | { kind: 'ninguno' }

/**
 * La decisión de la puerta (#269·§4.1, D-222). En orden:
 *  1. el tipo que el usuario ELIGIÓ para ese archivo (su validación es la de la subida con tipo);
 *  2. el tipo de la página, si su patrón calza (aunque calce también con otros: D-222);
 *  3. el único tipo del usuario cuyo patrón calza;
 *  4. si calza con dos o más —o con ninguno pero hay tipos que aceptan cualquier nombre—, ELEGIR;
 *  5. si ninguno lo aceptaría, `ninguno`.
 * Propiedad que el test sostiene: todo nombre que la subida a algún tipo del usuario aceptaría por su
 * patrón termina en `aqui`, `va` o `elegir` — jamás en `ninguno`.
 */
export function decidirDestino(tipos: IntakeSlot[], filename: string, pagina?: IntakeSlot, elegido?: IntakeSlot): Destino {
  const n = nombreCanonico(filename).trim()
  if (elegido) return { kind: elegido.id === pagina?.id ? 'aqui' : 'va', slot: elegido }
  const calza = (s: IntakeSlot): boolean => {
    const v = validateUpload(s, n, 1)
    return v.ok || v.reason !== 'accept'
  }
  if (pagina && calza(pagina)) return { kind: 'aqui', slot: pagina }
  const r = enrutarPorNombre(tipos, n)
  if (r.kind === 'uno') return r.slot.id === pagina?.id ? { kind: 'aqui', slot: r.slot } : { kind: 'va', slot: r.slot }
  // Un tipo sin patrón acepta cualquier nombre: con él, «ninguno» sería más estricto que la subida con
  // tipo elegido. Se ofrece para elegir, junto a los que calzan.
  const libres = tipos.filter((s) => !s.accept)
  const candidatos = [...(r.kind === 'ambiguo' ? r.slots : []), ...libres.filter((s) => r.kind !== 'ambiguo' || !r.slots.includes(s))]
  return candidatos.length ? { kind: 'elegir', candidatos } : { kind: 'ninguno' }
}

/** El nombre esperado de un tipo, en palabras: la ficha, o el patrón dicho en palabras. */
export const nombreEsperado = (s: IntakeSlot): string => s.ficha?.nombre ?? describirPatron(s.accept)

/** «Este nombre no corresponde…» con los nombres esperados (§4.2), o el caso de la carga 27. */
async function textoNinguno(deps: AdminDeps, tipos: IntakeSlot[], filename: string): Promise<string> {
  const previo = deps.intakeUploads?.findAcceptedUploadByFilename ? await deps.intakeUploads.findAcceptedUploadByFilename(filename).catch(() => null) : null
  const tipoPrevio = previo ? tipos.find((s) => s.id === previo.slotId) ?? (deps.intakeSlots ?? []).find((s) => s.id === previo.slotId) : undefined
  if (tipoPrevio)
    return `Este archivo se recibió antes como «${tipoPrevio.label}», pero ese archivo ahora tiene que llamarse así: ${nombreEsperado(tipoPrevio)} Si es la planilla nueva, cámbiale el nombre; si es la antigua, ya no se carga.`
  const lista = tipos.map((s) => `«${s.label}»: ${nombreEsperado(s)}`).join(' · ')
  return `Este nombre no corresponde a ningún archivo que puedas subir. Los nombres esperados son: ${lista}`
}

// ─── El aviso de duplicado (V4) ─────────────────────────────────────────────────────────────────

/** #269·V4 · la carga MÁS RECIENTE con ese contenido (la original puede haberse pisado o no haberse
 *  cargado nunca). Sin la lectura nueva en el store, la original: el aviso degrada, no miente. */
export async function ultimaConContenido(store: IntakeUploadStore, slotId: string, sha: string): Promise<IntakeUploadRow | null> {
  const f = store.findLatestUploadBySha ? store.findLatestUploadBySha.bind(store) : store.findUploadBySha.bind(store)
  return f(slotId, sha).catch(() => null)
}

/** Lo que el aviso de duplicado necesita saber del slot, además de la carga previa. */
export interface InsumosDuplicado {
  /** Cargas recientes del slot (para saber si la previa sigue vigente). `null` = no se pudo leer. */
  cargas: IntakeUploadRow[] | null
  /** Nombres en el landing. `null` = no se pudo leer a tiempo: no se afirma «en espera». */
  landing: Set<string> | null
}

/** Los insumos del aviso: el registro y el landing, este de la PROYECCIÓN si la hay (sin ir al
 *  almacenamiento); sin proyección, el listado vivo con 2 s de tope, como el pre-check de siempre. */
export async function insumosDeDuplicado(deps: AdminDeps, slot: IntakeSlot): Promise<InsumosDuplicado> {
  const cargas = deps.intakeUploads ? await deps.intakeUploads.listUploads(slot.id, 200).catch(() => null) : null
  let landing: Set<string> | null = null
  const proy = deps.intakeProyeccion ? await deps.intakeProyeccion(slot).catch(() => null) : null
  if (proy) landing = new Set(proy.landing)
  else if (deps.cargas?.landing) {
    const lista = await Promise.race([
      deps.cargas.landing(slot).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
    ])
    if (lista) landing = new Set(lista.filter((e) => !e.isDirectory).map((e) => e.path.replace(/^.*\//, '')))
  }
  return { cargas, landing }
}

/**
 * El AVISO de duplicado, verdadero (#269·V4). Se mira la carga MÁS RECIENTE con ese contenido y su
 * estado, y cada frase se dice solo si es cierta:
 *  · cargada y vigente (ninguna carga posterior del mismo nombre se cargó después) → «no cambia nada»;
 *  · cargada pero pisada, o de vigencia desconocida → solo el hecho, sin la promesa;
 *  · en espera (sigue en el landing) → «se vuelve a intentar solo»;
 *  · todavía cargándose → que se está cargando;
 *  · no cargada y fuera del landing → que esa vez no se cargó, y por qué.
 * `pregunta` = el navegador ofrece «Subir igual / No subir»; si no, solo informa.
 */
export function avisoDeDuplicado(prev: IntakeUploadRow, ins: InsumosDuplicado, nowMs: number): { texto: string; pregunta: boolean } {
  const fechaTxt = `${prev.uploadedAt.slice(0, 16).replace('T', ' ')} UTC`
  const quien = prev.uploadedBy && prev.origen !== 'retro' ? ` (${prev.uploadedBy})` : ''
  if (prev.origen === 'retro') return { texto: `Este mismo archivo ya se cargó el ${fechaTxt}.`, pregunta: true }
  const estado = prev.desenlace
  if (estado === 'procesada') {
    const pisada = ins.cargas == null
      ? null
      : ins.cargas.some((c) => c.id !== prev.id && c.ok && c.filename === prev.filename && c.desenlace === 'procesada' && Date.parse(c.uploadedAt) > Date.parse(prev.uploadedAt))
    if (pisada === false) return { texto: `Ya se cargó este mismo archivo el ${fechaTxt}${quien}. Subirlo de nuevo no cambia nada.`, pregunta: true }
    return { texto: `Este mismo archivo ya se cargó el ${fechaTxt}${quien}.`, pregunta: true }
  }
  const enLanding = ins.landing?.has(prev.filename.replace(/^.*[/\\]/, '')) ?? null
  if (estado == null) {
    const min = Math.max(0, Math.round((nowMs - Date.parse(prev.uploadedAt)) / 60_000))
    return { texto: `Subiste este mismo archivo hace ${min} minuto${min === 1 ? '' : 's'} y todavía se está cargando.`, pregunta: true }
  }
  if ((estado === 'fallida' || estado === 'saltada') && enLanding === true)
    return { texto: `Ya subiste este mismo archivo el ${fechaTxt} y todavía está en espera: se vuelve a intentar solo. No hace falta subirlo de nuevo.`, pregunta: true }
  const frase: Partial<Record<string, string>> = {
    fallida: 'el proceso de carga lo rechazó',
    saltada: 'el proceso de carga no lo cargó',
    'sin-informe': 'el proceso de carga no informó qué pasó',
    retirada: 'se retiró antes de cargarse',
    reemplazada: 'lo reemplazó otra carga con el mismo nombre',
    deshecha: 'se cargó y después se deshizo',
    varada: 'quedó esperando sin que el proceso lo tomara',
  }
  return { texto: `Ya subiste este mismo archivo el ${fechaTxt} y esa vez no se cargó: ${frase[estado] ?? estado}. Revisa eso antes de volver a subirlo.`, pregunta: true }
}

// ─── Recibir archivos (el cuerpo común de toda subida) ─────────────────────────────────────────

/** Un archivo que ya tiene destino. */
export interface Entrante {
  filename: string
  bytes: Buffer
  slot: IntakeSlot
}

export type ResultadoRecepcion =
  | { ok: true; n: number; conDisparo: IntakeSlot[]; sinDisparo: IntakeSlot[]; duplicados: string[] }
  | { ok: false; error: string; filename: string; slot?: IntakeSlot; reason?: 'accept' }

/** Los datos de un tipo que vienen en el formulario: `meta.<tipo>.<campo>` (la puerta, varios tipos
 *  en un lote) o `meta_<campo>` (el formulario de siempre, un solo tipo). */
export function metaDelFormulario(fields: Record<string, string>, slot: IntakeSlot): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (k.startsWith('meta_')) out[k.slice('meta_'.length)] = v
  for (const [k, v] of Object.entries(fields)) if (k.startsWith(`meta.${slot.id}.`)) out[k.slice(`meta.${slot.id}.`.length)] = v
  return out
}

/**
 * RECIBE un lote ya enrutado: valida TODO antes de aterrizar nada (o entra el lote completo o
 * ninguno), registra cada archivo con su contenido, aterriza, dispara UNA corrida por tipo y acelera
 * el vigilante de cada tipo tocado. Es el mismo cuerpo que `handleIntake` tenía para un solo tipo.
 */
export async function recibir(deps: AdminDeps, tipos: IntakeSlot[], lote: Entrante[], fields: Record<string, string>, by: string): Promise<ResultadoRecepcion> {
  const intake = deps.intake!
  const shas = lote.map((u) => createHash('sha256').update(u.bytes).digest('hex'))
  const uploadRow = (i: number, ok: boolean, extra: Partial<Omit<IntakeUploadRow, 'id'>> = {}): Omit<IntakeUploadRow, 'id'> => ({
    slotId: lote[i]!.slot.id, filename: lote[i]!.filename, sha256: shas[i]!, bytes: lote[i]!.bytes.length,
    uploadedBy: by, uploadedAt: new Date().toISOString(), ok, triggered: false, origen: 'upload', ...extra,
  })
  const registrar = async (row: Omit<IntakeUploadRow, 'id'>): Promise<number | undefined> =>
    deps.intakeUploads ? await deps.intakeUploads.recordUpload(row).catch(() => undefined) : undefined
  const rechazar = async (i: number, error: string, reason?: 'accept'): Promise<ResultadoRecepcion> => {
    const u = lote[i]!
    await registrar(uploadRow(i, false, { error }))
    deps.audit({ type: 'intake', slot: u.slot.id, domain: u.slot.domain ?? '', filename: u.filename, bytes: u.bytes.length, by, ok: false, error })
    return { ok: false, error, filename: u.filename, slot: u.slot, ...(reason ? { reason } : {}) }
  }
  for (const s of new Set(lote.map((u) => u.slot))) deps.intakeBackfill?.(s)
  // Validar TODOS antes de aterrizar ninguno (atomicidad: el proceso espera el juego consistente).
  const tambienCalza: Record<string, string[]> = {}
  for (const [i, u] of lote.entries()) {
    const v = validarEnLaPuerta(deps.intakeSlots ?? [], u.slot, u.filename, u.bytes.length)
    if (v.ok && v.tambienCalza.length) tambienCalza[u.filename] = v.tambienCalza.map((s) => s.id)
    if (!v.ok) {
      // #269·§4.1 · un nombre que ya se RECIBIÓ antes y hoy no calza con ningún tipo (la carga 27).
      let error = v.error
      if (v.reason === 'accept' && !slotsQueCalzan(deps.intakeSlots ?? [], u.filename).length) {
        const previo = deps.intakeUploads?.findAcceptedUploadByFilename ? await deps.intakeUploads.findAcceptedUploadByFilename(u.filename).catch(() => null) : null
        const tipoPrevio = previo ? (deps.intakeSlots ?? []).find((s) => s.id === previo.slotId) : undefined
        if (tipoPrevio) error = `Este archivo se recibió antes como «${tipoPrevio.label}», pero ese archivo ahora tiene que llamarse así: ${nombreEsperado(tipoPrevio)} Si es la planilla nueva, cámbiale el nombre; si es la antigua, ya no se carga.`
      }
      return rechazar(i, error, v.reason)
    }
  }
  // Metadata requerida (issue #76), POR ARCHIVO (un campo `from_filename` se deriva de su nombre).
  const metaPorArchivo: { values: Record<string, string>; verify?: Record<string, string> }[] = []
  for (const [i, u] of lote.entries()) {
    const m = validateMeta(u.slot, metaDelFormulario(fields, u.slot), u.filename)
    if (!m.ok) return rechazar(i, m.error)
    metaPorArchivo.push({ values: m.values, ...(m.verify ? { verify: m.verify } : {}) })
  }
  const uploadedAt = new Date().toISOString()
  const duplicados: string[] = []
  const insumos = new Map<string, InsumosDuplicado>()
  const conDisparo: IntakeSlot[] = []
  const sinDisparo: IntakeSlot[] = []
  for (const [i, u] of lote.entries()) {
    const slot = u.slot
    const willTrigger = !!(slot.trigger && intake.runNow)
    const sha256 = shas[i]!
    // Dedup por CONTENIDO (issue #62): avisar, NUNCA bloquear; `dup_of` apunta a la ORIGINAL.
    const previa = deps.intakeUploads ? await deps.intakeUploads.findUploadBySha(slot.id, sha256).catch(() => null) : null
    const dupOf = previa ? dupLabel(previa) : null
    if (previa && deps.intakeUploads) {
      if (!insumos.has(slot.id)) insumos.set(slot.id, await insumosDeDuplicado(deps, slot))
      const ultima = await ultimaConContenido(deps.intakeUploads, slot.id, sha256)
      if (ultima) duplicados.push(`«${u.filename}»: ${avisoDeDuplicado(ultima, insumos.get(slot.id)!, Date.now()).texto}`)
    }
    const m = metaPorArchivo[i]!
    const sidecar = (slot.meta?.length ?? 0) > 0 ? buildSidecar(slot.id, m.values, by, uploadedAt, m.verify) : undefined
    await intake.put(slot.target, u.filename, u.bytes, sidecar)
    await registrar(uploadRow(i, true, { uploadedAt, triggered: willTrigger, ...(previa ? { dupOfId: previa.id } : {}) }))
    deps.audit({ type: 'intake', slot: slot.id, domain: slot.domain ?? '', filename: u.filename, bytes: u.bytes.length, by, ok: true, triggered: willTrigger, sha256, ...(dupOf ? { dupOf } : {}), ...(tambienCalza[u.filename] ? { tambienCalza: tambienCalza[u.filename] } : {}) })
    const lista = willTrigger ? conDisparo : sinDisparo
    if (!lista.includes(slot)) lista.push(slot)
  }
  // UN SOLO disparo por tipo y por lote (N disparos = N corridas = throttling de capacidad).
  for (const s of conDisparo) await intake.runNow!(s.trigger!, s.target)
  for (const s of new Set([...conDisparo, ...sinDisparo])) deps.acelerarCarga?.(s.id)
  return { ok: true, n: lote.length, conDisparo, sinDisparo, duplicados }
}

/** El mensaje «Tras subir» (§4.2). */
export function mensajeTrasSubir(r: Extract<ResultadoRecepcion, { ok: true }>): string {
  const partes = [`Recibimos ${r.n} archivo(s).`]
  if (r.conDisparo.length) partes.push('Ya empezó la carga: esta página se actualiza sola y verás el resultado abajo.')
  for (const s of r.sinDisparo) partes.push(`Este archivo no se carga en el momento: lo toma el proceso ${s.ficha?.cadencia ?? 'en su próxima pasada'}.`)
  const dup = r.duplicados.length ? ` ⚠ ${r.duplicados.join(' ')}` : ''
  return partes.join(' ') + dup
}

// ─── Estado de cada carga (lo que se dibuja) ───────────────────────────────────────────────────

/** Lo que la página sabe del almacenamiento y del motor: la PROYECCIÓN del vigilante. */
export interface ProyeccionTipo {
  /** Nombres de archivo en el landing según la última observación. */
  landing: string[]
  runs: RunRecord[]
  observedAt: string | null
}

/** Cargas de un tipo, de la más reciente a la más antigua (el registro; sin tocar el almacenamiento). */
async function cargasDe(deps: AdminDeps, slot: IntakeSlot, limite = 30): Promise<IntakeUploadEvent[]> {
  if (deps.cargas) return deps.cargas.history(slot, limite).catch(() => [])
  if (!deps.intakeUploads) return []
  const rows = await deps.intakeUploads.listUploads(slot.id, limite * 2).catch(() => [])
  return rows.filter((r) => r.origen === 'upload').slice(0, limite).map((r) => {
    const ev: IntakeUploadEvent = { id: r.id, ts: r.uploadedAt, filename: r.filename, bytes: r.bytes, by: r.uploadedBy ?? '', ok: r.ok, triggered: r.triggered, sha256: r.sha256 }
    if (!r.ok && r.error != null) ev.error = r.error
    if (r.desenlace != null) ev.desenlace = r.desenlace
    if (r.desenlaceFinal != null) ev.desenlaceFinal = r.desenlaceFinal
    if (r.desenlaceMotivo != null) ev.desenlaceMotivo = r.desenlaceMotivo
    if (r.desenlaceRunStartedAt != null) ev.desenlaceRunStartedAt = r.desenlaceRunStartedAt
    if (r.desenlaceAt != null) ev.desenlaceAt = r.desenlaceAt
    if (r.desenlaceCodigo != null) ev.desenlaceCodigo = r.desenlaceCodigo
    if (r.desenlaceParams != null) ev.desenlaceParams = r.desenlaceParams
    if (r.actoAt != null) ev.actoAt = r.actoAt
    return ev
  })
}

/** Margen hacia atrás para decir «Cargando» (P27) — el mismo de la consola técnica. */
const CORRIDA_EN_CURSO_MS = 30 * 60_000

/** El contexto de estado de UNA carga, desde la proyección (el mismo predicado que la consola). */
function contextoDe(deps: AdminDeps, slot: IntakeSlot, proy: ProyeccionTipo | null, nowMs: number): (h: IntakeUploadEvent) => ContextoEstado {
  const enLanding = proy ? new Set(proy.landing) : null
  const enCurso = proy ? proy.runs.filter((r) => r.status === 'InProgress' || r.status === 'NotStarted') : []
  const avisoLinea = lineaDeAviso({ ...(deps.hayDestinoOperador?.() === true ? { equipoAvisado: true } : {}), ...(slot.contacto ? { contacto: slot.contacto } : {}) })
  const edadMaximaMin = slot.watch === false ? undefined : slot.watch?.maxAgeMinutes ?? (slot.trigger ? DEFAULT_MAX_AGE_MINUTES : undefined)
  const tituloDeIntento = (i: { codigo?: string; params?: Record<string, string | string[]>; motivo?: string }): string => {
    const g = i.codigo && deps.intakeGuias ? resolverGuia(slot, i.codigo, i.params, deps.intakeGuias) : null
    if (g) return g.titulo
    if (i.motivo) return i.motivo.length > 120 ? i.motivo.slice(0, 120) + '…' : i.motivo
    return 'no se informó el motivo'
  }
  return (h) => {
    const c: ContextoEstado = { aviso: avisoLinea, tituloDeIntento, fecha }
    if (enLanding) c.enLanding = enLanding.has(h.filename)
    const subida = Date.parse(h.ts)
    if (enCurso.some((r) => Date.parse(r.startedAt) >= subida - CORRIDA_EN_CURSO_MS && nowMs - Date.parse(r.startedAt) <= DEFAULT_MAX_RUN_MINUTES * 60_000)) c.enCurso = true
    if (!h.desenlace && Number.isFinite(subida)) c.esperaMin = (nowMs - subida) / 60_000
    if (edadMaximaMin != null) c.edadMaximaMin = edadMaximaMin
    return c
  }
}

/** ¿Hay cargas que todavía pueden cambiar de estado? Decide si la página sigue preguntando. */
export const hayNoFinales = (cargas: IntakeUploadEvent[]): boolean => cargas.some((h) => h.ok && h.desenlaceFinal !== true)

/** El bloque de una guía para quien sube: título, qué pasó, qué hacer (§4.2). */
function bloqueGuia(g: GuiaResuelta): string {
  const t = (x: string): string => escapeHtml(redactSecrets(x))
  return `<div><b>${t(g.titulo)}</b></div><div class="sub">${t(g.quePaso)}</div>${pasos(g.queHacer.map((p) => redactSecrets(p)))}`
}

/** UNA carga dibujada para quien sube (§4.2, «Cada carga, por estado»). */
export function renderCarga(slot: IntakeSlot, tipos: IntakeSlot[], h: IntakeUploadEvent, ctx: ContextoEstado, guia: GuiaResuelta | null, retirarHref: string | null): string {
  let rechazo: IntakeUploadEvent = h
  if (!h.ok && h.error && /no coincide con el patrón esperado/.test(h.error)) {
    // El rechazo por nombre dicho sin jerga: si corresponde a OTRO tipo, cuál; si no, que a ninguno.
    const otros = slotsQueCalzan(tipos, h.filename).filter((s) => s.id !== slot.id)
    rechazo = { ...h, error: motivoDeRechazo(h.error, { otroTipo: otros.length === 1 ? otros[0]!.label : null }) }
  }
  const v = estadoVisible(rechazo, ctx, guia)
  const extra: string[] = []
  const conGuia = guia && (h.desenlace === 'fallida' || h.desenlace === 'saltada') && guia.actor !== 'operador' && !(ctx.enCurso && h.desenlaceFinal !== true)
  if (conGuia) extra.push(bloqueGuia(guia!))
  if (h.ok && h.desenlace === 'fallida' && !guia && h.desenlaceMotivo && !(ctx.enCurso && h.desenlaceFinal !== true)) {
    const m = redactSecrets(h.desenlaceMotivo)
    extra.push(m.length > 300
      ? `<div class="sub">${escapeHtml(m.slice(0, 300))}…</div>${plegado('ver completo', `<div class="sub" style="white-space:pre-wrap">${escapeHtml(m)}</div>`)}`
      : `<div class="sub">${escapeHtml(m)}</div>`)
  }
  const historia = historiaDeIntentos(h, ctx)
  if (historia) extra.push(historia)
  if (v.retirable && retirarHref) extra.push(`<a href="${escapeHtml(retirarHref)}">Retirar este archivo</a>`)
  return filaCarga({
    nombre: h.filename,
    chipHtml: chip(v.tono, v.etiqueta),
    cuandoHtml: `subido el ${fecha(h.ts)}${h.by ? ` por ${escapeHtml(h.by)}` : ''}`,
    fraseHtml: v.frase,
    extraHtml: extra.join(''),
  })
}

/** La lista «Cargas de este archivo» (también es el fragmento que se refresca). */
export function listaDeCargas(deps: AdminDeps, slot: IntakeSlot, tipos: IntakeSlot[], cargas: IntakeUploadEvent[], proy: ProyeccionTipo | null, nowMs: number): string {
  if (!cargas.length) return '<p class="sub">Todavía no se ha subido ninguno.</p>'
  const ctxDe = contextoDe(deps, slot, proy, nowMs)
  // «Retirar» solo en la carga MÁS RECIENTE de cada nombre: es la única cuyo archivo puede estar en espera.
  const ultimas = new Set<IntakeUploadEvent>()
  const vistos = new Set<string>()
  for (const h of cargas) if (h.ok && !vistos.has(h.filename)) { vistos.add(h.filename); ultimas.add(h) }
  return cargas.map((h) => {
    const retirar = deps.cargas && h.id != null && ultimas.has(h) ? `/cargar/${encodeURIComponent(slot.id)}/retirar?carga=${h.id}` : null
    return renderCarga(slot, tipos, h, ctxDe(h), guiaDeCarga(slot, h, deps.intakeGuias), retirar)
  }).join('')
}

/** El estado de un tipo en su tarjeta (§4.2): lo que pide acción, lo que se está cargando, o la última. */
export function estadoDeTarjeta(deps: AdminDeps, slot: IntakeSlot, cargas: IntakeUploadEvent[], proy: ProyeccionTipo | null, nowMs: number): string {
  const ctxDe = contextoDe(deps, slot, proy, nowMs)
  const vistos = new Set<string>()
  const ultimas: IntakeUploadEvent[] = []
  for (const h of cargas) if (h.ok && !vistos.has(h.filename)) { vistos.add(h.filename); ultimas.push(h) }
  const visibles = ultimas.map((h) => ({ h, v: estadoVisible(h, ctxDe(h), guiaDeCarga(slot, h, deps.intakeGuias)) }))
  const pide = visibles.filter(({ v }) => v.tono === 'error' || v.etiqueta === '⚠ Detenido por precaución').length
  if (pide) return chip('atencion', `⚠ ${pide} archivo(s) necesitan que hagas algo`)
  const cargando = visibles.filter(({ v }) => v.etiqueta === 'Recibido' || v.etiqueta === '⏳ Cargando').length
  if (cargando) return chip('curso', `⏳ ${cargando} archivo(s) cargándose`)
  const ultima = visibles[0]
  if (ultima) return `Última carga: ${fecha(ultima.h.ts)} · ${chip(ultima.v.tono, ultima.v.etiqueta)}`
  return 'Todavía no se ha subido ninguno'
}

// ─── Páginas ────────────────────────────────────────────────────────────────────────────────────

/** Lo que la puerta sabe del request: quién, qué puede subir y el marco de la página. */
export interface CargarContexto {
  deps: AdminDeps
  email: string
  token: string
  /** Tipos de archivo que la identidad puede subir (los de los dominios que gestiona). */
  tipos: IntakeSlot[]
  /** Dominios que gestiona (para agrupar por área). */
  dominios: DomainDecl[]
  avatar: string
  brand: string
}

const hrefTipo = (s: IntakeSlot): string => `/cargar/${encodeURIComponent(s.id)}`

function sidebar(c: CargarContexto, activo: string): string {
  const lvl = (href: string, label: string, on: boolean, cls = ''): string =>
    `<a href="${escapeHtml(href)}" class="${[cls, on ? 'on' : ''].filter(Boolean).join(' ')}">${escapeHtml(label)}</a>`
  let s = `<span class="bca">${escapeHtml(c.brand)}</span><a href="/" class="catlink">↩ Catálogo de PIs</a>`
  s += lvl('/cargar', 'Cargar archivos', activo === '')
  for (const d of areas(c)) {
    s += `<div class="grp">${escapeHtml(d.label)}</div>`
    for (const t of d.tipos) s += lvl(hrefTipo(t), t.label, activo === t.id, 'l2')
  }
  return s
}

/** Los tipos agrupados por área (dominio), en el orden declarado. */
function areas(c: CargarContexto): { label: string; tipos: IntakeSlot[] }[] {
  const out: { label: string; tipos: IntakeSlot[] }[] = []
  for (const d of c.dominios) {
    const tipos = c.tipos.filter((s) => (s.domain ?? '') === d.id)
    if (tipos.length) out.push({ label: d.label, tipos })
  }
  return out
}

function pagina(c: CargarContexto, activo: string, titulo: string, cuerpo: string): string {
  return shellNav(c.brand, titulo, sidebar(c, activo), c.avatar, `${cuerpo}<script>${FECHAS_LOCALES_JS}</script>`)
}

const flash = (params: URLSearchParams): string => {
  const msg = params.get('msg')
  if (!msg) return ''
  return aviso(params.get('t') === 'error' ? 'error' : 'ok', escapeHtml(msg))
}

/** Los campos que pide un tipo (metadata no derivada del nombre), con su ayuda. */
function camposDe(slot: IntakeSlot, visible: boolean): string {
  const campos = (slot.meta ?? []).filter((f) => !f.fromFilename)
  if (!campos.length) return ''
  const html = campos.map((f) => {
    const name = `meta.${slot.id}.${f.id}`
    const req = f.required ? ' required' : ''
    let control: string
    if (f.type === 'enum') control = `<select name="${escapeHtml(name)}"${req}><option value="">— elegir —</option>${(f.options ?? []).map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label === o.value ? o.value : `${o.label} · ${o.value}`)}</option>`).join('')}</select>`
    else if (f.type === 'number') control = `<input type="number" step="any" name="${escapeHtml(name)}"${req}>`
    else if (f.type === 'rut') control = `<input type="text" name="${escapeHtml(name)}" placeholder="12345678-9"${req}>`
    else control = `<input type="text" name="${escapeHtml(name)}"${req}>`
    return `<label class="fld"><span>${escapeHtml(f.label)} · para «${escapeHtml(slot.label)}»</span>${control}${f.ayuda ? `<span class="sub">${escapeHtml(f.ayuda)}</span>` : ''}</label>`
  }).join('')
  return `<fieldset data-tipo="${escapeHtml(slot.id)}" style="border:none;padding:0;margin:8px 0"${visible ? '' : ' hidden disabled'}>${html}</fieldset>`
}

/**
 * La revisión antes de subir (§4.2), en el navegador y sin librerías. Por cada archivo pregunta a
 * `/cargar/revisar` qué pasa con él (a qué tipo va, si hay que elegir, si no corresponde a ninguno, si
 * ya se subió) y lo muestra; al enviar arma el lote con lo que el usuario dejó y el tipo que eligió.
 * FAIL-SAFE: sin JS o con la revisión caída, el formulario se envía tal cual y el servidor decide.
 */
const REVISION_JS = `(function(z){
if(!z||!window.fetch||!window.FormData)return;
var inp=z.querySelector('input[type=file]'),lista=z.querySelector('ul.rev'),pag=z.getAttribute('data-pagina')||'',items=[];
function hex(b){return [].map.call(new Uint8Array(b),function(x){return ('0'+x.toString(16)).slice(-2)}).join('')}
function sha(f){return (window.crypto&&crypto.subtle)?f.arrayBuffer().then(function(b){return crypto.subtle.digest('SHA-256',b)}).then(hex).catch(function(){return ''}):Promise.resolve('')}
function campos(){var need={};items.forEach(function(it){if(it.sube&&it.tipo)need[it.tipo]=1});[].forEach.call(z.querySelectorAll('fieldset[data-tipo]'),function(fs){var on=!!need[fs.getAttribute('data-tipo')]||(!items.length&&fs.getAttribute('data-tipo')===pag);fs.hidden=!on;fs.disabled=!on})}
function pinta(){lista.innerHTML='';lista.hidden=!items.length;items.forEach(function(it,i){var li=document.createElement('li');var t=document.createElement('div');t.textContent=it.texto;li.appendChild(t);
if(it.derivado){var d=document.createElement('div');d.className='sub';d.textContent=it.derivado;li.appendChild(d)}
if(it.clase==='elegir'){var s=document.createElement('select');var o0=document.createElement('option');o0.value='';o0.textContent='— elige el tipo de archivo —';s.appendChild(o0);it.candidatos.forEach(function(c){var o=document.createElement('option');o.value=c.id;o.textContent=c.label;if(it.tipo===c.id)o.selected=true;s.appendChild(o)});s.onchange=function(){it.tipo=s.value;campos()};li.appendChild(s)}
if(it.dup){var p=document.createElement('div');p.className='sub';p.textContent=it.dup.texto;li.appendChild(p)}
if(it.clase!=='ninguno'){var b=document.createElement('button');b.type='button';b.className='del';b.textContent=it.sube?'No subir':'Subir igual';b.onclick=function(){it.sube=!it.sube;pinta()};li.appendChild(document.createTextNode(' '));li.appendChild(b)}
else{var n=document.createElement('div');n.className='sub';n.textContent='(no se sube)';li.appendChild(n)}
lista.appendChild(li)});campos()}
function revisa(){var fs=[].slice.call(inp.files||[]);items=fs.map(function(f){return {f:f,texto:'Revisando «'+f.name+'»…',sube:true,clase:'',candidatos:[]}});pinta();if(!fs.length)return;
Promise.all(fs.map(sha)).then(function(sh){var b=new URLSearchParams();b.set('_csrf',z._csrf.value);b.set('pagina',pag);b.set('archivos',JSON.stringify(fs.map(function(f,i){return {nombre:f.name,bytes:f.size,sha:sh[i]}})));
return fetch('/cargar/revisar',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:b,credentials:'same-origin'}).then(function(r){return r.json()})}).then(function(j){(j.archivos||[]).forEach(function(a,i){var it=items[i];if(!it)return;it.texto=a.texto;it.clase=a.clase;it.tipo=a.tipo||'';it.candidatos=a.candidatos||[];it.derivado=a.derivado||'';it.dup=a.dup||null;it.sube=a.clase!=='ninguno'&&!a.excluir});pinta()}).catch(function(){items.forEach(function(it){it.texto='«'+it.f.name+'»'});pinta()})}
inp.addEventListener('change',revisa);
z.addEventListener('dragover',function(e){e.preventDefault();z.classList.add('sobre')});z.addEventListener('dragleave',function(){z.classList.remove('sobre')});
z.addEventListener('drop',function(e){e.preventDefault();z.classList.remove('sobre');if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length){inp.files=e.dataTransfer.files;revisa()}});
z.addEventListener('submit',function(e){if(!items.length||!items[0].clase)return;e.preventDefault();
var falta=items.filter(function(it){return it.sube&&it.clase==='elegir'&&!it.tipo})[0];if(falta){alert('Elige a qué tipo de archivo va «'+falta.f.name+'».');return}
var fd=new FormData();fd.append('_csrf',z._csrf.value);[].forEach.call(z.querySelectorAll('input[type=hidden]'),function(h){if(h.name!=='_csrf')fd.append(h.name,h.value)});
[].forEach.call(z.querySelectorAll('fieldset[data-tipo]:not([disabled]) [name]'),function(c){fd.append(c.name,c.value)});
var k=0;items.forEach(function(it){if(!it.sube||it.clase==='ninguno')return;fd.append('file',it.f,it.f.name);if(it.tipo)fd.append('destino_'+k,it.tipo);k++});
if(!k){alert('No quedó ningún archivo para subir.');return}
var btn=z.querySelector('button[type=submit]');if(btn){btn.disabled=true;btn.textContent='Subiendo…'}
fetch(z.action,{method:'POST',body:fd,credentials:'same-origin'}).then(function(r){location.assign(r.url||location.href)}).catch(function(){if(btn){btn.disabled=false;btn.textContent='Subir'}alert('No se pudo subir. Vuelve a intentarlo.')})});
})(document.currentScript.previousElementSibling)`

/** El estado vivo (§7 «P2, estado vivo»): pide el fragmento cada 10 s mientras haya algo que pueda
 *  cambiar, en pausa con la pestaña oculta. Solo lee: el fragmento sale del registro y la proyección. */
const VIVO_JS = `(function(c){if(!c||!window.fetch)return;var u=c.getAttribute('data-fuente'),vivo=c.getAttribute('data-vivo')==='1';
function ve(){if(!vivo||document.hidden)return;fetch(u,{credentials:'same-origin',cache:'no-store'}).then(function(r){vivo=r.headers.get('x-hay-no-finales')==='1';return r.ok?r.text():null}).then(function(h){if(h!=null){c.innerHTML=h;if(window.__fechas)window.__fechas(c)}}).catch(function(){})}
setInterval(ve,10000);document.addEventListener('visibilitychange',ve)})(document.currentScript.previousElementSibling)`

/** `/cargar`: la zona general y una tarjeta por tipo, agrupadas por área. */
async function paginaGeneral(c: CargarContexto, params: URLSearchParams): Promise<string> {
  const bajada = '<p class="sub">Arrastra aquí tus archivos: cada uno va solo al lugar que le corresponde según su nombre. Si quieres saber qué archivo es cada uno, de dónde se saca o cómo tiene que llamarse, abre su tarjeta.</p>'
  if (!c.tipos.length) return pagina(c, '', 'Cargar archivos', `${bajada}<p class="sub">No hay archivos que puedas subir.</p>`)
  const maxMb = Math.max(...c.tipos.map((s) => Math.round(slotMaxBytes(s) / (1024 * 1024))))
  const campos = c.tipos.map((s) => camposDe(s, false)).join('')
  const zona = zonaSubida({ action: '/cargar', token: c.token, maxMb, id: 'zona-general', camposHtml: campos }).replace('<form ', '<form data-pagina="" ')
  const tarjetas = await tarjetasHtml(c)
  return pagina(c, '', 'Cargar archivos', `${bajada}${flash(params)}${zona}<script>${REVISION_JS}</script>
<div id="tarjetas" data-fuente="/cargar/tarjetas" data-vivo="${tarjetas.vivo ? '1' : '0'}">${tarjetas.html}</div><script>${VIVO_JS}</script>`)
}

async function proyeccionDe(deps: AdminDeps, slot: IntakeSlot): Promise<ProyeccionTipo | null> {
  return deps.intakeProyeccion ? deps.intakeProyeccion(slot).catch(() => null) : null
}

async function tarjetasHtml(c: CargarContexto): Promise<{ html: string; vivo: boolean }> {
  const now = Date.now()
  let vivo = false
  let html = ''
  for (const a of areas(c)) {
    const lis: string[] = []
    for (const s of a.tipos) {
      const cargas = await cargasDe(c.deps, s)
      if (hayNoFinales(cargas)) vivo = true
      const estado = estadoDeTarjeta(c.deps, s, cargas, await proyeccionDe(c.deps, s), now)
      lis.push(`<li><div class="tt">${escapeHtml(s.label)}</div>${s.description ? `<div class="sub">${escapeHtml(s.description)}</div>` : ''}<div style="margin:8px 0">${estado}</div><a href="${escapeHtml(hrefTipo(s))}">Ver cómo va este archivo</a></li>`)
    }
    html += `<h2>${escapeHtml(a.label)}</h2><ul class="tarjetas">${lis.join('')}</ul>`
  }
  return { html, vivo }
}

/** Los bloques de la ficha (§4.2 «Ficha»), cada uno solo si su dato existe. */
async function fichaHtml(c: CargarContexto, slot: IntakeSlot, cargas: IntakeUploadEvent[]): Promise<string> {
  const f = slot.ficha ?? {}
  const t = (x: string): string => escapeHtml(x)
  const nombre = `${t(nombreEsperado(slot))}${f.ejemplo ? ` Por ejemplo: <code>${t(f.ejemplo)}</code>` : ''}`
  let yaEstaba: string | null = null
  if (f.regimen === 'acumula' && f.clave) yaEstaba = t(`Cada archivo carga ${f.clave}. Si subes otro de ${f.clave} que ya está cargada, reemplaza lo de ${f.clave}; lo demás no se toca.`)
  else if (f.regimen === 'reemplaza') {
    const vigente = cargas.find((h) => h.ok && h.desenlace === 'procesada')
    yaEstaba = t('Este archivo reemplaza la lista completa que está cargada. Tiene que venir completo: si le falta algo que ya se usa, no se carga nada y la lista queda como estaba.') +
      (vigente ? ` Vigente: «${t(vigente.filename)}», cargado el ${fecha(vigente.desenlaceRunStartedAt ?? vigente.desenlaceAt ?? vigente.ts)}.` : '')
  } else if (f.regimen === 'version') yaEstaba = t('Cada archivo es una versión completa. Al subirlo, indica qué versión es.')
  let antes: string | null = null
  if (f.requiere?.length) {
    const items: string[] = []
    for (const r of f.requiere) {
      const otro = (c.deps.intakeSlots ?? []).find((s) => s.id === r.slot)
      if (!otro) continue
      const puede = c.tipos.some((s) => s.id === otro.id)
      const estado = puede ? estadoDeTarjeta(c.deps, otro, await cargasDe(c.deps, otro), await proyeccionDe(c.deps, otro), Date.now()) : ''
      items.push(`<li>${t(otro.label)}: ${t(r.motivo)}${estado ? `<div class="sub">${estado}</div>` : ''}${puede ? ` <a href="${escapeHtml(hrefTipo(otro))}">Ver este archivo</a>` : ''}</li>`)
    }
    if (items.length) antes = `<ul style="margin:0;padding-left:18px">${items.join('')}</ul>`
  }
  const bloques = ficha([
    { pregunta: '¿Qué archivo es?', html: slot.description ? t(slot.description) : null },
    { pregunta: '¿De dónde se saca?', html: f.origen ? t(f.origen) : null },
    { pregunta: '¿Cómo tiene que llamarse?', html: nombre },
    { pregunta: '¿Qué pasa con lo que ya estaba?', html: yaEstaba },
    { pregunta: '¿Qué tiene que venir junto?', html: f.juego ? t(f.juego) : null },
    { pregunta: '¿Hay que subir algo antes?', html: antes },
  ])
  // Tipos que comparten el proceso: un archivo en espera se reintenta cuando se sube cualquiera de ellos.
  const hermanos = slot.trigger ? (c.deps.intakeSlots ?? []).filter((s) => s.id !== slot.id && s.trigger?.processRef === slot.trigger!.processRef) : []
  const comparte = hermanos.length ? `<p class="sub">Si un archivo de este tipo queda en espera, se vuelve a intentar solo cada vez que se sube cualquiera de estos archivos: ${hermanos.map((s) => `«${t(s.label)}»`).join(', ')}.</p>` : ''
  return bloques + comparte
}

/** «Problemas frecuentes y cómo resolverlos» (§4.2): las guías que aplican a este tipo, ordenadas por
 *  cuántas veces ocurrieron en 90 días cuando se sabe. Sin guías, la frase del vacío. */
async function problemasHtml(c: CargarContexto, slot: IntakeSlot): Promise<string> {
  const titulo = '<h2 id="problemas">Problemas frecuentes y cómo resolverlos</h2>'
  const catalogo = c.deps.intakeGuias
  const vacio = `${titulo}<p class="sub">Todavía no hay problemas frecuentes registrados para este archivo.</p>`
  if (!catalogo) return vacio
  const conteos: DesenlaceCodigoConteo[] = c.deps.cargas?.codigos ? await c.deps.cargas.codigos(slot, new Date(Date.now() - 90 * 86_400_000).toISOString()).catch(() => []) : []
  const porClave = new Map<string, { g: GuiaResuelta; n: number; orden: number }>()
  let orden = 0
  const sumar = (codigo: string, n: number): void => {
    const g = resolverGuia(slot, codigo, undefined, catalogo, undefined, '…')
    if (!g) return
    const prev = porClave.get(g.clave)
    if (prev) prev.n += n
    else porClave.set(g.clave, { g, n, orden: orden++ })
  }
  for (const cod of guiasDelSlot(slot, catalogo)) sumar(cod, 0)
  for (const x of conteos) if (x.codigo) sumar(x.codigo, x.n)
  const items = [...porClave.values()].sort((a, b) => b.n - a.n || a.orden - b.orden)
  if (!items.length) return vacio
  return `${titulo}${items.map(({ g }) => `<div class="fila">${bloqueGuia(g)}</div>`).join('')}`
}

/** `/cargar/<tipo>`: la ficha, la zona de subida, las cargas con estado vivo y los problemas frecuentes. */
async function paginaTipo(c: CargarContexto, slot: IntakeSlot, params: URLSearchParams): Promise<string> {
  const cargas = await cargasDe(c.deps, slot)
  const proy = await proyeccionDe(c.deps, slot)
  const ficha = await fichaHtml(c, slot, cargas)
  const derivados = (slot.meta ?? []).filter((f) => f.fromFilename)
  const notaDerivada = derivados.map((f) => `<p class="sub">«${escapeHtml(f.label)}» se toma del nombre del archivo: ${f.fromFilename!.patterns.map((p) => `«${escapeHtml(p)}»`).join(' o ')}${f.fromFilename!.catalog ? ` (códigos: ${Object.keys(f.fromFilename!.catalog).map((k) => escapeHtml(k)).join(', ')})` : ''}.</p>`).join('')
  const campos = camposDe(slot, true) + c.tipos.filter((s) => s.id !== slot.id).map((s) => camposDe(s, false)).join('')
  const zona = zonaSubida({ action: hrefTipo(slot), token: c.token, maxMb: Math.round(slotMaxBytes(slot) / (1024 * 1024)), id: 'zona-tipo', camposHtml: notaDerivada + campos })
    .replace('<form ', `<form data-pagina="${escapeHtml(slot.id)}" `)
  const vivo = hayNoFinales(cargas)
  const lista = listaDeCargas(c.deps, slot, c.tipos, cargas, proy, Date.now())
  const problemas = await problemasHtml(c, slot)
  const tecnica = slot.domain ? `<p class="sub" style="margin-top:32px">Para quien opera: <a href="${escapeHtml(cargasHref(slot.domain, slot.id).replace('?slot=', '?tipo='))}">vista técnica de este archivo</a>.</p>` : ''
  return pagina(c, slot.id, slot.label, `<p class="sub"><a href="/cargar">← Cargar archivos</a></p>${flash(params)}${ficha}
${zona}<script>${REVISION_JS}</script>
<h2>Cargas de este archivo</h2>
<div id="cargas" data-fuente="${escapeHtml(hrefTipo(slot))}/cargas" data-vivo="${vivo ? '1' : '0'}">${lista}</div><script>${VIVO_JS}</script>
${problemas}${tecnica}`)
}

/** Confirmación de «Retirar» (§4.2). */
function paginaRetirar(c: CargarContexto, slot: IntakeSlot, h: IntakeUploadEvent): string {
  return pagina(c, slot.id, slot.label, `<p class="sub"><a href="${escapeHtml(hrefTipo(slot))}">← ${escapeHtml(slot.label)}</a></p>
<form method="post" action="${escapeHtml(hrefTipo(slot))}/retirar" class="grid"><input type="hidden" name="_csrf" value="${escapeHtml(c.token)}"><input type="hidden" name="carga" value="${escapeHtml(String(h.id))}">
<p>¿Retirar «${escapeHtml(h.filename)}»? No se va a cargar. Si después lo necesitas, súbelo de nuevo.</p>
<div class="actions"><button class="add" type="submit">Retirar</button><a class="cancel" href="${escapeHtml(hrefTipo(slot))}">Cancelar</a></div></form>`)
}

// ─── El despacho ────────────────────────────────────────────────────────────────────────────────

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Lo que la revisión dice de UN archivo (el mismo juicio que la puerta aplicará al subir). */
async function revisarUno(c: CargarContexto, pagina: IntakeSlot | undefined, a: { nombre: string; bytes: number; sha?: string }): Promise<Record<string, unknown>> {
  const nombre = nombreCanonico(a.nombre).trim()
  const d = decidirDestino(c.tipos, nombre, pagina)
  if (d.kind === 'ninguno') return { nombre, clase: 'ninguno', texto: await textoNinguno(c.deps, c.tipos, nombre) }
  if (d.kind === 'elegir') return { nombre, clase: 'elegir', texto: `«${nombre}» corresponde a más de un tipo de archivo: elige a cuál va.`, candidatos: d.candidatos.map((s) => ({ id: s.id, label: s.label })) }
  const slot = d.slot
  const out: Record<string, unknown> = { nombre, clase: d.kind, tipo: slot.id, texto: d.kind === 'aqui' ? `✓ «${nombre}» · ${kb(a.bytes)}` : `✓ «${nombre}» va a «${slot.label}».` }
  const v = validateUpload(slot, nombre, a.bytes)
  if (!v.ok) return { ...out, clase: 'ninguno', texto: `«${nombre}»: ${motivoDeRechazo(v.error)}` }
  // Datos que salen del nombre (Facturas: la empresa): se muestran; si el nombre no los declara, no sube.
  const deriv: string[] = []
  for (const f of slot.meta ?? []) {
    if (!f.fromFilename) continue
    const m = validateMeta({ ...slot, meta: [f] }, {}, nombre)
    if (!m.ok) return { ...out, clase: 'ninguno', texto: `«${nombre}»: ${m.error}` }
    const token = tokenFromFilename(f.fromFilename, nombre)
    const valor = m.values[f.id]
    deriv.push(`${f.label}: ${token}${valor && valor !== token ? ` (${valor})` : ''}`)
  }
  if (deriv.length) out['derivado'] = deriv.join(' · ')
  if (a.sha && /^[0-9a-f]{64}$/.test(a.sha) && c.deps.intakeUploads) {
    const prev = await ultimaConContenido(c.deps.intakeUploads, slot.id, a.sha)
    if (prev) out['dup'] = avisoDeDuplicado(prev, await insumosDeDuplicado(c.deps, slot), Date.now())
  }
  return out
}

/**
 * Atiende `/cargar*`. Devuelve true si la ruta era suya (ya respondió). La autorización (qué tipos
 * puede subir la identidad) ya viene resuelta en `c.tipos`.
 */
export async function atenderCargar(c: CargarContexto, req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  const tipoDe = (id: string): IntakeSlot | undefined => c.tipos.find((s) => s.id === id)
  const noEncontrado = (): true => {
    send(res, 404, pagina(c, '', 'No encontrado', '<p class="msg err">Ese archivo no existe o no lo puedes subir.</p><p><a href="/cargar">← Cargar archivos</a></p>'))
    return true
  }
  const volverA = (dest: string, msg: string, t: 'ok' | 'error'): void => redirect(res, `${dest}?msg=${encodeURIComponent(msg)}&t=${t}`)
  const m = path.match(/^\/cargar(?:\/([a-z][a-z0-9_]*)(?:\/(cargas|retirar))?)?$/)
  if (!m) return noEncontrado()
  const [, id, sub] = m
  const method = req.method ?? 'GET'

  // ── Revisión antes de subir (JSON) ──
  if (id === 'revisar' && !sub && method === 'POST') {
    const f = await readForm(req)
    requireCsrf(f, c.token)
    let archivos: { nombre: string; bytes: number; sha?: string }[] = []
    try {
      const raw = JSON.parse(f['archivos'] ?? '[]') as unknown
      if (Array.isArray(raw)) archivos = raw.slice(0, 50).map((x) => { const o = (x ?? {}) as Record<string, unknown>; return { nombre: String(o['nombre'] ?? ''), bytes: Number(o['bytes'] ?? 0), sha: String(o['sha'] ?? '') } })
    } catch { /* un cuerpo ilegible se responde vacío: la subida sigue siendo posible y el servidor decide */ }
    const pag = f['pagina'] ? tipoDe(f['pagina']) : undefined
    const out: Record<string, unknown>[] = []
    for (const a of archivos) out.push(await revisarUno(c, pag, a))
    json(res, 200, { archivos: out })
    return true
  }
  // ── Fragmento de las tarjetas (estado vivo de /cargar) ──
  if (id === 'tarjetas' && !sub && method === 'GET') {
    const t = await tarjetasHtml(c)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-hay-no-finales': t.vivo ? '1' : '0' })
    res.end(t.html)
    return true
  }
  // ── /cargar ──
  if (!id) {
    if (method === 'GET') {
      send(res, 200, await paginaGeneral(c, url.searchParams))
      return true
    }
    if (method === 'POST') return subir(c, req, res, undefined, volverA)
    return noEncontrado()
  }
  const slot = tipoDe(id)
  if (!slot) return noEncontrado()
  if (!sub) {
    if (method === 'GET') {
      send(res, 200, await paginaTipo(c, slot, url.searchParams))
      return true
    }
    if (method === 'POST') return subir(c, req, res, slot, volverA)
    return noEncontrado()
  }
  if (sub === 'cargas' && method === 'GET') {
    const cargas = await cargasDe(c.deps, slot)
    const html = listaDeCargas(c.deps, slot, c.tipos, cargas, await proyeccionDe(c.deps, slot), Date.now())
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-hay-no-finales': hayNoFinales(cargas) ? '1' : '0' })
    res.end(html)
    return true
  }
  if (sub === 'retirar') {
    const cargaId = method === 'GET' ? Number(url.searchParams.get('carga')) : NaN
    if (method === 'GET') {
      const h = (await cargasDe(c.deps, slot)).find((x) => x.id === cargaId)
      if (!h || !h.ok || !c.deps.cargas) return noEncontrado()
      send(res, 200, paginaRetirar(c, slot, h))
      return true
    }
    if (method === 'POST') {
      const f = await readForm(req)
      requireCsrf(f, c.token)
      const idc = Number(f['carga'])
      const h = (await cargasDe(c.deps, slot)).find((x) => x.id === idc)
      if (!h || !h.ok || !c.deps.cargas || h.desenlaceFinal === true) {
        volverA(hrefTipo(slot), 'Ese archivo ya no se puede retirar.', 'error')
        return true
      }
      try {
        await c.deps.cargas.retire(slot, h.filename, c.email)
      } catch {
        volverA(hrefTipo(slot), `No se pudo retirar «${h.filename}». Vuelve a intentarlo en unos minutos.`, 'error')
        return true
      }
      c.deps.audit({ type: 'intake-retire', slot: slot.id, domain: slot.domain ?? '', filename: h.filename, by: c.email, uploadId: h.id })
      c.deps.acelerarCarga?.(slot.id)
      volverA(hrefTipo(slot), `Retiraste «${h.filename}»; no se va a cargar.`, 'ok')
      return true
    }
  }
  return noEncontrado()
}

/** POST de subida, desde `/cargar` (sin tipo) o desde la página de un tipo. */
export async function subir(c: CargarContexto, req: IncomingMessage, res: ServerResponse, pagina: IntakeSlot | undefined, volverA: (dest: string, msg: string, t: 'ok' | 'error') => void): Promise<true> {
  const origen = pagina ? hrefTipo(pagina) : '/cargar'
  if (!c.deps.intake) {
    volverA(origen, 'La carga de archivos no está habilitada.', 'error')
    return true
  }
  const { fields, files } = await readMultipart(req, 60 * 1024 * 1024)
  requireCsrf(fields, c.token)
  const archivos = files.filter((f) => f.field === 'file' && f.filename).map((f) => ({ filename: nombreCanonico(f.filename), bytes: f.bytes }))
  if (!archivos.length) {
    volverA(origen, 'No se adjuntó ningún archivo.', 'error')
    return true
  }
  const lote: Entrante[] = []
  for (const [i, a] of archivos.entries()) {
    const elegido = fields[`destino_${i}`] ? c.tipos.find((s) => s.id === fields[`destino_${i}`]) : undefined
    const d = decidirDestino(c.tipos, a.filename, pagina, elegido)
    if (d.kind === 'ninguno' || d.kind === 'elegir') {
      const error = d.kind === 'ninguno' ? await textoNinguno(c.deps, c.tipos, a.filename) : `Elige a qué tipo de archivo va «${a.filename}»: su nombre corresponde a más de uno (${d.candidatos.map((s) => `«${s.label}»`).join(', ')}). También puedes subirlo desde la página de ese tipo de archivo.`
      // Un rechazo sin tipo no tiene dónde quedar en el registro (es por tipo): queda en la auditoría.
      if (pagina && d.kind === 'ninguno' && c.deps.intakeUploads) {
        await c.deps.intakeUploads.recordUpload({ slotId: pagina.id, filename: a.filename, sha256: createHash('sha256').update(a.bytes).digest('hex'), bytes: a.bytes.length, uploadedBy: c.email, uploadedAt: new Date().toISOString(), ok: false, error, triggered: false, origen: 'upload' }).catch(() => undefined)
      }
      c.deps.audit({ type: 'intake', slot: pagina?.id ?? '', domain: pagina?.domain ?? '', filename: a.filename, bytes: a.bytes.length, by: c.email, ok: false, error })
      volverA(origen, error, 'error')
      return true
    }
    lote.push({ ...a, slot: d.slot })
  }
  const r = await recibir(c.deps, c.tipos, lote, fields, c.email)
  if (!r.ok) {
    const otros = r.slot ? slotsQueCalzan(c.tipos, r.filename).filter((x) => x.id !== r.slot!.id) : []
    const texto = r.reason === 'accept' && /no coincide con el patrón esperado/.test(r.error) ? motivoDeRechazo(r.error, { otroTipo: otros.length === 1 ? otros[0]!.label : null }) : r.error
    volverA(origen, `«${r.filename}»: ${texto}`, 'error')
    return true
  }
  const tocados = [...new Set(lote.map((u) => u.slot))]
  volverA(tocados.length === 1 ? hrefTipo(tocados[0]!) : '/cargar', mensajeTrasSubir(r), 'ok')
  return true
}
