/**
 * V10 — «el fencing delata al doble escritor» (`work/210` §10).
 *
 * QUÉ MIDE. Re-corre el experimento **H-1** del dossier (`work/209` §2) con la mecánica real del
 * Producto —dos handles del store de gobierno sobre EL MISMO archivo, escritura alternada— contra el
 * build de hoy:
 *
 *   semilla:                [A]
 *   handle-1 agrega N1:     [A, N1]     (persiste)
 *   handle-2 agrega N2:     [A, N2]     (persiste sobre el archivo entero)
 *   handle-1 agrega N3:     ¿?          ← el volcado que en H-1 se comió a N2 EN SILENCIO
 *
 * CRITERIO. Con fencing (el default de la caja) el tercer volcado tiene que **fallar RUIDOSO**
 * (`SqliteConcurrentWriteError`) y el archivo conservar a N2: cero pérdidas silenciosas.
 *
 * CONTROL NEGATIVO, y no es opcional: el MISMO guion con `fencing:false` tiene que **reproducir la
 * pérdida** de H-1. Si el control negativo no pierde nada, el experimento no está midiendo el
 * fencing — está midiendo otra cosa que da verde por su cuenta (Norma 7, corolario del instrumento).
 *
 * Se corre nativo (`npx tsx experimentos/v10-fencing.ts`): el sujeto es el módulo de stores, no el
 * contenedor. Escribe su crudo en `.run/datos/v10/resultado.json`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteGovernanceStore } from '../../../../packages/capabilities/src/governance-store.ts'

const SEMILLA = 'cesar@ratio.cl'
const N1 = 'primero@gh.com'
const N2 = 'nuevo-admin@gh.com'
const N3 = 'otro@gh.com'

interface Brazo {
  brazo: 'fencing-on' | 'fencing-off'
  fencing: boolean
  tercerVolcado: 'lanzó' | 'silencioso'
  errorCode: string | null
  errorMsg: string | null
  enDisco: string[]
  n2Sobrevivio: boolean
  veredicto: string
}

async function brazo(fencing: boolean): Promise<Brazo> {
  const dir = mkdtempSync(join(tmpdir(), `v10-fencing-${fencing ? 'on' : 'off'}-`))
  const file = join(dir, 'governance.sqlite')
  const ctl = { epoch: 0, fencing }

  // Dos handles del MISMO archivo — la mecánica de H-1, sin simulacros: es la clase que el server usa.
  const h1 = await SqliteGovernanceStore.open(file, { admins: [SEMILLA] }, { ...ctl, writer: 'handle-1' })
  await h1.add(N1)
  const h2 = await SqliteGovernanceStore.open(file, { admins: [] }, { ...ctl, writer: 'handle-2' })
  await h2.add(N2)

  let tercerVolcado: Brazo['tercerVolcado'] = 'silencioso'
  let errorCode: string | null = null
  let errorMsg: string | null = null
  try {
    await h1.add(N3) // el volcado que en H-1 borró al otro escritor sin decir una palabra
  } catch (e) {
    tercerVolcado = 'lanzó'
    errorCode = (e as { code?: string }).code ?? (e as Error).name
    errorMsg = (e as Error).message
  }

  // Se relee DESDE DISCO con un handle nuevo: preguntarle a un handle en memoria sería preguntarle al
  // que escribió qué cree que escribió.
  const lector = await SqliteGovernanceStore.open(file, { admins: [] }, { epoch: 0, mode: 'read' })
  const enDisco = (await lector.list()).map((a) => a.email).sort()
  const n2Sobrevivio = enDisco.includes(N2)

  const veredicto = fencing
    ? tercerVolcado === 'lanzó' && n2Sobrevivio
      ? 'PASA — el segundo escritor falla RUIDOSO y nada se pierde en silencio'
      : 'FALLA — con fencing no debería haber pérdida silenciosa'
    : n2Sobrevivio
      ? 'NO REPRODUCE — el control negativo no perdió nada: el experimento NO está midiendo el fencing'
      : 'REPRODUCE — sin fencing, la pérdida de H-1 vuelve a ocurrir (el instrumento sí mide)'

  return { brazo: fencing ? 'fencing-on' : 'fencing-off', fencing, tercerVolcado, errorCode, errorMsg, enDisco, n2Sobrevivio, veredicto }
}

const on = await brazo(true)
const off = await brazo(false)
const salida = {
  experimento: 'V10 · el fencing delata al doble escritor (re-corrida de H-1)',
  cuando: new Date().toISOString(),
  semilla: [SEMILLA],
  escrituras: { 'handle-1': [N1, N3], 'handle-2': [N2] },
  brazos: [on, off],
  veredicto:
    on.veredicto.startsWith('PASA') && off.veredicto.startsWith('REPRODUCE')
      ? 'V10 PASA · con su control negativo REPRODUCIENDO'
      : 'V10 NO CONCLUYE — mirar los brazos',
}
const dest = new URL('../.run/datos/v10/', import.meta.url).pathname
mkdirSync(dest, { recursive: true })
writeFileSync(join(dest, 'resultado.json'), JSON.stringify(salida, null, 2) + '\n')
console.log(JSON.stringify(salida, null, 2))
