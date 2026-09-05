/**
 * EL FRONTEND EMBEBIDO (H3 · §3.6). Tres cosas que fallan mudas si nadie las mide:
 *
 *  1. un `fetch("/api/…")` absoluto que quedó sin `BASE` — funciona en el Daftar viejo (que servía en
 *     la raíz) y en el Let devuelve el 404 del NODO, sin error visible en la consola del alumno;
 *  2. el `assets.json` empaquetado quedándose atrás del asset editable;
 *  3. el shell perdiendo la costura que inyecta el CSS y el JS — un SPA en blanco.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderShell, APP_JS, STYLE_CSS, INDEX_HTML } from '@vergis/daftar'
import { jsonDeAssets, ASSETS_JSON, ASSETS_DIR } from '../scripts/daftar-assets'
import { join } from 'node:path'

describe('daftar · frontend', () => {
  it('ningún `fetch` absoluto a `/api`: todos pasan por BASE', () => {
    const sospechosos = [...APP_JS.matchAll(/fetch\(\s*(["'`])\/api[^)]*/g)].map((m) => m[0])
    expect(sospechosos).toEqual([])
  })

  it('los enlaces a `report/` y `print/` también llevan BASE', () => {
    expect(APP_JS).not.toMatch(/href="\/print\//)
    expect(APP_JS).not.toMatch(/`\/report\//)
    expect(APP_JS).toContain('${BASE}/print/')
    expect(APP_JS).toContain('${BASE}/report/')
  })

  it('los únicos fetch absolutos que quedan son los de ultraGO (el modo foco, que no se toca)', () => {
    const absolutos = [...APP_JS.matchAll(/fetch\(\s*[`"']([^`"'$]*)/g)].map((m) => m[1]!).filter((u) => u.startsWith('/'))
    expect(absolutos).toEqual([])
    expect(APP_JS).toContain('ULTRAGO_FOCUS_URL')
  })

  it('`?s=` ya no decide quién eres: el estudiante viene del nodo', () => {
    expect(APP_JS).toContain('window.__DAFTAR__')
    expect(APP_JS).not.toMatch(/const STUDENT = new URLSearchParams/)
  })

  it('el shell inyecta `__DAFTAR__` ANTES del app.js y embebe los tres assets', () => {
    const html = renderShell({ base: '/estudios', student: 'matias', admin: false, students: { matias: { name: 'M', grade: '4°' } } })
    expect(html).toContain('window.__DAFTAR__ = {"base":"/estudios","student":"matias","admin":false')
    expect(html.indexOf('__DAFTAR__')).toBeLessThan(html.indexOf('DOMContentLoaded'))
    expect(html).toContain(STYLE_CSS)
    expect(html).toContain(APP_JS)
    expect(html).not.toContain('<link rel="stylesheet" href="style.css">')
    expect(html).not.toContain('<script src="app.js"></script>')
  })

  it('un `</script>` dentro de los datos no cierra el bloque del bootstrap', () => {
    const html = renderShell({ base: '/x', student: null, admin: true, students: { a: { name: '</script><script>alert(1)', grade: '' } } })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('<\\/script>')
  })

  it('el shell LANZA si `index.html` perdió la costura (mejor un error que un SPA en blanco)', () => {
    expect(INDEX_HTML).toContain('<link rel="stylesheet" href="style.css">')
    expect(INDEX_HTML).toContain('<script src="app.js"></script>')
  })

  it('`assets.json` está al día con los tres archivos editables (si no: `npm run daftar:assets`)', () => {
    expect(readFileSync(ASSETS_JSON, 'utf8')).toBe(jsonDeAssets())
    expect(APP_JS).toBe(readFileSync(join(ASSETS_DIR, 'app.js'), 'utf8'))
  })
})
