/**
 * PLUGINS `vergis`, `custos` y `mira` · V7 — cada plugin se publica fijado al tag de la versión (D11; tres
 * plugins desde #387), y un tag que no es una versión del Producto no dispara nada.
 *
 *  · Lockstep, para CADA plugin: `plugin.json.name` es el publicado, `plugin.json.version ==
 *    package.json.version` y su entrada del marketplace tiene `ref == "v" + version`, sin `sha`, con fuente
 *    `git-subdir` y `path == plugins/<nombre>`. `custos` y `mira` declaran la dependencia `vergis` (trae el
 *    CLI). Lo corre la suite y lo corre `npm run corte:cotejo`: el commit de corte que olvide mover un
 *    plugin sale rojo. Sabe reprobar: sobre copias alteradas, nombra el defecto y el plugin.
 *  · `v[0-9]*` en los tres lugares donde era `v*`: el disparador del workflow, el `enable` de `latest` y el
 *    `--match` del cotejo. `claude plugin tag` crea `vergis--vX.Y.Z`: con `v*` dispararía el build y
 *    movería `latest`. El `git describe` se mide en un repo temporal (crear un tag en este repo lo crearía
 *    para todos sus worktrees).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGINS, pluginLockstep } from '../scripts/plugin-lockstep'
import { RAIZ, tmp } from './plugin-helpers'

type Manifiestos = { pkg: any; plugins: Record<string, any>; mk: any }

function copia(mut: (d: Manifiestos) => void): string {
  const dir = tmp('vergis-lockstep-')
  mkdirSync(join(dir, '.claude-plugin'))
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'))
  const mk = JSON.parse(readFileSync(join(RAIZ, '.claude-plugin/marketplace.json'), 'utf8'))
  const plugins: Record<string, any> = {}
  for (const { name } of PLUGINS) plugins[name] = JSON.parse(readFileSync(join(RAIZ, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'))
  mut({ pkg, plugins, mk })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(dir, '.claude-plugin/marketplace.json'), JSON.stringify(mk))
  for (const [name, plugin] of Object.entries(plugins)) {
    if (plugin === undefined) continue // un plugin borrado de la copia
    mkdirSync(join(dir, `plugins/${name}/.claude-plugin`), { recursive: true })
    writeFileSync(join(dir, `plugins/${name}/.claude-plugin/plugin.json`), JSON.stringify(plugin))
  }
  return dir
}

const entrada = (mk: any, name: string) => mk.plugins.find((p: { name: string }) => p.name === name)
const errores = (mut: (d: Manifiestos) => void) => pluginLockstep(copia(mut)).join('\n')

describe('lockstep de los plugins con el Producto (D11 · #387)', () => {
  it('el repo está en lockstep', () => {
    expect(pluginLockstep(RAIZ)).toEqual([])
  })

  it('son tres plugins, y el marketplace los lista a los tres en ese orden', () => {
    expect(PLUGINS.map((p) => p.name)).toEqual(['vergis', 'custos', 'mira'])
    const mk = JSON.parse(readFileSync(join(RAIZ, '.claude-plugin/marketplace.json'), 'utf8'))
    expect(mk.plugins.map((p: { name: string }) => p.name)).toEqual(['vergis', 'custos', 'mira'])
  })

  it('un corte que sube package.json sin mover los plugins se detecta en los tres (versión y ref)', () => {
    const e = errores(({ pkg }) => { pkg.version = '9.9.9' })
    for (const { name } of PLUGINS) {
      expect(e).toMatch(new RegExp(`${name}/plugin\\.json: version .* ≠ package\\.json 9\\.9\\.9`))
      expect(e).toMatch(new RegExp(`\\(${name}\\): ref «v.*» ≠ «v9\\.9\\.9»`))
    }
  })

  for (const { name } of PLUGINS) {
    it(`sabe reprobar sobre «${name}» solo: versión, ref, path, fuente, sha y nombre`, () => {
      expect(errores(({ plugins }) => { plugins[name].version = '0.0.1' })).toMatch(new RegExp(`^${name}/plugin\\.json: version 0\\.0\\.1 ≠`, 'm'))
      expect(errores(({ mk }) => { entrada(mk, name).source.ref = 'main' })).toMatch(new RegExp(`\\(${name}\\): ref «main»`))
      expect(errores(({ mk }) => { entrada(mk, name).source.path = 'plugins/otro' })).toMatch(new RegExp(`\\(${name}\\): path «plugins/otro» ≠ «plugins/${name}»`))
      expect(errores(({ mk }) => { entrada(mk, name).source = `./plugins/${name}` })).toMatch(new RegExp(`\\(${name}\\): la fuente es .*git-subdir`))
      expect(errores(({ mk }) => { entrada(mk, name).source.source = 'github' })).toMatch(new RegExp(`\\(${name}\\): la fuente es «github»`))
      expect(errores(({ mk }) => { entrada(mk, name).source.sha = 'abc' })).toMatch(new RegExp(`\\(${name}\\): la fuente no lleva sha`))
      expect(errores(({ mk }) => { entrada(mk, name).source.url = 'https://github.com/otro/vergis.git' })).toMatch(new RegExp(`\\(${name}\\): url`))
      expect(errores(({ plugins }) => { plugins[name].name = `${name}-ops` })).toMatch(new RegExp(`${name}/plugin\\.json: name .* inmutable`))
    })

    it(`sabe reprobar: «${name}» ausente del marketplace, o sin su plugin.json`, () => {
      expect(errores(({ mk }) => { mk.plugins = mk.plugins.filter((p: { name: string }) => p.name !== name) })).toMatch(new RegExp(`no lista el plugin «${name}»`))
      expect(errores(({ plugins }) => { plugins[name] = undefined })).toMatch(new RegExp(`plugins/${name}/\\.claude-plugin/plugin\\.json: no existe`))
    })
  }

  it('custos y mira sin la dependencia vergis se detectan (sus skills invocan un CLI que no tendrían)', () => {
    expect(errores(({ plugins }) => { delete plugins.custos.dependencies })).toMatch(/custos\/plugin\.json: no declara la dependencia «vergis»/)
    expect(errores(({ plugins }) => { plugins.mira.dependencies = [] })).toMatch(/mira\/plugin\.json: no declara la dependencia «vergis»/)
  })

  it('un plugin en el marketplace fuera del lockstep se detecta (nadie cotejaría su versión)', () => {
    expect(errores(({ mk }) => { mk.plugins.push({ ...entrada(mk, 'mira'), name: 'daftar' }) })).toMatch(/lista «daftar», que no está en el lockstep/)
  })

  it('un renombre del marketplace se detecta (los nombres publicados son inmutables)', () => {
    expect(errores(({ mk }) => { mk.name = 'gegolabs' })).toMatch(/<plugin>@vergis/)
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
