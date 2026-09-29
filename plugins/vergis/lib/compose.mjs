// compose.mjs — lectura MÍNIMA de un compose espejado, sin dependencias.
//
// No es un parser de YAML: extrae tres cosas con reglas de sangría que el compose de referencia del
// Producto cumple (dos espacios por nivel): los nombres de servicio, la línea `image:` de cada uno, y
// los montajes del host (binds relativos, binds bajo la raíz de la instalación, `env_file`, `context`).
// Si un compose no calza con esas reglas, lo que devuelve es MENOS, nunca inventado — y los que lo
// consumen (check, G1) lo dicen en vez de aprobar por omisión.

export function composeServices(text) {
  const lines = text.split(/\r?\n/)
  const services = {}
  let inServices = false
  let cur = null
  for (const ln of lines) {
    if (/^\S/.test(ln) && !ln.startsWith('#')) {
      inServices = /^services:\s*(#.*)?$/.test(ln)
      cur = null
      continue
    }
    if (!inServices) continue
    const m = /^ {2}([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(ln)
    if (m) {
      cur = m[1]
      services[cur] = { image: null, profiles: [] }
      continue
    }
    if (!cur) continue
    const im = /^ {4}image:\s*["']?([^"'\s#]+)/.exec(ln)
    if (im) services[cur].image = im[1]
    const pr = /^ {4}profiles:\s*\[([^\]]*)\]/.exec(ln)
    if (pr) services[cur].profiles = pr[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  return services
}

/** ¿El tag de la imagen es móvil? (`latest`, `main`, sin tag, o una serie `X.Y`). */
export function movableTag(image) {
  if (!image) return null
  if (image.includes('@sha256:')) return null
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  const tag = colon > slash ? image.slice(colon + 1) : ''
  if (!tag) return 'sin tag (implica latest)'
  if (tag === 'latest' || tag === 'main') return tag
  if (/^\d+(\.\d+)?$/.test(tag)) return `serie ${tag}`
  return null
}

/**
 * Montajes del host que declara el compose, como PRIMER componente relativo a la raíz de la
 * instalación: `./specs:/specs:ro` → `specs`; `/opt/x/rings:/r` con raíz `/opt/x` → `rings`;
 * `env_file: [a.env]` → `a.env` (marcado `secret`); `context: ./relay` → `relay`.
 */
export function composeMounts(text, hostRoot) {
  const out = []
  const root = hostRoot.replace(/\/$/, '')
  let envListIndent = -1 // dentro de un `env_file:` en forma de lista, la sangría de su clave
  for (const ln of text.split(/\r?\n/)) {
    if (/^\s*#/.test(ln) || !ln.trim()) continue
    const indent = ln.length - ln.trimStart().length
    if (envListIndent >= 0) {
      const li = /^\s*-\s*["']?(?:\.\/)?([^"'\s#]+)/.exec(ln)
      if (li && indent > envListIndent) {
        out.push({ path: li[1].split('/')[0], full: li[1], secret: true })
        continue
      }
      envListIndent = -1
    }
    if (/^\s*env_file:\s*(#.*)?$/.test(ln)) {
      envListIndent = indent
      continue
    }
    let m = /^\s*-\s*["']?\.\/([^:"'\s]+)[:"']/.exec(ln)
    if (m) { out.push({ path: m[1].split('/')[0], full: m[1], secret: false }); continue }
    m = /^\s*-\s*["']?(\/[^:"'\s]+)[:"']/.exec(ln)
    if (m && (m[1] === root || m[1].startsWith(root + '/'))) {
      const rel = m[1].slice(root.length + 1)
      if (rel) out.push({ path: rel.split('/')[0], full: rel, secret: false })
      continue
    }
    m = /env_file:\s*(.*)$/.exec(ln)
    if (m) {
      for (const f of m[1].replace(/#.*$/, '').replace(/[[\],]/g, ' ').split(/\s+/)) {
        const t = f.replace(/^["']|["']$/g, '').replace(/^\.\//, '')
        if (t) out.push({ path: t.split('/')[0], full: t, secret: true })
      }
      continue
    }
    m = /^\s*context:\s*["']?\.\/([^"'\s#]+)/.exec(ln)
    if (m) out.push({ path: m[1].split('/')[0], full: m[1], secret: false })
  }
  const seen = new Set()
  return out.filter((x) => (seen.has(x.full) ? false : (seen.add(x.full), true)))
}
