// util.mjs — el vocabulario común del CLI `vergis-ops`: códigos de salida, errores con código y
// las pocas utilidades que todos los verbos comparten. Sin dependencias: Node ≥ 22 y nada más.

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * EL VOCABULARIO DE SALIDA, único para todo el plugin (D7), heredado de la sonda de paridad del lab.
 * Distingue «medí y salió negativo» de «no pude medir» (Ley de Wingworking, Norma 7): colapsarlos
 * convierte un transporte roto en un hallazgo del terreno, o un hallazgo en un verde.
 */
export const EXIT = Object.freeze({
  OK: 0, //         medí, sin hallazgo
  FINDING: 1, //    medí, con hallazgo sobre LO MEDIDO: el terreno — o el instrumento, cuando lo medido es él (un
  //                control negativo que sale verde, una calibración con el selector muerto)
  NOT_RUN: 2, //    no corrí: uso, guardia, clave no declarada
  CROSSED: 3, //    respuesta cruzada: llegó el centinela de OTRA corrida
  BUSY: 4, //       transporte ocupado persistente (Conflict, candado)
  MUTE: 5, //       remoto mudo: sin centinela, o salida cortada antes de él
  TRANSPORT: 6, //  el transporte falló por otra razón
  PARTIAL: 7, //    medí a medias: lo no medido se lista, jamás se cuenta como OK
})

export const EXIT_NAME = Object.freeze({
  0: 'MEDÍ',
  1: 'MEDÍ · HALLAZGO',
  2: 'NO CORRÍ',
  3: 'NO PUDE MEDIR · respuesta cruzada',
  4: 'NO PUDE MEDIR · transporte ocupado',
  5: 'NO PUDE MEDIR · remoto mudo',
  6: 'NO PUDE MEDIR · transporte',
  7: 'MEDÍ A MEDIAS',
})

/** Un error que ya sabe con qué código sale el proceso. */
export class OpsExit extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function fail(code, message) {
  throw new OpsExit(code, message)
}

/**
 * Combina los códigos de varias mediciones en uno. Lo que no se pudo medir (3–7) gana sobre el
 * hallazgo (1), porque un resultado parcial jamás se presenta como completo; entre dos «no pude», el
 * primero que ocurrió es el que se reporta.
 */
export function worst(codes) {
  const notMeasured = codes.find((c) => c >= 3)
  if (notMeasured !== undefined) return notMeasured
  if (codes.includes(EXIT.NOT_RUN)) return EXIT.NOT_RUN
  if (codes.includes(EXIT.FINDING)) return EXIT.FINDING
  return EXIT.OK
}

export function nonce() {
  return randomBytes(10).toString('hex')
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Un valor que viaja dentro de un script `sh` entre comillas simples. Lo que no calza, se rechaza. */
export function shq(value) {
  const s = String(value)
  if (s.includes("'")) fail(EXIT.NOT_RUN, `valor con comilla simple, no viaja a un script remoto sin mutilarse: «${s}»`)
  return `'${s}'`
}

/** Un token seguro para nombres de contenedor, versiones y rutas sin espacios. */
export function assertToken(value, what, re = /^[A-Za-z0-9._:/@+=-]+$/) {
  if (typeof value !== 'string' || !re.test(value)) {
    fail(EXIT.NOT_RUN, `${what}: valor inválido «${value}» (solo ${re.source})`)
  }
  return value
}

export const out = (s = '') => process.stdout.write(s + '\n')
export const err = (s = '') => process.stderr.write(s + '\n')

/**
 * Termina el proceso DESPUÉS de vaciar stdout y stderr. `process.exit()` a secas descarta lo que sigue
 * en la cola de escritura del stream: bajo `spawn` el stdout es un socket que se llenó hacia los ~18 KB,
 * y una salida de ~20 KB llegaba cortada por la cola con exit 0 (node:22/Linux, entre 4 y 7 de cada 8
 * corridas). Una escritura vacía al final de cada stream devuelve su callback cuando lo encolado antes
 * ya salió, así que se sale recién cuando volvieron los dos.
 *
 * El costo es deliberado: el CLI espera a su lector en vez de truncar en silencio. Un lector que nunca
 * lee lo deja esperando hasta que cierre el pipe (entonces EPIPE, y sale con el código pedido).
 */
export function salir(code) {
  let pendientes = 2
  const listo = () => {
    if (--pendientes === 0) process.exit(code)
  }
  process.stdout.write('', listo)
  process.stderr.write('', listo)
}

export function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

export function unb64(text) {
  return Buffer.from(text, 'base64').toString('utf8')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
