/**
 * Utilidades del port de `server.py` — **calcadas del comportamiento de Python**, no del repo.
 *
 * `esc` NO es `escapeHtml` de `@vergis/capabilities`: aquélla emite `&#39;` para la comilla simple y
 * `html.escape` de Python emite `&#x27;`. La paridad de `report`/`print` se mide byte a byte contra
 * la salida del Python (tests/fixtures/daftar/esperado), así que el escape tiene que ser el suyo.
 */

/** `html.escape(s, quote=True)` de Python, exactamente. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * `round(x, nd)` de Python: redondeo CORRECTO sobre el valor binario, con desempate al par
 * (banker's rounding). `toFixed` de JS redondea el medio hacia arriba, así que `round(5.25, 1)` daría
 * 5.3 donde Python da 5.2 — y las notas del reporte salen justo de ahí (`pct * 7 / 100`).
 *
 * El desempate se decide sobre la EXPANSIÓN DECIMAL DEL DOUBLE (`toFixed(20)`), no sobre la
 * representación corta: `5.35` como double es 5.3499999…, así que Python devuelve 5.3 aunque el
 * literal parezca un empate. Mirar el literal daría 5.4.
 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x
  const neg = x < 0
  const exacto = Math.abs(x).toFixed(20) // expansión decimal del double, sin empates falsos
  const [ent, dec = ''] = exacto.split('.')
  const corte = dec.slice(0, nd)
  const resto = dec.slice(nd)
  let digitos = `${ent}${corte}`
  const primero = resto[0] ?? '0'
  const hayMas = /[1-9]/.test(resto.slice(1))
  const ultimo = Number(digitos[digitos.length - 1] ?? '0')
  const subir = primero > '5' || (primero === '5' && (hayMas || ultimo % 2 === 1))
  if (subir) digitos = String(BigInt(digitos) + 1n).padStart(digitos.length, '0')
  const v = nd === 0 ? Number(digitos) : Number(`${digitos.slice(0, digitos.length - nd) || '0'}.${digitos.slice(digitos.length - nd)}`)
  return neg ? -v : v
}

/**
 * `str(float)` de Python: un flotante SIEMPRE lleva parte decimal. `round(0*7/100, 1)` da `0.0` y el
 * f-string imprime «nota 0.0»; `String(0)` en JS da «0». Es la única diferencia que la paridad de los
 * 38 casos encontró, y sale justo en el reporte de una guía sin puntaje.
 */
export function pyFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

/** `f"{n:02d}"` de Python. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
