/**
 * Instrumento del GATE DOCKER de #65: produce el HTML en modo print de un spec de ejemplo, para
 * mandárselo al sidecar WeasyPrint real y mirar el PDF con ojo humano. No es producción ni CI —
 * el CI no tiene docker ni WeasyPrint, y por eso la conversión real es un gate manual diferido.
 *
 * Uso:
 *   npx tsx scripts/pdf-sample.ts examples/charts-lab.yaml /tmp/pi-sample.html
 *   curl -sf -X POST --data-binary @/tmp/pi-sample.html \
 *        -H 'content-type: text/html; charset=utf-8' \
 *        http://127.0.0.1:9090/convert -o /tmp/pi-sample.pdf
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runSpec } from '@vergis/cli'

const [specPath, outPath] = process.argv.slice(2)
if (!specPath || !outPath) {
  console.error('uso: npx tsx scripts/pdf-sample.ts <spec.yaml> <salida.html>')
  process.exit(2)
}

const out = await runSpec({ specPath, baseDir: tmpdir(), print: true })
if (!out.ok || !out.html) {
  console.error(`el render falló: ${out.fallback?.reason ?? 'sin HTML'}`)
  process.exit(1)
}
writeFileSync(outPath, out.html, 'utf8')
console.log(`HTML de print escrito en ${outPath} (${out.html.length} bytes)`)
