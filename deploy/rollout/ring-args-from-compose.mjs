#!/usr/bin/env node
// ring-args-from-compose.mjs — DERIVA `rings/ring.args` del servicio del nodo en el compose VIVO, en vez
// de escribirlo a mano.
//
// `ring.args` son los argumentos de `docker create` con que `botler-rollout install` crea cada anillo: la
// misma lista de envs y montajes que el servicio del nodo en el compose. Escrita a mano es un espejo
// que nada verifica — un env o un montaje que cambie en el compose no llega a los anillos nuevos, y el
// anillo arranca con otro contrato que el que el operador cree. Este generador cierra ese hueco por
// construcción: el archivo se GENERA desde el compose que corre, así que lo que cambia allá aparece acá
// al regenerar, y el diff contra el vigente ES la verificación.
//
// Viaja en la imagen (`/app/deploy/rollout/`, con su sha en el label `vergis.rollout.sha256`), así que la
// versión del generador es la de la imagen que se va a instalar, y el host no necesita `node`:
//
//   docker compose -p <proyecto> [--profile <p>…] config --no-env-resolution --format json \
//     | docker run --rm -i --entrypoint node ghcr.io/gegolabs/vergis:<versión> \
//         /app/deploy/rollout/ring-args-from-compose.mjs --host-root <raíz de la instalación> > rings/ring.args.new
//   diff rings/ring.args rings/ring.args.new
//
// (o, con el plugin `vergis`: `vergis-ops exec rollout ring-args [<versión>] [--apply]`).
//
// Opciones: --host-root <ruta> (OBLIGATORIA: dónde vive la instalación en el host) · --service <nombre>
// (default `vergis`) · --memory <límite> (si el servicio no declara `mem_limit`; default `1g`, el
// presupuesto por nodo que declara el Producto en `ring.args.example`).
//
// `--no-env-resolution` es obligatorio: sin él, `compose config` INLINEA el contenido de los `env_file`
// (secretos) dentro de `environment`, y `ring.args` terminaría con secretos en claro. Con el flag, el
// env_file queda como referencia y acá sale como `--env-file <ruta>`. Como red de seguridad, un
// `environment` con una clave que parece secreto aborta.
//
// Lo que NO pone (lo pone `botler-rollout` y es la identidad del anillo): `--name`, `--label vergis.ring*`,
// `-e VERGIS_RING`, `-e VERGIS_RING_DIGEST`.
//
// Códigos de salida: 0 generado · 2 uso o entrada inválida (no se genera nada a medias).

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
function opt(name, def) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
function die(msg) {
  process.stderr.write(`ring-args-from-compose: ${msg}\n`)
  process.exit(2)
}

const HOST_ROOT = (opt('--host-root', '') ?? '').replace(/\/$/, '')
if (!HOST_ROOT.startsWith('/')) die('falta --host-root <ruta absoluta de la instalación en el host>')
const SERVICE = opt('--service', 'vergis')

let doc
try {
  doc = JSON.parse(readFileSync(0, 'utf8'))
} catch (e) {
  die(`entrada inválida: se esperaba el JSON de 'docker compose config --format json' por stdin (${e.message})`)
}
const svc = doc?.services?.[SERVICE]
if (!svc) die(`el compose no declara el servicio '${SERVICE}' (¿falta --profile en compose config?)`)
const project = doc.name
if (!project) die('el compose no trae nombre de proyecto: pasa -p <proyecto> a compose config')

// La raíz del proyecto en la máquina donde se corrió `compose config`: compose resuelve los binds a rutas
// absolutas de ESA máquina. Se toma del directorio de trabajo del proyecto si compose lo declara, o del
// primer env_file (vive junto al compose), y se rebasa a HOST_ROOT. En el host mismo la rebase es identidad.
const envFiles = (svc.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path))
const localRoot = doc['x-project-dir'] ?? (envFiles[0] ? dirname(envFiles[0]) : HOST_ROOT)
const rebase = (p) => (p.startsWith(localRoot + '/') || p === localRoot ? HOST_ROOT + p.slice(localRoot.length) : p)

const env = svc.environment ?? {}
if (Array.isArray(env)) die('environment vino como lista; se esperaba mapa (compose config normaliza a mapa)')
for (const k of Object.keys(env)) {
  if (/SECRET|TOKEN|PASSWORD|PASSWD|CONNECTIONS|WEBHOOK|API_KEY|PRIVATE/.test(k) && !k.endsWith('_FILE')) {
    die(`ABORTADO: '${k}' aparece en environment y parece un secreto — ¿se corrió compose config sin --no-env-resolution? Un secreto va por env_file, jamás a ring.args`)
  }
}
for (const k of ['VERGIS_RING', 'VERGIS_RING_DIGEST']) delete env[k]
if (!('VERGIS_CONTROL' in env)) env.VERGIS_CONTROL = 'lease' // explícito: con dos anillos, `single` serían dos escritores
if (env.VERGIS_CONTROL !== 'lease') die(`ABORTADO: VERGIS_CONTROL='${env.VERGIS_CONTROL}' — con anillos tiene que ser 'lease'`)

const memory = svc.mem_limit ?? svc.deploy?.resources?.limits?.memory ?? opt('--memory', '1g')
const network = Object.keys(svc.networks ?? {})[0]
const networkName = network ? (doc.networks?.[network]?.name ?? `${project}_${network}`) : `${project}_default`

const out = []
out.push(`# rings/ring.args — GENERADO por deploy/rollout/ring-args-from-compose.mjs desde el servicio '${SERVICE}'`)
out.push(`# del proyecto compose '${project}'. NO editar a mano: regenerar y diffear. Un argumento por línea.`)
out.push(`# Generado: ${new Date().toISOString()}`)
out.push('')
out.push('# --- Red e integración con el stack ---')
out.push('--network', networkName)
out.push('--restart', svc.restart ?? 'unless-stopped')
out.push('--init')
out.push('--memory', String(memory))
out.push('--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3')
if (envFiles.length) {
  out.push('')
  out.push('# --- Secretos de la instancia (JAMÁS en git) ---')
  for (const f of envFiles) out.push('--env-file', rebase(f))
}
out.push('')
out.push('# --- Envs del contrato Producto→Infra (derivados del compose) ---')
for (const k of Object.keys(env).sort()) {
  const v = env[k]
  if (v === null || v === undefined) continue
  out.push('-e', `${k}=${v}`)
}
out.push('')
out.push('# --- Montajes de la instancia (los mismos del compose, rutas absolutas del host) ---')
let outMounted = false
for (const v of svc.volumes ?? []) {
  if (v.type !== 'bind' && v.type !== 'volume') die(`ABORTADO: el montaje '${v.source ?? '?'}→${v.target}' es de tipo '${v.type}'`)
  const ro = v.read_only ? ':ro' : ''
  const src = v.type === 'bind' ? rebase(v.source) : (doc.volumes?.[v.source]?.name ?? `${project}_${v.source}`)
  out.push('-v', `${src}:${v.target}${ro}`)
  if (env.VERGIS_OUT && v.target === env.VERGIS_OUT && !v.read_only) outMounted = true
}
if (env.VERGIS_OUT && !outMounted) die(`ABORTADO: VERGIS_OUT (${env.VERGIS_OUT}) no está montado en escritura — el lease y los stores viven ahí`)
process.stdout.write(out.join('\n') + '\n')
