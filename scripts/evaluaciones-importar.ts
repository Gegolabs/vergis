/**
 * IMPORTADOR DE DAFTAR al store `evaluaciones` (doc 013 · H2), por línea de comandos.
 *
 *   npx tsx scripts/evaluaciones-importar.ts \
 *     --guides <dir> --progress <dir> --reports <dir> --db <archivo> [--verificar]
 *
 * Con `--verificar` corre el round-trip contra CADA progreso y sale con código ≠ 0 si alguno difiere.
 *
 * ── Lo que este script NO imprime, nunca ───────────────────────────────────────────────────────
 * Contenido. Los progresos de Daftar los escriben menores de edad: la salida es ids y CONTEOS, y el
 * reporte de una diferencia nombra el id y la ruta del archivo, jamás lo que dice adentro. Quien
 * quiera ver la diferencia abre los dos archivos él mismo, con su propio criterio sobre quién mira.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SqliteEvaluacionesStore,
  importarDaftar,
  verificarRoundTrip,
  estudiantesDe,
  type FilaInforme,
} from '@vergis/capabilities'

interface Args {
  guides: string
  progress: string
  reports: string
  db: string
  verificar: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const faltan: string[] = []
  const req = (n: string): string => {
    const v = get(n)
    if (!v) faltan.push(`--${n}`)
    return v ?? ''
  }
  const a: Args = {
    guides: req('guides'),
    progress: req('progress'),
    reports: req('reports'),
    db: req('db'),
    verificar: argv.includes('--verificar'),
  }
  if (faltan.length) {
    console.error(`faltan argumentos: ${faltan.join(' ')}`)
    console.error('uso: tsx scripts/evaluaciones-importar.ts --guides <dir> --progress <dir> --reports <dir> --db <archivo> [--verificar]')
    process.exit(2)
  }
  return a
}

/** Lee un directorio de JSON como `nombre-sin-extensión → contenido`, más su texto exacto. */
function leerDir(dir: string): { json: Record<string, unknown>; texto: Record<string, string> } {
  const json: Record<string, unknown> = {}
  const texto: Record<string, string> = {}
  if (!existsSync(dir)) {
    console.error(`no existe el directorio '${dir}'`)
    process.exit(2)
  }
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    const t = readFileSync(join(dir, f), 'utf8')
    texto[id] = t
    try {
      json[id] = JSON.parse(t) as unknown
    } catch (e) {
      // Un JSON ilegible se NOMBRA y se salta: seguir en silencio lo convertiría en «no estaba».
      console.error(`  ! ${id}: JSON ilegible (${e instanceof Error ? e.message : String(e)}); se omite`)
    }
  }
  return { json, texto }
}

const ESTADOS = ['importado', 'sin-cambios', 'huerfano', 'conflicto'] as const

function tabla(filas: FilaInforme[]): void {
  const anchoId = Math.max(2, ...filas.map((f) => f.id.length))
  const enc = `${'id'.padEnd(anchoId)}  ${'estado'.padEnd(11)}  ${'secc'.padStart(4)}  ${'resp'.padStart(4)}  ${'rev'.padStart(3)}`
  console.log(enc)
  console.log('─'.repeat(enc.length))
  for (const f of filas) {
    const cola = f.detalle ? `  · ${f.detalle}` : ''
    console.log(
      `${f.id.padEnd(anchoId)}  ${f.estado.padEnd(11)}  ${String(f.secciones).padStart(4)}  ` +
        `${String(f.respuestas).padStart(4)}  ${String(f.revisiones).padStart(3)}${cola}`,
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const guides = leerDir(args.guides)
  const progress = leerDir(args.progress)
  const reports = leerDir(args.reports)

  const store = await SqliteEvaluacionesStore.open(args.db)
  const informe = importarDaftar({
    guides: guides.json,
    progress: progress.json,
    reports: reports.json,
    store,
    now: new Date().toISOString(),
    guideText: guides.texto,
  })

  tabla(informe.filas)
  console.log('')
  console.log(`instrumentos: ${informe.instrumentos.publicados} publicados · ${informe.instrumentos.sinCambios} sin cambios · ${informe.instrumentos.conflictos} conflictos  (leídos: ${Object.keys(guides.json).length})`)
  console.log(`progresos:    ${informe.progresos.importados} importados · ${informe.progresos.sinCambios} sin cambios · ${informe.progresos.huerfanos} huérfanos · ${informe.progresos.conflictos} conflictos  (leídos: ${Object.keys(progress.json).length})`)
  console.log(`reportes:     ${informe.reportes.guardados} guardados · ${informe.reportes.sinCambios} sin cambios  (leídos: ${Object.keys(reports.json).length})`)
  const porEstado = ESTADOS.map((e) => `${e}=${informe.filas.filter((f) => f.estado === e).length}`).join(' · ')
  console.log(`filas por estado: ${porEstado}`)

  let salida = 0
  if (args.verificar) {
    const r = verificarRoundTrip(store, progress.json, estudiantesDe(guides.json))
    console.log('')
    console.log(`round-trip: ${r.verificados} verificados · ${r.diferencias.length} diferencias · ${r.omitidos.length} omitidos (huérfanos)`)
    for (const id of r.diferencias) {
      // Solo id y rutas. El contenido no se imprime: son datos de menores.
      console.error(`  ✗ ${id}: el progreso reconstruido difiere del original`)
      console.error(`     original:      ${join(args.progress, `${id}.json`)}`)
      console.error(`     reconstruido:  desde ${args.db} (exportarProgreso)`)
      salida = 1
    }
    if (r.diferencias.length === 0) console.log('  ✓ cero pérdida: todos los progresos se reconstruyen idénticos')
  }
  if (informe.instrumentos.conflictos > 0 || informe.progresos.conflictos > 0) salida = 1

  await store.close()
  process.exit(salida)
}

void main()
