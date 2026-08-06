import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  deriveRevertPlan, executeRevertPlan, revertManifestName, parseIntakeConfig,
  type ClaveAccion, type IntakeSlot, type IntakeUploadRow, type IntakeUploadStore, type OneLakeEntry,
  type OneLakeIntake, type OneLakeReader, type FabricJobs,
} from '@vergis/capabilities'

// ─── Arnés: OneLake en memoria (mapa ruta → bytes + mtime) ──────────────────
interface Archivo { bytes: Uint8Array; mtime: string }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const shaOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

class FakeLake {
  readonly files = new Map<string, Archivo>()
  put(path: string, contenido: string, mtime: string): void {
    this.files.set(path, { bytes: enc(contenido), mtime })
  }
  get reader(): OneLakeReader {
    return {
      read: async (_t, p) => { const f = this.files.get(p); return f ? new TextDecoder().decode(f.bytes) : null },
      readBytes: async (_t, p) => this.files.get(p)?.bytes ?? null,
      list: async (_t, dir, o = {}): Promise<OneLakeEntry[]> => {
        const prefix = `${dir.replace(/\/+$/, '')}/`
        return [...this.files.entries()]
          .filter(([p]) => p.startsWith(prefix) && (o.recursive === true || !p.slice(prefix.length).includes('/')))
          .map(([p, f]) => ({ path: p, isDirectory: false, size: f.bytes.byteLength, lastModified: f.mtime }))
      },
      copy: async (_t, from, to) => {
        const f = this.files.get(from)
        if (!f) throw new Error(`copy: origen inexistente '${from}'`)
        this.files.set(to, { bytes: f.bytes, mtime: new Date().toISOString() })
      },
      remove: async (_t, p) => { this.files.delete(p) },
    }
  }
  /** Write-path del landing: solo el manifiesto de reversión pasa por acá. */
  get intake(): OneLakeIntake {
    return { put: async (t, filename, bytes) => { this.files.set(`${t.path}/${filename}`, { bytes, mtime: new Date().toISOString() }) } }
  }
  paths(): string[] { return [...this.files.keys()].sort() }
}

const uploadsCon = (rows: IntakeUploadRow[]): IntakeUploadStore => ({
  recordUpload: async () => 0,
  findUploadBySha: async (slotId, sha) => rows.find((r) => r.slotId === slotId && r.sha256 === sha) ?? null,
  listUploads: async (slotId) => rows.filter((r) => r.slotId === slotId),
  intakeBackfillDone: async () => true,
  markIntakeBackfillDone: async () => {},
})

const LANDING = 'Files/intake/saldos'
const PROC = 'Files/intake/_processed'
const CARGA = 'contenido-de-la-carga-W28'
const SHA = shaOf(enc(CARGA))

const slotCon = (extra: Record<string, unknown> = {}): IntakeSlot =>
  parseIntakeConfig({
    slots: [{
      id: 'saldos', label: 'Saldos', domain: 'cartera',
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: LANDING },
      trigger: { processRef: 'PIPE' },
      ...extra,
    }],
  })[0]

const UPLOAD: IntakeUploadRow = {
  id: 7, slotId: 'saldos', filename: 'saldos.xlsx', sha256: SHA, bytes: CARGA.length,
  uploadedBy: 'steward@gh.cl', uploadedAt: '2026-07-13T16:17:42Z', ok: true, triggered: true, origen: 'upload',
}

/** Fixture base: W28 con versión previa + W29 pisada por otro contenido del mismo nombre + landing. */
function fixture(): FakeLake {
  const lake = new FakeLake()
  lake.put(`${PROC}/W28/v1.xlsx`, 'la-version-anterior-de-W28', '2026-07-01T10:00:00Z')
  lake.put(`${PROC}/W28/saldos.xlsx`, CARGA, '2026-07-13T16:19:00Z')
  lake.put(`${PROC}/W29/saldos.xlsx`, 'otro-contenido-que-piso-W29', '2026-07-20T09:00:00Z')
  lake.put(`${LANDING}/saldos.xlsx`, CARGA, '2026-07-13T16:17:42Z')
  lake.put(`${LANDING}/saldos.xlsx.meta.json`, '{"slot":"saldos"}', '2026-07-13T16:17:41Z')
  return lake
}
const depsDe = (lake: FakeLake, jobs?: FabricJobs) => ({ reader: lake.reader, intake: lake.intake, uploads: uploadsCon([UPLOAD]), ...(jobs ? { jobs } : {}) })
const de = (claves: ClaveAccion[], clave: string): ClaveAccion => claves.find((c) => c.clave === clave)!

describe('intake-revert · derivación del plan (#63)', () => {
  it('(a) por uploadId: la clave con versión previa se re-materializa, la pisada no se toca, el landing entra', async () => {
    const lake = fixture()
    const plan = await deriveRevertPlan(depsDe(lake), slotCon(), { uploadId: 7 })
    expect(plan).toMatchObject({ slotId: 'saldos', uploadId: 7, filename: 'saldos.xlsx', sha256: SHA, ejecutable: true })
    expect(plan.claves).toHaveLength(2)
    expect(de(plan.claves, 'W28')).toEqual({ clave: 'W28', accion: 'rematerializar', revertido: `${PROC}/W28/saldos.xlsx`, previa: `${PROC}/W28/v1.xlsx` })
    expect(de(plan.claves, 'W29')).toMatchObject({ accion: 'pisada', vigente: `${PROC}/W29/saldos.xlsx`, vigenteAt: '2026-07-20T09:00:00Z' })
    expect(plan.landing).toEqual([`${LANDING}/saldos.xlsx`]) // el sidecar no es archivo de datos
    expect(plan.hash).toHaveLength(64)
  })

  it('(g) el plan por archivedPath (Procesados) resuelve la misma clave y ancla el uploadId por sha', async () => {
    const lake = fixture()
    const plan = await deriveRevertPlan(depsDe(lake), slotCon(), { archivedPath: `${PROC}/W28/saldos.xlsx` })
    expect(plan.uploadId).toBe(7)
    expect(de(plan.claves, 'W28').accion).toBe('rematerializar')
    // La identidad es el sha: el mismo estado del slot da el mismo plan por cualquiera de los dos anclajes.
    expect(plan.hash).toBe((await deriveRevertPlan(depsDe(lake), slotCon(), { uploadId: 7 })).hash)
  })

  it('la copia de la carga que NO es la vigente de su clave se reporta pisada, con la vigente como evidencia', async () => {
    const lake = fixture()
    lake.files.delete(`${PROC}/W29/saldos.xlsx`)
    lake.put(`${PROC}/W28/posterior.xlsx`, 'la-carga-que-vino-despues', '2026-07-25T08:00:00Z')
    const plan = await deriveRevertPlan(depsDe(lake), slotCon(), { uploadId: 7 })
    expect(de(plan.claves, 'W28')).toMatchObject({ accion: 'pisada', vigente: `${PROC}/W28/posterior.xlsx` })
  })

  it('(h) archivado bajo _processed/ sin directorio de clave → sin-clave, sin efecto', async () => {
    const lake = new FakeLake()
    lake.put(`${PROC}/saldos.xlsx`, CARGA, '2026-07-13T16:19:00Z')
    const plan = await deriveRevertPlan(depsDe(lake), slotCon(), { uploadId: 7 })
    expect(plan.claves).toEqual([{ clave: '', accion: 'sin-clave', revertido: `${PROC}/saldos.xlsx` }])
    expect(plan.ejecutable).toBe(false)
  })

  it('(d) clave introducida SIN revert_delete declarado → no-compensable (fail-closed)', async () => {
    const lake = new FakeLake()
    lake.put(`${PROC}/W28/saldos.xlsx`, CARGA, '2026-07-13T16:19:00Z')
    const plan = await deriveRevertPlan(depsDe(lake), slotCon(), { uploadId: 7 })
    expect(plan.claves).toEqual([{ clave: 'W28', accion: 'no-compensable', revertido: `${PROC}/W28/saldos.xlsx` }])
    expect(plan.ejecutable).toBe(false)
  })
})

describe('intake-revert · ejecución del plan (#63)', () => {
  it('(b) re-materializa: la previa vuelve al landing ANTES del remove, la carga va a _retirado/, un solo run', async () => {
    const lake = fixture()
    lake.put(`${PROC}/W28/v1.xlsx.meta.json`, '{"slot":"saldos"}', '2026-07-01T09:59:00Z')
    const orden: string[] = []
    const reader = lake.reader
    const espiado: OneLakeReader = {
      ...reader,
      copy: async (t, from, to) => { orden.push(`copy ${to}`); return reader.copy(t, from, to) },
      remove: async (t, p) => { orden.push(`remove ${p}`); return reader.remove(t, p) },
    }
    const runNow = vi.fn(async () => {})
    const slot = slotCon()
    const deps = { reader: espiado, intake: lake.intake, uploads: uploadsCon([UPLOAD]), jobs: { runNow } as FabricJobs }
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    const out = await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({ landingRetirado: true, convirtiendo: true })
    expect(runNow).toHaveBeenCalledTimes(1)
    // La versión previa (con su sidecar) está en el landing ANTES de que la copia de la carga salga.
    expect(lake.files.has(`${LANDING}/v1.xlsx`)).toBe(true)
    expect(lake.files.has(`${LANDING}/v1.xlsx.meta.json`)).toBe(true)
    expect(orden.indexOf(`copy ${LANDING}/v1.xlsx`)).toBeLessThan(orden.indexOf(`remove ${PROC}/W28/saldos.xlsx`))
    expect(lake.files.has(`${PROC}/W28/saldos.xlsx`)).toBe(false)
    expect(lake.paths().some((p) => /_retirado\/\d+-revertido-saldos\.xlsx$/.test(p))).toBe(true)
    // La clave pisada queda INTACTA, y la copia del landing se retiró con su sidecar.
    expect(lake.files.has(`${PROC}/W29/saldos.xlsx`)).toBe(true)
    expect(lake.files.has(`${LANDING}/saldos.xlsx`)).toBe(false)
    expect(lake.files.has(`${LANDING}/saldos.xlsx.meta.json`)).toBe(false)
  })

  it('(i) el sidecar ausente en _processed/ no aborta la re-materialización', async () => {
    const lake = fixture() // v1.xlsx no tiene sidecar archivado
    const slot = slotCon()
    const deps = depsDe(lake, { runNow: async () => {} })
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    const out = await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')
    expect(out.ok).toBe(true)
    expect(lake.files.has(`${LANDING}/v1.xlsx`)).toBe(true)
    expect(lake.files.has(`${LANDING}/v1.xlsx.meta.json`)).toBe(false)
  })

  it('(c) clave introducida con revert_delete → manifiesto en el landing, archivo a _retirado/, conversión', async () => {
    const lake = new FakeLake()
    lake.put(`${PROC}/W28/saldos.xlsx`, CARGA, '2026-07-13T16:19:00Z')
    const slot = slotCon({ revert_delete: true })
    expect(slot.revertDelete).toBe(true)
    const runNow = vi.fn(async () => {})
    const deps = depsDe(lake, { runNow })
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    expect(plan.claves).toEqual([{ clave: 'W28', accion: 'vaciar', revertido: `${PROC}/W28/saldos.xlsx` }])
    expect(plan.ejecutable).toBe(true)
    const out = await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')
    expect(out.ok).toBe(true)
    const manifiesto = lake.files.get(`${LANDING}/${revertManifestName('W28')}`)
    expect(manifiesto).toBeDefined()
    const json = JSON.parse(new TextDecoder().decode(manifiesto!.bytes)) as { revert: { clave: string }; slot: string; by: string; filename: string }
    expect(json).toMatchObject({ revert: { clave: 'W28' }, slot: 'saldos', filename: 'saldos.xlsx', by: 'steward@gh.cl' })
    expect(lake.files.has(`${PROC}/W28/saldos.xlsx`)).toBe(false)
    expect(runNow).toHaveBeenCalledTimes(1)
  })

  it('(d) sin revert_delete: NADA se mueve y no se escribe manifiesto alguno', async () => {
    const lake = new FakeLake()
    lake.put(`${PROC}/W28/saldos.xlsx`, CARGA, '2026-07-13T16:19:00Z')
    const antes = lake.paths()
    const runNow = vi.fn(async () => {})
    const slot = slotCon()
    const deps = depsDe(lake, { runNow })
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    const out = await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.convirtiendo).toBe(false)
    expect(lake.paths()).toEqual(antes)
    expect(runNow).not.toHaveBeenCalled()
  })

  it('(e) hash mismatch: el estado del slot cambió ⇒ no ejecuta y devuelve el plan fresco', async () => {
    const lake = fixture()
    const slot = slotCon()
    const deps = depsDe(lake, { runNow: async () => {} })
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    // Alguien subió una carga posterior a W28 entre la confirmación y la ejecución.
    lake.put(`${PROC}/W28/posterior.xlsx`, 'lo-que-llego-despues', '2026-07-30T12:00:00Z')
    const antes = lake.paths()
    const out = await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.plan.hash).not.toBe(plan.hash)
    expect(de(out.plan.claves, 'W28').accion).toBe('pisada')
    expect(lake.paths()).toEqual(antes)
  })

  it('(f) re-entrada: tras ejecutar, el plan re-derivado ya no tiene acciones con efecto', async () => {
    const lake = fixture()
    const slot = slotCon()
    const deps = depsDe(lake, { runNow: async () => {} })
    const plan = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    expect((await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')).ok).toBe(true)
    const otra = await deriveRevertPlan(deps, slot, { uploadId: 7 })
    expect(otra.ejecutable).toBe(false)
    expect(otra.landing).toEqual([])
    // Re-postear el hash viejo no ejecuta nada: mismatch → plan fresco.
    expect((await executeRevertPlan(deps, slot, plan.hash, { uploadId: 7 }, 'steward@gh.cl')).ok).toBe(false)
  })

  it('una carga sin sha registrado no es reversible por carga (fail-closed)', async () => {
    const lake = fixture()
    const sinSha = { ...UPLOAD, sha256: '' }
    const deps = { reader: lake.reader, intake: lake.intake, uploads: uploadsCon([sinSha]) }
    await expect(deriveRevertPlan(deps, slotCon(), { uploadId: 7 })).rejects.toThrow(/no tiene sha256/)
    await expect(deriveRevertPlan(deps, slotCon(), { uploadId: 99 })).rejects.toThrow(/no está en el registro/)
  })
})
