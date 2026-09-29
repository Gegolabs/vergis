/**
 * PLUGIN `vergis` · V7 — el plugin se publica fijado al tag de la versión (D11), y un tag que no es una
 * versión del Producto no dispara nada.
 *
 *  · Lockstep: `plugin.json.version == package.json.version` y `marketplace.ref == "v" + version`, sin
 *    `sha`, con fuente `git-subdir`. Lo corre la suite y lo corre `npm run corte:cotejo`: el commit de
 *    corte que olvide mover el plugin sale rojo. Sabe reprobar: sobre copias alteradas, nombra el defecto.
 *  · `v[0-9]*` en los tres lugares donde era `v*`: el disparador del workflow, el `enable` de `latest` y el
 *    `--match` del cotejo. `claude plugin tag` crea `vergis--vX.Y.Z`: con `v*` dispararía el build y
 *    movería `latest`. El `git describe` se mide en un repo temporal (crear un tag en este repo lo crearía
 *    para todos sus worktrees).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginLockstep } from '../scripts/plugin-lockstep'
import { RAIZ, tmp } from './plugin-helpers'

function copia(mut: (d: { pkg: any; plugin: any; mk: any }) => void): string {
  const dir = tmp('vergis-lockstep-')
  mkdirSync(join(dir, 'plugins/vergis/.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, '.claude-plugin'))
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(join(RAIZ, 'plugins/vergis/.claude-plugin/plugin.json'), 'utf8'))
  const mk = JSON.parse(readFileSync(join(RAIZ, '.claude-plugin/marketplace.json'), 'utf8'))
  mut({ pkg, plugin, mk })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(dir, 'plugins/vergis/.claude-plugin/plugin.json'), JSON.stringify(plugin))
  writeFileSync(join(dir, '.claude-plugin/marketplace.json'), JSON.stringify(mk))
  return dir
}

describe('lockstep del plugin con el Producto (D11)', () => {
  it('el repo está en lockstep', () => {
    expect(pluginLockstep(RAIZ)).toEqual([])
  })
  it('un corte que sube package.json sin mover el plugin se detecta (versión y ref)', () => {
    const e = pluginLockstep(copia(({ pkg }) => { pkg.version = '9.9.9' }))
    expect(e.join('\n')).toMatch(/plugin\.json: version .* ≠ package\.json 9\.9\.9/)
    expect(e.join('\n')).toMatch(/ref «v.*» ≠ «v9\.9\.9»/)
  })
  it('una fuente relativa (instalaría main) o con sha se detecta', () => {
    expect(pluginLockstep(copia(({ mk }) => { mk.plugins[0].source = './plugins/vergis' })).join('\n')).toMatch(/git-subdir/)
    expect(pluginLockstep(copia(({ mk }) => { mk.plugins[0].source.sha = 'abc' })).join('\n')).toMatch(/no lleva sha/)
  })
  it('un renombre del plugin o del marketplace se detecta (los nombres publicados son inmutables)', () => {
    expect(pluginLockstep(copia(({ plugin }) => { plugin.name = 'vergis-ops' })).join('\n')).toMatch(/inmutable/)
    expect(pluginLockstep(copia(({ mk }) => { mk.name = 'gegolabs' })).join('\n')).toMatch(/vergis@vergis/)
  })
})

describe('v[0-9]* en los tres lugares (D11)', () => {
  const BUILD = readFileSync(join(RAIZ, '.github/workflows/build.yml'), 'utf8')
  const COTEJO = readFileSync(join(RAIZ, 'scripts/corte-cotejo.ts'), 'utf8')

  it('el disparador del workflow es v[0-9]*, y ya no v*', () => {
    expect(BUILD).toMatch(/tags: \['v\[0-9\]\*'\]/)
    expect(BUILD).not.toMatch(/tags: \['v\*'\]/)
  })

  it('el enable de latest no usa startsWith(refs/tags/v): usa el paso que exige un dígito', () => {
    expect(BUILD).not.toMatch(/enable=\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\)/)
    expect(BUILD).toMatch(/type=raw,value=latest,enable=\$\{\{ steps\.ref\.outputs\.version == 'true' \}\}/)
    // El paso mismo, corrido con sh: un tag no-versión NO es versión.
    const paso = /case "\$GITHUB_REF" in[\s\S]*?esac/.exec(BUILD)?.[0]
    expect(paso).toBeTruthy()
    const es = (ref: string) => {
      const out = join(tmp(), 'out')
      writeFileSync(out, '')
      spawnSync('sh', ['-c', paso!], { env: { ...process.env, GITHUB_REF: ref, GITHUB_OUTPUT: out } })
      return readFileSync(out, 'utf8').trim()
    }
    expect(es('refs/tags/v0.40.0')).toBe('version=true')
    expect(es('refs/tags/vergis--v0.0.0')).toBe('version=false')
    expect(es('refs/heads/main')).toBe('version=false')
  })

  it('el cotejo describe con --match v[0-9]*, y eso ignora un tag vergis--v0.0.0 (medido en un repo temporal)', () => {
    expect(COTEJO).toMatch(/'--match', 'v\[0-9\]\*'/)
    const dir = tmp('vergis-tags-')
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim()
    git('init', '-q')
    writeFileSync(join(dir, 'a'), '1')
    git('add', 'a'); git('commit', '-qm', 'uno'); git('tag', 'v0.1.0')
    writeFileSync(join(dir, 'a'), '2')
    git('commit', '-qam', 'dos'); git('tag', 'vergis--v0.0.0')
    expect(git('describe', '--tags', '--abbrev=0', '--match', 'v*')).toBe('vergis--v0.0.0') // el defecto que se cierra
    expect(git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')).toBe('v0.1.0')
  })
})

// El cotejo completo del corte usa pluginLockstep: se prueba que lo invoca, no se re-corre el git log.
describe('corte:cotejo incluye el lockstep', () => {
  it('importa y evalúa pluginLockstep, y su exit lo considera', () => {
    const src = readFileSync(join(RAIZ, 'scripts/corte-cotejo.ts'), 'utf8')
    expect(src).toMatch(/import \{ pluginLockstep \} from '\.\/plugin-lockstep'/)
    expect(src).toMatch(/process\.exit\(sinDeclarar\.length \|\| lockstep\.length \? 1 : 0\)/)
  })
})
