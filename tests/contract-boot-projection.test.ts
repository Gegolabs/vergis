// EL EXPERIMENTO QUE PONE EN RIESGO EL MECANISMO DEL DELTA (issue #139, N2).
//
// En producción se midió que la proyección persistida de UN MISMO arranque cambia: dos lecturas del
// mismo journal, misma entrada, `boots: 1`, dieron primero `watches: []` / `signals: []` y minutos
// después `4` / `1`, con `projectionSha256` distinto. El mecanismo NO se había medido — se conjeturó
// «escritura diferida» o «re-registro deliberado».
//
// Esta prueba lo mide con el registro y el journal REALES, replicando el orden del arranque de
// `serve-rls.ts`: la observación del boot ocurría ANTES de registrar los watches. La consecuencia no
// es cosmética: `snapshot()` deriva `env.reloadableContent` de los watches registrados
// (`contract.ts`), así que una proyección tomada antes de registrarlos clasifica esas claves como
// `bootOnly` — el contrato afirma «esto exige reiniciar» cuando ya no.
//
// **Ése es exactamente el error de costo asimétrico que #139 existe para matar**: una regla que pide
// más cautela de la necesaria no falla nunca, solo cobra un corte de servicio cada vez.
//
// Estas pruebas fallan contra el orden viejo. Si alguna vez vuelven a fallar, la observación del boot
// se adelantó otra vez a las registraciones.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContractRegistry } from '../server/contract'
import { createContractJournal, projectContract, diffProjections, JOURNAL_SUBDIR, JOURNAL_FILE, type ContractProjection } from '../server/contract-delta'

const work = (): string => mkdtempSync(join(tmpdir(), 'vergis-boot-proj-'))
const leerJournal = (dir: string): { entries: { version: string; boots: number; projectionSha256: string; projection: ContractProjection }[] } =>
  JSON.parse(readFileSync(join(dir, JOURNAL_SUBDIR, JOURNAL_FILE), 'utf8'))

/**
 * El arranque, como lo arma `serve-rls.ts`: se consumen las claves de env (config), se registran los
 * watches y la señal, y en algún punto el journal observa. `observarAntes` es la variable del
 * experimento — el orden viejo (`true`) contra el orden correcto (`false`).
 */
function boot(dir: string, observarAntes: boolean): void {
  const contract = createContractRegistry({
    engine: 'fabric',
    hotReload: true,
    envSource: { VERGIS_POLICIES: '/policies', VERGIS_OUT: dir },
  })
  const journal = createContractJournal({ dir })
  // La config consume la clave al arrancar — eso pasa antes de todo lo demás.
  contract.env('VERGIS_POLICIES')
  if (observarAntes) journal.observe(contract.snapshot())
  // …y solo después el bloque de hot-reload registra qué vigila y qué recarga.
  contract.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }, [], () => {})
  contract.signal({ signal: 'SIGHUP', action: 'recarga todo lo recargable' })
  if (!observarAntes) journal.observe(contract.snapshot())
}

describe('#139 · la proyección persistida del ARRANQUE (experimento del mecanismo)', () => {
  it('observar antes de registrar persiste un contrato que MIENTE: la clave recargable queda como bootOnly', () => {
    const dir = work()
    try {
      boot(dir, true)
      const [e] = leerJournal(dir).entries
      // Lo que se midió en producción, reproducido: la entrada del boot nace sin watches ni señales.
      expect(e!.projection.watches).toEqual([])
      expect(e!.projection.signals).toEqual([])
      // Y la mentira que eso produce, que es lo grave — el contrato exige un reinicio que no hace falta.
      expect(e!.projection.env.bootOnly).toContain('VERGIS_POLICIES')
      expect(e!.projection.env.reloadableContent).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('observar después de registrar persiste el contrato COMPLETO — sin depender de que alguien consulte /contrato', () => {
    const dir = work()
    try {
      boot(dir, false)
      const [e] = leerJournal(dir).entries
      expect(e!.projection.watches).toHaveLength(1)
      expect(e!.projection.signals).toHaveLength(1)
      expect(e!.projection.env.reloadableContent).toEqual(['VERGIS_POLICIES'])
      expect(e!.projection.env.bootOnly).not.toContain('VERGIS_POLICIES')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('la convergencia observada en producción es la UNIÓN que hace un GET: mismo boots, sha distinto', () => {
    const dir = work()
    try {
      // Orden viejo, y después la observación que hace `GET /contrato` (contract.ts) sobre el mismo proceso.
      const contract = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: { VERGIS_POLICIES: '/p' } })
      const journal = createContractJournal({ dir })
      contract.env('VERGIS_POLICIES')
      journal.observe(contract.snapshot())
      const antes = leerJournal(dir).entries[0]!
      contract.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }, [], () => {})
      journal.observe(contract.snapshot()) // ← el GET
      const despues = leerJournal(dir).entries[0]!

      expect(antes.projection.watches).toEqual([])
      expect(despues.projection.watches).toHaveLength(1)
      expect(despues.projectionSha256).not.toBe(antes.projectionSha256)
      // Misma entrada del mismo arranque: no es un boot nuevo, es la entrada sanándose sola.
      expect(despues.boots).toBe(1)
      expect(antes.boots).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('la GARANTÍA: una declaración tardía re-observa sola — el orden del arranque deja de importar', () => {
    const dir = work()
    try {
      const contract = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: { VERGIS_POLICIES: '/p' } })
      const journal = createContractJournal({ dir })
      contract.env('VERGIS_POLICIES')
      contract.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }, [], () => {})
      journal.observe(contract.snapshot()) // el boot, ya al final del cableado
      // …y solo DESPUÉS se engancha el aviso: las N declaraciones del boot no producen N escrituras.
      contract.onRegister(() => journal.observe(contract.snapshot()))

      // Un watch que aparece tarde (un bootstrap async, o código nuevo debajo de la observación).
      contract.watch({ envs: ['VERGIS_SOURCES'], reloads: 'fuentes' }, [], () => {})
      const e = leerJournal(dir).entries[0]!
      // Persistido SIN que nadie consulte `/contrato`: eso es lo que antes exigía un GET.
      expect(e.projection.env.reloadableContent).toEqual(['VERGIS_POLICIES', 'VERGIS_SOURCES'])
      expect(e.projection.watches).toHaveLength(2)
      expect(e.boots).toBe(1) // la re-observación no es un boot nuevo

      // Y una señal tardía también.
      contract.signal({ signal: 'SIGHUP', action: 'recarga todo lo recargable' })
      expect(leerJournal(dir).entries[0]!.projection.signals).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('el aviso jamás rompe la declaración que lo disparó', () => {
    const contract = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: {} })
    contract.onRegister(() => {
      throw new Error('journal caído')
    })
    // El contrato es observabilidad, no serving: un journal roto no puede tumbar el registro de un watch.
    expect(() => contract.watch({ envs: ['X'], reloads: 'y' }, [], () => {})).not.toThrow()
    expect(contract.snapshot().watches).toHaveLength(1)
  })

  it('DELTA FANTASMA: contra una referencia temprana, un despliegue donde nada cambió reporta nowReloadable', () => {
    // La referencia queda temprana cuando NADIE consultó `/contrato` en la versión anterior: el boot
    // escribió la proyección incompleta y nada la sanó. El delta de la versión siguiente entonces
    // «descubre» una recargabilidad que existía desde antes — en el campo que el issue declara el más
    // valioso para invalidar reglas del operador.
    const temprana: ContractProjection = projectContract({
      watches: [], signals: [],
      env: { bootOnly: ['VERGIS_POLICIES'], reloadableContent: [], unknown: [] }, caveats: [],
    })
    const completa: ContractProjection = projectContract({
      watches: [{ envs: ['VERGIS_POLICIES'], paths: ['/p'], reloads: 'gobierno' }], signals: [],
      env: { bootOnly: [], reloadableContent: ['VERGIS_POLICIES'], unknown: [] }, caveats: [],
    })
    const d = diffProjections(temprana, completa)
    expect(d.env.nowReloadable).toEqual(['VERGIS_POLICIES'])
    // El fantasma: entre 0.15.0 y 0.16.0 el watch no se agregó — ya estaba. Lo que cambió fue cuándo
    // se tomó la foto. Con el arranque observando después de registrar, las dos fotos son completas y
    // este delta desaparece.
  })
})
