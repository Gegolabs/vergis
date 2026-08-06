/**
 * Smoke LOCAL del derivador de metadata desde el nombre del archivo (vergis#95).
 *
 * Recorre los tres caminos del contrato con el parser real, la resolución real y el sidecar real:
 *   1. nombre que calza y token en el catálogo → metadata resuelta sin preguntar;
 *   2. nombre fuera de convención, o token fuera del catálogo → carga rechazada con aviso explícito;
 *   3. `verify_against` declarado → la directiva de contraste viaja en el sidecar (`verify`), que es
 *      lo que el convertidor —único que lee el CONTENIDO— hace cumplir.
 *
 * Sin argumentos corre el escenario sintético. Con `--slots <ruta> --slot <id> <archivo>…` resuelve
 * además nombres reales contra la configuración de una instancia (verificación pre-deploy).
 *
 *   npx tsx scripts/intake-derivador-smoke.ts
 *   npx tsx scripts/intake-derivador-smoke.ts --slots ../instancia/intake/slots.yaml \
 *     --slot facturas_documentos "Listado EasyDoc VH.xlsx" "Factura_VH.xlsx"
 */
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { parseIntakeConfig, validateMeta, buildSidecar, type IntakeSlot } from '@vergis/capabilities'

let fallos = 0
let pasos = 0
const ok = (cond: boolean, msg: string): void => {
  pasos += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    fallos += 1
    console.log(`  ✗ ${msg}`)
  }
}

const resolver = (slot: IntakeSlot, filename: string) => validateMeta(slot, {}, filename)

const FIXTURE = {
  slots: [{
    id: 'documentos',
    label: 'Extractos',
    domain: 'demo',
    accept: '*.xlsx',
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/documentos' },
    trigger: { processRef: 'SJD' },
    meta: [{
      id: 'empresa_rut',
      label: 'Empresa receptora (RUT)',
      type: 'rut',
      required: true,
      from_filename: {
        patterns: ['Listado EasyDoc {codigo}.xlsx', 'Listado SAP {codigo}.xlsx'],
        catalog: { VH: '96835510-4', COVH: '99524070-K' },
        verify_against: 'RUTRECEPTOR',
      },
    }],
  }],
}

console.log('\n── Escenario sintético ───────────────────────────────────────────')
const slot = parseIntakeConfig(FIXTURE)[0]
ok(!!slot.meta?.[0].fromFilename, 'la config declara la convención y el catálogo')

console.log('\n1 · el nombre calza y el código está en el catálogo')
for (const [name, esperado] of [
  ['Listado EasyDoc VH.xlsx', '96835510-4'],
  ['Listado SAP COVH.xlsx', '99524070-K'],
  ['listado sap vh.xlsx', '96835510-4'],
] as const) {
  const r = resolver(slot, name)
  ok(r.ok && r.values['empresa_rut'] === esperado, `«${name}» → ${r.ok ? r.values['empresa_rut'] : (r as { error: string }).error}`)
}

console.log('\n2 · nombre fuera de convención o código fuera de catálogo → falla explícita')
for (const [name, debeDecir] of [
  ['Factura_VH.xlsx', 'Listado EasyDoc {codigo}.xlsx'],
  ['Listado EasyDoc.xlsx', 'Listado SAP {codigo}.xlsx'],
  ['Listado EasyDoc ZZZ.xlsx', 'catálogo'],
] as const) {
  const r = resolver(slot, name)
  const err = r.ok ? '' : r.error
  ok(!r.ok && err.includes(debeDecir), `«${name}» rechazado: ${err || 'NO RECHAZÓ (¡mal!)'}`)
}

console.log('\n3 · la directiva de contraste contra el contenido viaja en el sidecar')
const r = resolver(slot, 'Listado EasyDoc VH.xlsx')
if (!r.ok) {
  ok(false, 'no resolvió el caso feliz; el sidecar no se puede evaluar')
} else {
  const sidecar = JSON.parse(buildSidecar(slot.id, r.values, 'quien@sube', '2026-08-06T00:00:00Z', r.verify))
  console.log(`  ${JSON.stringify(sidecar)}`)
  ok(sidecar.verify?.empresa_rut === 'RUTRECEPTOR', 'el sidecar declara verify.empresa_rut = RUTRECEPTOR')
  ok(sidecar.empresa_rut === '96835510-4', 'el sidecar lleva la empresa derivada del nombre')
  const sinVerify = JSON.parse(buildSidecar('otro', { a: '1' }, 'u', 't'))
  ok(sinVerify.verify === undefined, 'un slot sin verify_against produce el sidecar de siempre (regresión cero)')
}

// ── Configuración real de una instancia (opcional) ───────────────────────────
const argv = process.argv.slice(2)
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const slotsPath = arg('--slots')
if (slotsPath) {
  const slotId = arg('--slot')
  const nombres = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
  console.log(`\n── Configuración real: ${slotsPath} ──────────────────────────────`)
  const slots = parseIntakeConfig(parseYaml(readFileSync(slotsPath, 'utf8')))
  ok(slots.length > 0, `${slots.length} slot(s) parsean sin error`)
  const real = slots.find((s) => s.id === slotId)
  ok(!!real, `el slot '${slotId}' existe`)
  if (real) {
    for (const n of nombres) {
      const rr = resolver(real, n)
      console.log(`  · «${n}» → ${rr.ok ? JSON.stringify(rr.values) + (rr.verify ? ` + verify ${JSON.stringify(rr.verify)}` : '') : 'RECHAZADO: ' + rr.error}`)
    }
  }
}

console.log(`\n${fallos === 0 ? '✓' : '✗'} ${pasos - fallos}/${pasos} verificaciones\n`)
process.exit(fallos === 0 ? 0 : 1)
