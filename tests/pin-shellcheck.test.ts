import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * EL PIN DE SHELLCHECK ES UN SOLO HECHO ESCRITO EN DOS LADOS.
 *
 * La versión que el gate local exige (`SHELLCHECK_ESPERADO` en `scripts/lint-shell.sh`) y la que el
 * CI descarga y verifica por checksum (`SHELLCHECK_VERSION` en `.github/workflows/build.yml`) tienen
 * que ser la MISMA. Si divergen, el modo estricto del CI lo delata en rojo — pero después del push,
 * y sobre una corrida que ya gastó su tiempo. Este guard lo delata en `npm test`, antes.
 *
 * Es el mismo patrón —y por la misma razón— que `imagen-anillo-labels.test.ts` aplica a los labels
 * del `Dockerfile` contra las constantes del código: una pareja que driftea se ata con un test, no
 * con un comentario cruzado. Los comentarios cruzados YA existen en los dos archivos y no impidieron
 * nada, porque un comentario no corre.
 *
 * Y se comprueba una tercera cosa que no es redundante: que el nombre del tarball y la URL de
 * descarga se compongan con `${SHELLCHECK_VERSION}` y no con el número escrito a mano. Un pin
 * interpolado en un sitio y literal en otro es la misma pareja que driftea, un nivel más abajo.
 *
 * Falsificación ejecutada (2026-08-26): con `SHELLCHECK_ESPERADO=0.10.0` en el script y `0.11.0` en
 * el workflow, la primera prueba falla nombrando ambos números. El guard sabe reprobar.
 */

const RAIZ = resolve(__dirname, '..')
const LINT = readFileSync(join(RAIZ, 'scripts/lint-shell.sh'), 'utf8')
const BUILD = readFileSync(join(RAIZ, '.github/workflows/build.yml'), 'utf8')

/** Lee un literal `CLAVE=valor` / `CLAVE: valor` de un archivo, sin tolerar la ausencia. */
function literal(texto: string, clave: string, sep: string, dónde: string): string {
  const m = texto.match(new RegExp(`^\\s*${clave}${sep}\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm'))
  if (!m) throw new Error(`${dónde} no declara ${clave} — el pin se movió de sitio y este guard quedó ciego`)
  return m[1]!
}

describe('el pin de shellcheck no driftea entre el gate local y el CI', () => {
  it('la versión del script y la del workflow son la misma', () => {
    const local = literal(LINT, 'SHELLCHECK_ESPERADO', '=', 'scripts/lint-shell.sh')
    const ci = literal(BUILD, 'SHELLCHECK_VERSION', ':', '.github/workflows/build.yml')
    expect(
      local,
      `el gate local exige shellcheck ${local} y el CI instala ${ci}: son el mismo hecho y no coinciden`,
    ).toBe(ci)
  })

  it('el checksum del CI es un sha256 completo, no un placeholder', () => {
    const sha = literal(BUILD, 'SHELLCHECK_SHA256', ':', '.github/workflows/build.yml')
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('el tarball y la URL se componen con la variable, no con el número escrito a mano', () => {
    // Si alguien interpola el número a mano, actualizar el pin deja de ser un cambio de una línea.
    expect(BUILD).toContain('shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz')
    expect(BUILD).toContain('/releases/download/v${SHELLCHECK_VERSION}/${tarball}')
  })
})
