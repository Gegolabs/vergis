/**
 * #297 · El aviso por `VERGIS_INSTRUMENTOS_DIR` pertenece a la FAMILIA, no al nodo.
 *
 * Lo que se mide es la regla, en sus dos brazos: el nodo que hospeda un Let de Daftar SIN el volumen
 * montado tiene que leer la línea entera (control positivo — sin él no se sabría si se silenció de
 * más), y el nodo de Mira pura que no hospeda ninguno NO tiene que leer nada (el defecto del issue).
 *
 * El último bloque ancla el CABLEADO al texto de `serve-rls.ts`: la función pura podría estar
 * perfecta y el aviso seguir emitiéndose incondicionalmente arriba, que es exactamente el bug.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { avisoEnvDeFamilia } from '../server/proto-registry'

const CONSEC = 'servirán un catálogo VACÍO.'
const daftarLet = { proto: 'daftar', slug: 'preu' }
const miraLet = { proto: 'mira', slug: 'qw-04' }

describe('#297 · avisoEnvDeFamilia', () => {
  it('CONTROL POSITIVO · hay un Let de Daftar y falta la env ⇒ avisa, nombrando env, familia y slug', () => {
    const a = avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', false, 'daftar', [daftarLet], CONSEC)
    expect(a).toBeTruthy()
    expect(a).toContain('VERGIS_INSTRUMENTOS_DIR')
    expect(a).toContain('[daftar]')
    expect(a).toContain('preu')
    expect(a).toContain(CONSEC)
  })

  it('EL DEFECTO · instancia de Mira pura sin la env ⇒ NO avisa (no hay nada que el operador pueda hacer)', () => {
    expect(avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', false, 'daftar', [miraLet, { proto: 'mira', slug: 'qw-05' }], CONSEC)).toBeNull()
  })

  it('padrón VACÍO ⇒ no avisa: sin Lets descubiertos no hay familia a la que la env le importe', () => {
    expect(avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', false, 'daftar', [], CONSEC)).toBeNull()
  })

  it('la env DEFINIDA no avisa nunca, haya o no Lets de la familia', () => {
    expect(avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', true, 'daftar', [daftarLet], CONSEC)).toBeNull()
    expect(avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', true, 'daftar', [], CONSEC)).toBeNull()
  })

  it('una mezcla con al menos un Let de la familia SÍ avisa, y cuenta solo los de esa familia', () => {
    const a = avisoEnvDeFamilia('VERGIS_INSTRUMENTOS_DIR', false, 'daftar', [miraLet, daftarLet], CONSEC)
    expect(a).toContain('1 Let(s)')
    expect(a).not.toContain('qw-04')
  })
})

describe('#297 · el cableado en serve-rls', () => {
  const SERVE = readFileSync(join(resolve(__dirname, '..'), 'server/serve-rls.ts'), 'utf8')

  it('no queda ningún aviso INCONDICIONAL sobre la env: toda mención en un console.warn pasa por el predicado', () => {
    const incondicional = SERVE.split('\n').filter(
      (l) => l.includes('console.warn') && l.includes('VERGIS_INSTRUMENTOS_DIR'),
    )
    expect(incondicional).toEqual([])
  })

  it('el aviso se decide con `avisoEnvDeFamilia` sobre el padrón descubierto (`discover()`)', () => {
    const i = SERVE.indexOf('avisoEnvDeFamilia(')
    expect(i, 'ancla `avisoEnvDeFamilia(` no encontrada en serve-rls.ts').toBeGreaterThan(-1)
    // El import no lleva paréntesis, así que este hit ES la llamada: su bloque cita el padrón.
    expect(SERVE.slice(i, i + 500)).toContain('discover()')
  })
})
