/**
 * ANILLOS: el borde que conmuta y la herramienta de ciclo de vida (issue #210 · I7 + I8).
 *
 * Dos familias de aserción, y las dos existen por una razón medida:
 *
 * 1 · INVARIANTES DEL BORDE. El predicado de ruteo es `200 ∧ phase=serving ∧ lets.serving=lets.total`, y
 *     NUNCA el código HTTP: un nodo en espera responde 200 con `ok:true` POR DISEÑO. Un health check que
 *     juzgue por `r.ok` declararía sano a un nodo al que no se debe rutear tráfico. Estas pruebas fallan
 *     si alguien relaja el predicado o publica el listener interno al host.
 *
 * 2 · COMPORTAMIENTO DE LA HERRAMIENTA, corrido de verdad con `sh` (no `bash`) contra un `docker` falso
 *     inyectado por `RINGS_DOCKER`. Cubre las tres negativas que el diseño exige que sean imposibles de
 *     saltar: `prune` no retira el activo ni el previo, `install` no pisa una versión cuyo digest cambió,
 *     y `promote` no procede si el esquema del candidato es más viejo que el del archivo.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Estas pruebas ARRANCAN PROCESOS (`sh` + un docker falso) y esperan relevos del plano de control con
// sus enfriamientos: duran segundos, no milisegundos. El default de 5 s las corta a mitad de un handover.
vi.setConfig({ testTimeout: 90_000 })

const RAIZ = resolve(__dirname, '..')
const TOOL = join(RAIZ, 'deploy/rollout/botler-rollout')
const TOOL_ALIAS = join(RAIZ, 'deploy/rollout/vergis-rollout')
const FAKE = join(RAIZ, 'tests/fixtures/anillos/fake-docker.sh')
const CADDYFILE = readFileSync(join(RAIZ, 'deploy/Caddyfile.reference'), 'utf8')
const COMPOSE = readFileSync(join(RAIZ, 'deploy/compose.reference.yml'), 'utf8')

// ─── Mundo de prueba ────────────────────────────────────────────────────────────────────────────────

interface Mundo {
  dir: string
  rings: string
  world: string
  /** El entorno exacto con que se invoca la herramienta (docker falso + RINGS_*), para los casos
   *  que necesitan invocarla por otra ruta —el alias retirado— con el mismo mundo. */
  env: NodeJS.ProcessEnv
  /** Corre la herramienta con `sh`. Devuelve código, stdout y stderr SIN lanzar: los rechazos del
   *  pre-flight son el objeto de estudio, no un accidente. */
  run: (...args: string[]) => { code: number; out: string; err: string }
  imagen: (ref: string, digest: string, id: string) => void
  contenedor: (name: string, campos: Record<string, string>) => void
  fase: (name: string) => string
  registro: () => { active: string; previous: string; rings: { version: string; state: string; digest: string }[] }
  activeCaddy: () => string
  llamadas: () => string
  intent: () => string
  intents: () => string[]
  campo: (name: string, k: string, v: string) => void
}

function nuevoMundo(): Mundo {
  const dir = mkdtempSync(join(tmpdir(), 'anillos-'))
  const rings = join(dir, 'rings')
  const world = join(dir, 'world')
  mkdirSync(rings, { recursive: true })
  mkdirSync(join(world, 'images'), { recursive: true })
  mkdirSync(join(world, 'containers'), { recursive: true })
  writeFileSync(join(world, 'schema'), '1 1\n')
  cpSync(join(RAIZ, 'deploy/rollout/ring.args.example'), join(rings, 'ring.args'))
  cpSync(join(RAIZ, 'deploy/rings/active.caddy.example'), join(rings, 'active.caddy'))
  const env = {
    ...process.env,
    RINGS_DIR: rings,
    RINGS_DOCKER: FAKE,
    RINGS_IMAGE: 'ghcr.io/gegolabs/vergis',
    RINGS_ADMIN_EMAIL: 'admin@ejemplo.test',
    RINGS_STANDBY_TIMEOUT: '3',
    RINGS_PROMOTE_TIMEOUT: '8',
    FAKE_WORLD: world,
    FAKE_RINGS_DIR: rings,
  }
  return {
    dir,
    rings,
    world,
    env,
    run: (...args) => {
      // `spawnSync` y no `execFileSync`: hay que capturar stderr TAMBIÉN cuando el comando termina bien
      // (las advertencias que se gritan sin abortar son parte de lo que se afirma acá).
      const r = spawnSync('sh', [TOOL, ...args], { env, encoding: 'utf8' })
      return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
    },
    imagen: (ref, digest, id) => {
      const f = join(world, 'images', ref.replace(/[/:]/g, '_'))
      writeFileSync(f, `${ref.split(':')[0]}@${digest}\n${id}\n`)
    },
    contenedor: (name, campos) => {
      writeFileSync(
        join(world, 'containers', name),
        Object.entries(campos)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
      )
    },
    fase: (name) => {
      const f = join(world, 'containers', name)
      if (!existsSync(f)) return 'sin-contenedor'
      return readFileSync(f, 'utf8').match(/^phase=(.*)$/m)?.[1] ?? ''
    },
    registro: () => {
      const txt = readFileSync(join(rings, 'rings.json'), 'utf8')
      return {
        active: txt.match(/"active": "(.*)"/)?.[1] ?? '',
        previous: txt.match(/"previous": "(.*)"/)?.[1] ?? '',
        rings: [...txt.matchAll(/^ {4}(\{"version".*?\}),?$/gm)].map((m) => JSON.parse(m[1])),
      }
    },
    activeCaddy: () => readFileSync(join(rings, 'active.caddy'), 'utf8'),
    llamadas: () => (existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf8') : ''),
    /** El intent de handover VIGENTE en el mundo falso (vacío si se borró o nunca se escribió). */
    intent: () => (existsSync(join(world, 'handover')) ? readFileSync(join(world, 'handover'), 'utf8').trim() : ''),
    /** Todos los intents que se escribieron, en orden: es lo que permite afirmar a quién se nombró. */
    intents: () => (existsSync(join(world, 'handover.log')) ? readFileSync(join(world, 'handover.log'), 'utf8').trim().split('\n') : []),
    /** Cambia UN campo de un contenedor sin pisar el resto (el mundo lo lee línea a línea). */
    campo: (name: string, k: string, v: string) => {
      const f = join(world, 'containers', name)
      const txt = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith(`${k}=`))
      writeFileSync(f, [...txt, `${k}=${v}`].join('\n') + '\n')
    },
  }
}

/** Instala una versión y devuelve el nombre de su contenedor. */
function instalar(m: Mundo, version: string, digest: string, id = `sha256:id-${version}`): string {
  m.imagen(`ghcr.io/gegolabs/vergis:${version}`, digest, id)
  const r = m.run('install', version)
  expect(r.code, r.err).toBe(0)
  return `vergis-${version.replace(/\./g, '-')}`
}

// ─── 1 · El borde ───────────────────────────────────────────────────────────────────────────────────

describe('el borde que conmuta (I7)', () => {
  it('juzga la salud del anillo por la FASE, no por el código HTTP', () => {
    // El corazón del frente: un standby responde 200 con ok:true. Si esto se relaja a `health_status
    // 2xx` a secas, el borde rutearía tráfico a un nodo que contesta 409 a toda escritura.
    expect(CADDYFILE).toMatch(/health_uri\s+\/healthz/)
    expect(CADDYFILE).toMatch(/health_body\s+`"phase":"serving"`/)
    expect(CADDYFILE).toMatch(/health_status\s+2xx/)
    // El intervalo es COLA DE LATENCIA, no correctitud: acota cuánto tardan en soltarse los retenidos
    // una vez que el anillo nuevo satisface el predicado. La plantilla declara su costo al lado.
    expect(CADDYFILE).toMatch(/health_interval\s+250ms/)
    expect(CADDYFILE).toMatch(/4 req\/s por upstream/)
  })

  it('retiene los requests en la sala de espera en vez de devolver 502', () => {
    expect(CADDYFILE).toMatch(/lb_try_duration\s+90s/)
    expect(CADDYFILE).toMatch(/lb_try_interval\s+500ms/)
    expect(CADDYFILE).toMatch(/handle_errors\s*\{/)
    // La página vive en el BORDE, jamás dentro de Vergis: nada dentro de un proceso cubre su ausencia.
    expect(CADDYFILE).toContain('/etc/caddy/edge')
    expect(CADDYFILE).toMatch(/status\s+503/)
    const espera = readFileSync(join(RAIZ, 'deploy/edge/espera.html'), 'utf8')
    expect(espera).toMatch(/http-equiv="refresh"/)
    // Autocontenida: sin red, la página tiene que servirse igual.
    expect(espera).not.toMatch(/src="http|href="http/)
  })

  it('toma el upstream del anillo de un archivo importado, no del Caddyfile', () => {
    expect(CADDYFILE).toMatch(/import\s+\/etc\/caddy\/rings\/active\.caddy/)
    const activo = readFileSync(join(RAIZ, 'deploy/rings/active.caddy.example'), 'utf8')
    expect(activo).toMatch(/^reverse_proxy \S+:8080 \{$/m)
    expect(activo).toMatch(/import anillo_activo/)
  })

  it('mete el SSO por delante del conmutador y NO publica el listener interno', () => {
    expect(COMPOSE).toMatch(/OAUTH2_PROXY_UPSTREAMS:\s*http:\/\/caddy:8079/)
    expect(COMPOSE).toMatch(/expose:\s*\["8079"\]/)
    // Publicar :8079 al host sería un bypass del SSO y de la RLS (supuesto de red D2).
    expect(COMPOSE).not.toMatch(/"8079:8079"/)
    expect(CADDYFILE).toMatch(/reverse_proxy oauth2-proxy:4180/)
  })
})

// ─── 2 · La herramienta ─────────────────────────────────────────────────────────────────────────────

describe('botler-rollout (I8)', () => {
  let m: Mundo
  beforeEach(() => {
    m = nuevoMundo()
  })

  it('es POSIX sh sin bashismos (la VM objetivo corre sh, y un bashismo deja el acto a medias)', () => {
    const src = readFileSync(TOOL, 'utf8')
    expect(src.startsWith('#!/bin/sh\n')).toBe(true)
    const cuerpo = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    // Substrings sueltos: aparecen en prosa castellana («que el candidato declare serving»), así que
    // los bashismos se buscan ANCLADOS al inicio de sentencia o como operador.
    for (const bashismo of [/\[\[/, /<<</, /=~/, /\$\(</, /&>/, /\bshopt\b/, /\$\{[A-Za-z_]+\[/]) {
      expect(cuerpo, `bashismo ${bashismo}`).not.toMatch(bashismo)
    }
    for (const palabra of ['function', 'local', 'declare', 'typeset', 'source']) {
      expect(cuerpo, `bashismo '${palabra}'`).not.toMatch(new RegExp(`^\\s*${palabra}\\s`, 'm'))
    }
    // `sh -n` es el gate real: sintaxis válida para el shell que la VM sí tiene.
    expect(() => execFileSync('sh', ['-n', TOOL])).not.toThrow()
  })

  /**
   * EL LECTOR DE FASE DEL DIAGNÓSTICO tiene su propio gate.
   *
   * `phase_of` saca la fase de CUALQUIER cuerpo con un `sed`: le basta el literal. En el camino de
   * diagnóstico el cuerpo puede no ser del nodo —la página de espera del borde llevó `"phase":"serving"`
   * en un comentario— y entonces el `warn` del smoke imprime una fase que nadie declaró, justo cuando
   * alguien está averiguando qué pasó. `phase_reportada` exige el 200 antes de leerla, y cuando no lo
   * hay lo DICE en vez de callarlo.
   *
   * Las funciones se ejercitan con `sh` sobre el archivo real (`. TOOL` no sirve: el script corre su
   * `case` al final), así que se recortan sus dos definiciones y se corren tal cual están escritas.
   */
  it('LECTOR DE FASE: el diagnóstico no le cree la fase a un cuerpo que no vino con 200', () => {
    const src = readFileSync(TOOL, 'utf8')
    const ini = src.indexOf('phase_of() {')
    const fin = src.indexOf('\n# healthz de un anillo')
    expect(ini, 'no se encontró la definición de phase_of en la herramienta').toBeGreaterThan(0)
    expect(fin, 'no se encontró el final del bloque de lectores de fase').toBeGreaterThan(ini)
    const bloque = src.slice(ini, fin)
    const correr = (args: string[]): string =>
      spawnSync('sh', ['-c', `${bloque}\n"$@"`, 'sh', ...args], { encoding: 'utf8' }).stdout.trim()

    // Control POSITIVO: con 200 y el cuerpo real del nodo, sigue leyendo la fase (si esto fallara, el
    // gate habría roto lo que tenía que preservar).
    expect(correr(['phase_reportada', '200', '{"ok":true,"engine":"clickhouse","phase":"serving"}'])).toBe('serving')
    expect(correr(['phase_reportada', '200', '{"ok":true,"phase":"standby"}'])).toBe('standby')

    // EL CASO QUE ESTE GATE EXISTE PARA CORTAR: un cuerpo de error que contiene el literal.
    const envenenado = '<!doctype html><!-- el healthz sano dice {"phase":"serving"} --><h1>503</h1>'
    expect(correr(['phase_of', envenenado]), 'el lector sin gate sigue siendo crédulo, por diseño').toBe('serving')
    expect(correr(['phase_reportada', '503', envenenado])).toBe('sin-fase(http-503)')
    expect(correr(['phase_reportada', '', envenenado])).toBe('sin-fase(http-sin-respuesta)')
  })

  it('instala un anillo por versión exacta y lo registra por DIGEST', () => {
    const name = instalar(m, '0.19.0', 'sha256:aaa1')
    const reg = m.registro()
    expect(reg.rings).toHaveLength(1)
    // El PRIMER anillo de un host sin nadie sirviendo toma el lease libre: su estado observado es
    // `activo` aunque el borde todavía no le mande tráfico (quien mueve el tráfico es `promote`).
    expect(reg.rings[0]).toMatchObject({ version: '0.19.0', name, digest: 'sha256:aaa1', state: 'activo' })
    // El anillo declara su identidad al proceso: `/contrato` la publica sin que nadie la teclee.
    expect(m.llamadas()).toContain('VERGIS_RING_DIGEST=sha256:aaa1')
    expect(m.fase(name)).toBe('serving')
  })

  it('rechaza tags móviles: latest, main y las series no identifican lo desplegado', () => {
    for (const tag of ['latest', 'main', '0.19']) {
      const r = m.run('install', tag)
      expect(r.code, tag).not.toBe(0)
      expect(r.err, tag).toMatch(/no es una versión EXACTA/)
    }
  })

  it('GUARD DE DIGEST: no instala encima de una versión cuyo digest cambió', () => {
    instalar(m, '0.19.0', 'sha256:aaa1')
    // El caso medido: el MISMO número de versión en dos imágenes distintas.
    m.imagen('ghcr.io/gegolabs/vergis:0.19.0', 'sha256:bbb2', 'sha256:id-otro')
    const r = m.run('install', '0.19.0')
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/GUARD DE DIGEST/)
    expect(m.registro().rings[0].digest).toBe('sha256:aaa1')

    // Con --redigest se instala como anillo APARTE, sin pisar al anterior.
    const r2 = m.run('install', '0.19.0', '--redigest')
    expect(r2.code, r2.err).toBe(0)
    const versiones = m.registro().rings.map((x) => x.version).sort()
    expect(versiones).toEqual(['0.19.0', '0.19.0-r2'])
  })

  it('es idempotente: re-instalar la misma imagen no recrea el contenedor', () => {
    const name = instalar(m, '0.19.0', 'sha256:aaa1')
    const r = m.run('install', '0.19.0')
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/idempotente/)
    expect(m.llamadas().split('\n').filter((l) => l.startsWith(`create --name ${name}`))).toHaveLength(1)
  })

  it('promueve: handover del control, flip del borde, smoke y registro', () => {
    const viejo = instalar(m, '0.18.0', 'sha256:v18')
    expect(m.run('promote', '0.18.0').code).toBe(0)
    expect(m.fase(viejo)).toBe('serving')

    const nuevo = instalar(m, '0.19.0', 'sha256:v19')
    expect(m.fase(nuevo)).toBe('standby')
    const r = m.run('promote', '0.19.0')
    expect(r.code, r.err).toBe(0)

    // El plano de control se movió, y el viejo NO se detuvo: sigue caliente para el rollback.
    expect(m.llamadas()).toContain(`kill -s USR2 ${viejo}`)
    expect(m.fase(viejo)).toBe('standby')
    expect(m.fase(nuevo)).toBe('serving')
    // El borde conmutó, y por eso el smoke ve `serving` a través de él.
    expect(m.activeCaddy()).toContain(`reverse_proxy ${nuevo}:8080`)
    expect(r.out).toMatch(/phase=serving/)
    expect(m.llamadas()).toMatch(/exec caddy caddy validate/)
    expect(m.llamadas()).toMatch(/exec caddy caddy reload/)
    // NADA se recreó: promover no es un `docker compose up`.
    expect(m.llamadas()).not.toMatch(/^rm -f vergis-0-18-0$/m)

    const reg = m.registro()
    expect(reg.active).toBe('0.19.0')
    expect(reg.previous).toBe('0.18.0')
    expect(reg.rings.find((x) => x.version === '0.18.0')?.state).toBe('standby-previo')
  })

  it('rollback vuelve al previo con un flip en caliente', () => {
    const v18 = instalar(m, '0.18.0', 'sha256:v18')
    m.run('promote', '0.18.0')
    const v19 = instalar(m, '0.19.0', 'sha256:v19')
    m.run('promote', '0.19.0')

    const r = m.run('rollback')
    expect(r.code, r.err).toBe(0)
    expect(m.activeCaddy()).toContain(`reverse_proxy ${v18}:8080`)
    expect(m.fase(v18)).toBe('serving')
    expect(m.fase(v19)).toBe('standby')
    expect(m.registro().active).toBe('0.18.0')
  })

  it('GATE DE ESQUEMA: se niega a promover un candidato más viejo que el archivo del store', () => {
    instalar(m, '0.18.0', 'sha256:v18')
    m.run('promote', '0.18.0')
    const nuevo = instalar(m, '0.19.0', 'sha256:v19')
    const antes = m.activeCaddy()
    // El archivo quedó en esquema 99 y el candidato soporta 1: este es el rollback imposible.
    writeFileSync(join(m.world, 'schema'), '1 99\n')

    const r = m.run('promote', '0.19.0')
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/pre-flight RECHAZADO/)
    expect(r.err).toMatch(/99/)
    // No se tocó NADA: ni el borde, ni el plano de control.
    expect(m.activeCaddy()).toBe(antes)
    expect(m.fase(nuevo)).toBe('standby')
    expect(m.llamadas()).not.toContain('kill -s USR2')
  })

  it('--no-schema-gate procede pero lo GRITA (la puerta de escape no es silenciosa)', () => {
    instalar(m, '0.18.0', 'sha256:v18')
    m.run('promote', '0.18.0')
    instalar(m, '0.19.0', 'sha256:v19')
    const r = m.run('promote', '0.19.0', '--no-schema-gate')
    expect(r.code, r.err).toBe(0)
    expect(r.err).toMatch(/GATE DE ESQUEMA OMITIDO/)
  })

  it('opera sobre el titular OBSERVADO cuando el registro quedó atrás', () => {
    // El primer anillo de un host toma el lease libre sin pasar por `promote`: el registro no lo sabe.
    // Promover a otro tiene que hacer el handover contra quien HOY manda, no contra el registro vacío.
    const v18 = instalar(m, '0.18.0', 'sha256:v18')
    expect(m.fase(v18)).toBe('serving')
    expect(m.registro().active).toBe('')
    const nuevo = instalar(m, '0.19.0', 'sha256:v19')
    const r = m.run('promote', '0.19.0')
    expect(r.code, r.err).toBe(0)
    expect(r.err).toMatch(/el registro dice que el activo es 'ninguno'/)
    expect(m.llamadas()).toContain(`kill -s USR2 ${v18}`)
    expect(m.fase(nuevo)).toBe('serving')
    expect(m.registro()).toMatchObject({ active: '0.19.0', previous: '0.18.0' })
  })

  it('prune NO retira el activo ni el previo, con ninguna combinación de flags', () => {
    for (const v of ['0.17.0', '0.18.0', '0.19.0']) instalar(m, v, `sha256:v${v}`)
    m.run('promote', '0.18.0')
    m.run('promote', '0.19.0') // activo 0.19.0, previo 0.18.0, retenido 0.17.0

    const r = m.run('prune', '--retain', '0', '--force')
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/conservo 0\.19\.0 — es el ACTIVO \(piso inviolable/)
    expect(r.out).toMatch(/conservo 0\.18\.0 — es el PREVIO \(piso inviolable/)
    expect(r.err).toMatch(/menor que el piso/)
    const quedan = m.registro().rings.map((x) => x.version).sort()
    expect(quedan).toEqual(['0.18.0', '0.19.0'])
    expect(m.fase('vergis-0-19-0')).toBe('serving')
    expect(m.fase('vergis-0-18-0')).toBe('standby')
    // Y `retire` directo tampoco los toca.
    expect(m.run('retire', '0.19.0').err).toMatch(/es el anillo ACTIVO: no se retira/)
    expect(m.run('retire', '0.18.0').err).toMatch(/es el anillo PREVIO/)
  })

  it('RINGS_RETAIN=2 reproduce blue-green exacto', () => {
    for (const v of ['0.17.0', '0.18.0', '0.19.0']) instalar(m, v, `sha256:v${v}`)
    expect(m.run('promote', '0.18.0').code).toBe(0)
    expect(m.run('promote', '0.19.0').code).toBe(0)
    const r = m.run('prune', '--retain', '2')
    expect(r.code, r.err).toBe(0)
    // Tres instaladas, retención 2 → quedan exactamente dos: el activo y el previo. Eso ES blue-green.
    expect(m.registro().rings.map((x) => x.version).sort()).toEqual(['0.18.0', '0.19.0'])
    // Y con el default 3 se conserva además el retenido más reciente.
    instalar(m, '0.20.0', 'sha256:v20')
    const r3 = m.run('prune', '--retain', '3', '--dry-run')
    expect(r3.code, r3.err).toBe(0)
    expect(r3.out).toMatch(/nada que retirar/)
  })

  it('--dry-run no toca nada', () => {
    for (const v of ['0.17.0', '0.18.0', '0.19.0']) instalar(m, v, `sha256:v${v}`)
    expect(m.run('promote', '0.18.0').code).toBe(0)
    expect(m.run('promote', '0.19.0').code).toBe(0) // activo 0.19, previo 0.18, retenido 0.17
    const r = m.run('prune', '--retain', '0', '--dry-run')
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/retiro {2}0\.17\.0/)
    expect(r.out).toMatch(/--dry-run: no se tocó nada/)
    expect(m.registro().rings).toHaveLength(3)
  })

  it('status --json es JSON válido y declara activo, previo y digests', () => {
    instalar(m, '0.19.0', 'sha256:v19')
    m.run('promote', '0.19.0')
    const r = m.run('status', '--json')
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.active).toBe('0.19.0')
    expect(j.rings[0].digest).toBe('sha256:v19')
    const t = m.run('status')
    expect(t.out).toMatch(/el borde apunta a: vergis-0-19-0/)
    expect(t.out).toMatch(/serving/)
  })

  it('un borde que no valida se descubre en el PRE-FLIGHT, antes de comprometer tráfico', () => {
    // Con el flip antes del handover, el borde es lo primero que hay que poder mover: si no valida su
    // config vigente, la promoción se niega SIN tocar nada. Antes esto se descubría después del
    // handover — o sea, con el plano de control ya movido.
    const v18 = instalar(m, '0.18.0', 'sha256:v18')
    m.run('promote', '0.18.0')
    const v19 = instalar(m, '0.19.0', 'sha256:v19')
    writeFileSync(join(m.world, 'edge-fails'), '1')
    const r = m.run('promote', '0.19.0')
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/pre-flight ABORTADO: el borde .* NO valida su config vigente/)
    expect(m.activeCaddy()).toContain(`reverse_proxy ${v18}:8080`)
    // Nada se movió: ni el control, ni el intent, ni la fase del candidato.
    expect(m.llamadas()).not.toContain('kill -s USR2')
    expect(m.intent()).toBe('')
    expect(m.fase(v19)).toBe('standby')
  })

  it('EL FLIP VA ANTES DEL HANDOVER, y el intent nombra al sucesor antes del flip', () => {
    const viejo = instalar(m, '0.18.0', 'sha256:v18')
    expect(m.run('promote', '0.18.0').code).toBe(0)
    const nuevo = instalar(m, '0.19.0', 'sha256:v19')
    const antes = m.llamadas().split('\n').length

    const r = m.run('promote', '0.19.0')
    expect(r.code, r.err).toBe(0)
    const nuevas = m.llamadas().split('\n').slice(antes)
    const iFlip = nuevas.findIndex((l) => l.startsWith('exec caddy caddy reload'))
    const iHandover = nuevas.findIndex((l) => l === `kill -s USR2 ${viejo}`)
    expect(iFlip, 'el borde tiene que recargar en esta promoción').toBeGreaterThanOrEqual(0)
    expect(iHandover, 'el handover tiene que ocurrir').toBeGreaterThanOrEqual(0)
    // EL ORDEN es lo que este test existe para fijar: primero se compromete el tráfico, después se
    // pide el control. Invertirlo devuelve el orden que dejaba al viejo-standby como único upstream.
    expect(iFlip).toBeLessThan(iHandover)

    // El intent nombró al candidato ANTES del flip, y se borró al cerrar: es del acto, no del estado.
    expect(m.intents().at(-1)).toContain(nuevo)
    expect(m.intent()).toBe('')
    expect(m.fase(nuevo)).toBe('serving')
    expect(m.registro().active).toBe('0.19.0')
  })

  it('si el candidato no llega a serving, LO PRIMERO que vuelve es el tráfico (y el intent nombra al viejo)', () => {
    const viejo = instalar(m, '0.18.0', 'sha256:v18')
    expect(m.run('promote', '0.18.0').code).toBe(0)
    const nuevo = instalar(m, '0.19.0', 'sha256:v19')
    // El candidato queda inhabilitado para tomar el control: su enfriamiento no vence en toda la
    // corrida. Es el fracaso del relevo, con el tráfico YA comprometido — el costo del flip-first.
    m.campo(nuevo, 'cooled_until', String(Math.floor(Date.now() / 1000) + 3600))

    const r = m.run('promote', '0.19.0', '--timeout', '3')
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/promoción ABORTADA en el handover/)
    expect(r.err).toMatch(/RETENIDO en la sala de espera/)
    // El borde volvió al viejo y el viejo volvió a servir.
    expect(m.activeCaddy()).toContain(`reverse_proxy ${viejo}:8080`)
    expect(m.fase(viejo)).toBe('serving')
    // El intent de la vuelta atrás nombró AL VIEJO (así re-adquiere sin pagar su ventana de gracia),
    // y al cerrar no quedó ninguno vivo.
    expect(m.intents().at(-1)).toContain(viejo)
    expect(m.intent()).toBe('')
    // El registro no cambió: sigue mandando el 0.18.0.
    expect(m.registro().active).toBe('0.18.0')
  })

  /**
   * EL ALIAS DEL NOMBRE RETIRADO (#290). `vergis-rollout` dejó de ser la herramienta y pasó a ser un
   * reenvío que AVISA. Se afirman las dos mitades, porque un alias que solo avisa —o que solo reenvía—
   * es peor que no tenerlo: el operador que lo invoca a mitad de un despliegue necesita el mismo
   * resultado Y enterarse de que el nombre cambió. El aviso va por STDERR: stdout es lo que un
   * `--json` entrega a quien lo parsea.
   */
  it('ALIAS RETIRADO: `vergis-rollout` avisa por stderr y reenvía a `botler-rollout`', () => {
    instalar(m, '0.19.0', 'sha256:v19')
    m.run('promote', '0.19.0')
    const canonico = m.run('status', '--json')
    const alias = spawnSync('sh', [TOOL_ALIAS, 'status', '--json'], { env: m.env, encoding: 'utf8' })
    expect(alias.status, alias.stderr).toBe(0)
    expect(alias.stderr).toContain('vergis-rollout: nombre retirado; usa botler-rollout')
    expect(alias.stdout).toBe(canonico.out)
    expect(JSON.parse(alias.stdout).active).toBe('0.19.0')
  })
})
