/**
 * Verificador OFFLINE de las cadenas de auditoría (issue #306 · I9).
 *
 * Por qué existe: los logs longevos del server corren en modo `retain:false` (la memoria no crece sin
 * cota), así que `AppendOnlyLog.verifyChain()` no tiene nada que recorrer — la cadena vive en el
 * ARCHIVO. Hasta acá nadie la verificaba, ni la de la consola ni la del admin: la propiedad estaba
 * escrita y sin instrumento que la mirara.
 *
 * Uso:
 *   npx tsx scripts/verify-audit-chain.ts [<archivo> …]
 *   (sin argumentos: `$VERGIS_OUT/consola-audit.log` y `$VERGIS_OUT/admin-audit.log`)
 *
 * Salida: una línea por archivo y código 1 si alguna cadena está rota. Un archivo AUSENTE no es un
 * fallo —un nodo que nunca ejecutó nada no tiene log— y se dice; un archivo ilegible SÍ lo es, y se
 * distingue del anterior: «no pude leer» jamás se colapsa con «leí y está bien».
 */
import { readFileSync, existsSync } from 'node:fs'
import { verifyChainLines } from '../packages/botler/src/log'

const out = (process.env['VERGIS_OUT'] ?? '/governance').replace(/\/$/, '')
const archivos = process.argv.slice(2).length ? process.argv.slice(2) : [`${out}/consola-audit.log`, `${out}/admin-audit.log`]

let roto = false
for (const archivo of archivos) {
  if (!existsSync(archivo)) {
    console.log(`— ${archivo}: no existe (nada que verificar)`)
    continue
  }
  let texto: string
  try {
    texto = readFileSync(archivo, 'utf8')
  } catch (e) {
    console.error(`✗ ${archivo}: NO SE PUDO LEER (${e instanceof Error ? e.message : String(e)}) — sin veredicto`)
    roto = true
    continue
  }
  const r = verifyChainLines(texto.split('\n'))
  if (r.ok) console.log(`✓ ${archivo}: cadena intacta (${r.verificadas} entrada(s))`)
  else {
    console.error(`✗ ${archivo}: CADENA ROTA en seq=${r.rotoEn} (tras ${r.verificadas} entrada(s) sanas)`)
    roto = true
  }
}
process.exitCode = roto ? 1 : 0
