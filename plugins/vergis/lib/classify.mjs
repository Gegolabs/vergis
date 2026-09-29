// classify.mjs — clasificar un acto y aplicar su gate (D6, D10).
//
// Lo que recarga en caliente se lee del NODO (`/contrato`), jamás de una tabla de este plugin: las
// reglas copiadas se pudren (la de «restart por tabla gobernada nueva» empujó a reiniciar ocho Lets
// para desplegar uno). Si el contrato no responde o no cubre la ruta, el acto es una interrupción:
// ante la duda, se trata como corte.

import { EXIT, fail } from './util.mjs'

/** Las clases de acto, cerradas (D10). */
export const CLASSES = Object.freeze(['read', 'content', 'version', 'boot', 'service', 'service-interrupting', 'destructive'])
export const GATES = Object.freeze(['free', 'operator', 'window', 'approval'])

/** Clases cuyo acto corta rutas servidas: su medición y su ventana son obligatorias si el gate lo pide. */
export const CUTTING = new Set(['boot', 'service-interrupting', 'destructive'])

/**
 * Invariantes del Producto que ninguna declaración configura: el plugin no los ejecuta aunque un gate
 * lo permita (`botler-ops`, RUNBOOK). Se reconocen en el texto del acto.
 */
// Un verbo que ESCRIBE seguido (en el mismo comando simple) del archivo protegido. Leerlo no se
// prohíbe: `cat rings/ring.args` es diagnóstico.
const MUT = String.raw`(\bsed\s+-i|>>?|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bln\b)[^|;&]*`
const FORBIDDEN = [
  [/\bdown\b[^|;&]*\s(-v|--volumes)\b/, '`docker compose down -v` borra los volúmenes del borde (el certificado, entre otros)'],
  [new RegExp(MUT + String.raw`control\.lease\.json`), 'el lease del plano de control no se toca a mano: el relevo por staleness converge solo, y borrarlo abre la puerta a dos controladores'],
  [new RegExp(MUT + String.raw`control\.handover\.json`), 'el intent de handover lo escribe la herramienta de anillos, no un operador'],
  [new RegExp(MUT + String.raw`ring\.args(?![\w.])`), '`ring.args` no se edita a mano: se deriva del compose vivo (`vergis-ops exec rollout ring-args`)'],
  [new RegExp(MUT + String.raw`active\.caddy(?![\w.])`), '`active.caddy` lo reescribe la herramienta de anillos preservando el inodo; editarlo a mano rompe el flip'],
]

export function forbiddenReason(text) {
  for (const [re, why] of FORBIDDEN) if (re.test(text)) return why
  return null
}

/** Basenames que un `publish` jamás escribe: son estado del rollout, no artefactos. */
export const RINGS_STATE = new Set(['active.caddy', 'ring.args', 'rings.json', 'control.lease.json', 'control.handover.json'])

function under(path, prefix) {
  const p = prefix.replace(/\/+$/, '')
  return path === p || path.startsWith(p + '/')
}

/**
 * Clasifica la publicación de un archivo del host.
 *
 * @param hostPath   ruta absoluta en el host
 * @param contract   el JSON de `/contrato` del anillo activo, o `null` si no respondió
 * @param ringMounts montajes del anillo activo `[{Source, Destination}]`
 * @param others     montajes de los demás contenedores vivos `[{container, service, Source, Destination}]`
 * @param services   `services[]` de la declaración
 */
export function classifyPath({ hostPath, contract, ringMounts, others, services }) {
  const rm = (ringMounts ?? []).find((m) => under(hostPath, m.Source))
  if (rm) {
    const cpath = rm.Destination.replace(/\/+$/, '') + hostPath.slice(rm.Source.replace(/\/+$/, '').length)
    if (!contract) {
      return { cls: 'boot', containerPath: cpath, why: `el anillo activo monta ${rm.Source} en ${rm.Destination}, y /contrato no respondió: sin contrato vivo no hay cómo saber si recarga — ante la duda, se trata como corte` }
    }
    const w = (contract.watches ?? []).find((x) => (x.paths ?? []).some((p) => under(cpath, p)))
    if (w) return { cls: 'content', containerPath: cpath, watch: w, why: `el contrato vivo lo vigila (${(w.envs ?? []).join(', ') || 'watch'} → ${w.reloads})` }
    return { cls: 'boot', containerPath: cpath, why: `el anillo activo lo monta en ${cpath} y ningún watch del contrato vivo lo cubre: el nodo lo lee al arrancar` }
  }
  const om = (others ?? []).find((m) => under(hostPath, m.Source))
  if (om) {
    const svc = (services ?? []).find((s) => s.name === om.service)
    if (!svc) return { cls: 'service-interrupting', service: om.service, why: `lo monta «${om.container}» (servicio «${om.service ?? '?'}»), que la declaración no describe: ante la duda, se trata como corte` }
    return { cls: svc.interrupting ? 'service-interrupting' : 'service', service: svc.name, why: `lo monta el servicio «${svc.name}» (${svc.interrupting ? 'su recarga corta rutas servidas' : 'sin corte'}${svc.reload !== 'none' ? `; recarga en caliente: ${svc.reload.slice(5)}` : ''})` }
  }
  return { cls: 'service', why: 'ningún contenedor vivo lo monta: publicarlo no cambia lo que corre; su efecto llega con el acto de servicio que lo aplique, y ese acto trae su propio gate' }
}

/** El gate de una clase según la declaración. Lo que nadie clasificó sigue pidiendo aprobación. */
export function gateFor(ins, cls) {
  if (!CLASSES.includes(cls)) fail(EXIT.NOT_RUN, `clase de acto desconocida «${cls}» (${CLASSES.join(' · ')})`)
  const g = ins.governance?.gates?.[cls]
  return { cls, gate: g ?? 'approval', declared: g !== undefined }
}

/**
 * Aplica el gate: devuelve la evidencia que el acto registra, o sale con 2 diciendo qué falta.
 * El plugin no puede obligar a que exista la aprobación humana: exige su EVIDENCIA y la registra.
 */
export function enforceGate(ins, cls, { window, impact, approval, measured } = {}) {
  const g = gateFor(ins, cls)
  const src = ins.governance?.source ? ` (norma: ${ins.governance.source})` : ''
  const why = g.declared ? `gate «${g.gate}» declarado para la clase «${cls}»${src}` : `la clase «${cls}» no tiene gate declarado: rige «approval»`
  if (g.gate === 'free' || g.gate === 'operator') return { ...g, why, evidence: null }
  if (g.gate === 'window') {
    const who = ins.governance?.window_approver
    if (!who) fail(EXIT.NOT_RUN, `${why}, y la declaración no nombra governance.window_approver: nadie puede autorizar la ventana. No se ejecuta.`)
    if (!impact) fail(EXIT.NOT_RUN, `${why}. Antes de pedir la ventana se declara el impacto, nombrado por lo que es (qué Lets caen y por cuánto): pasa --impact "<…>".`)
    if (!window) fail(EXIT.NOT_RUN, `${why}. La ventana la autoriza ${who}: pasa --window "<quién · cuándo · sus palabras>". Sin esa evidencia el acto no corre.`)
    if (!measured) fail(EXIT.NOT_RUN, `${why}. Un acto con ventana se MIDE: arranca el poller (\`vergis-ops poller start\`) antes, con su CN-1, y deja la fila en governance.cuts_log aunque diga «sin medir».`)
    return { ...g, why, evidence: { kind: 'window', authority: who, window, impact } }
  }
  const who = ins.governance?.approver
  if (!who) fail(EXIT.NOT_RUN, `${why}, y la declaración no nombra governance.approver: nadie puede aprobarlo. No se ejecuta.`)
  if (!approval) fail(EXIT.NOT_RUN, `${why}. Lo aprueba ${who}: pasa --approval "<quién · cuándo · sus palabras>". Sin esa evidencia el acto no corre.`)
  if (CUTTING.has(cls) && !impact) fail(EXIT.NOT_RUN, `${why}, y el acto corta: declara el impacto antes con --impact "<qué Lets caen y por cuánto>".`)
  return { ...g, why, evidence: { kind: 'approval', authority: who, approval, impact: impact ?? null } }
}
