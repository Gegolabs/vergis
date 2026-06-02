// Frescura de grano DIARIO (watermark solo-fecha): la antigüedad se mide en DÍAS DE CALENDARIO en la
// zona de negocio, no en ms UTC. Cementa el fix del falso positivo (un snapshot de HOY = 0 días).
import { describe, it, expect } from 'vitest'
import { checkFreshness } from '@vergis/mira'

const mkSpec = (freshness: Record<string, unknown>) =>
  ({
    mira_version: '1.0',
    identity: { id: 'x', display_name: 'x', classification: 'confidential' },
    piece: {},
    data: { meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha_dato: 'date' } } } },
    quality: { freshness },
    delivery: {},
  }) as unknown as Parameters<typeof checkFreshness>[0]

const results = (fecha: string) => ({ meta: { rows: [{ fecha_dato: fecha }] } }) as unknown as Parameters<typeof checkFreshness>[1]

const FRESH = { source_watermark: 'required', max_age: 'P1D', watermark_field: 'meta.fecha_dato', timezone: 'America/Santiago' }
// 2026-06-02T00:06Z = 1 jun 20:06 en Chile (UTC−4) → el día de negocio sigue siendo el 1 de junio.
const nowEveningJun1Chile = Date.parse('2026-06-02T00:06:00Z')

describe('Frescura · watermark de grano diario (días de calendario, zona de negocio)', () => {
  it('snapshot de HOY (zona Chile) → fresco, antigüedad "hoy", no stale', () => {
    const v = checkFreshness(mkSpec(FRESH), results('2026-06-01'), nowEveningJun1Chile)
    expect(v.stale).toBe(false)
    expect(v.ageHuman).toBe('hoy')
  })
  it('snapshot de hace 2 días → stale', () => {
    const v = checkFreshness(mkSpec(FRESH), results('2026-05-30'), nowEveningJun1Chile)
    expect(v.stale).toBe(true)
    expect(v.ageHuman).toBe('2 días')
  })
  it('SIN timezone (default UTC): días-de-calendario igual evita el falso positivo (1 día ≤ P1D, no stale); el TZ solo afina la etiqueta a "hoy"', () => {
    const v = checkFreshness(mkSpec({ ...FRESH, timezone: undefined }), results('2026-06-01'), nowEveningJun1Chile)
    expect(v.stale).toBe(false) // en UTC ya es 2-jun → 1 día, pero 1 ≤ P1D → NO stale (el ms-based viejo sí fallaba)
    expect(v.ageHuman).toBe('1 día') // con TZ Chile sería "hoy"
  })
})
