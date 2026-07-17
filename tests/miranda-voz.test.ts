import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, MIRANDA_VOICE, MIRANDA_HARD_RULES } from '@vergis/miranda'

// Plan 094 · WP2/WP3: la VOZ de negocio va al system prompt. Estos asserts fijan que la tabla de
// proyección y las prohibiciones estén presentes en el prompt ENSAMBLADO. (La voz REAL se valida en
// el smoke del arnés — WP5; acá solo garantizamos que la doctrina viaja en el prompt.)

describe('voz de negocio · prompt ensamblado', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('incluye la sección de VOZ', () => {
    expect(p).toContain(MIRANDA_VOICE)
    expect(p).toMatch(/lenguaje de NEGOCIO/i)
  })

  it('contiene la tabla de proyección nivel → frase de entrega (las 6 salidas)', () => {
    expect(p).toContain('al momento') // 1 gestionado
    expect(p).toContain('cuestión de horas') // 2 conectado
    expect(p).toContain('habilitar la conexión') // 3 conectable
    expect(p).toContain('quien lo maneja') // 4 alcanzable
    expect(p).toContain('trabajo de días') // 5 elicitable
    expect(p).toContain('no tengo identificada esa fuente') // 6 desconocido
  })

  it('fija las prohibiciones de la voz (identificadores, tools, personas, niveles)', () => {
    // No exponer nombres de vistas/tablas/tools/personas ni los nombres de los niveles.
    expect(p).toMatch(/dbo\.v_saldos/) // aparece como EJEMPLO de lo prohibido
    expect(p).toMatch(/run_probe|create_data_request/) // tools nombradas como prohibidas de exponer
    expect(p).toMatch(/NOMBRES de los niveles|taxonomía interna/i)
    expect(p).toMatch(/jamás «César», «Claude»/)
  })

  it('fija los matices: no-monotonicidad, dependencia de frescura, no-SLA, escotilla a demanda', () => {
    expect(p).toMatch(/NO es monótona/i)
    expect(p).toMatch(/DEPENDENCIA DE\s+FRESCURA/i)
    expect(p).toMatch(/no un SLA|no controlas el/i)
    expect(p).toMatch(/A DEMANDA/i)
  })

  it('la regla dura del catálogo está REFINADA: promete con ETA, «no» solo si no existe fuente', () => {
    expect(MIRANDA_HARD_RULES).toMatch(/EXPECTATIVA DE ENTREGA/)
    expect(MIRANDA_HARD_RULES).toMatch(/único «no» honesto/)
    expect(MIRANDA_HARD_RULES).not.toMatch(/Jamás prometas datos que 'catalog_tables' no respalde/)
  })
})

// Plan 099 · WP2: las tres reglas nuevas viajan en el prompt ENSAMBLADO. (El comportamiento real se
// valida en el smoke del arnés — WP5; acá solo garantizamos que la doctrina está en el prompt.)
describe('reglas del plan 099 · prompt ensamblado', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('regla 1 — el catálogo manda la promesa (una probe fallida no degrada la promesa)', () => {
    expect(MIRANDA_HARD_RULES).toMatch(/EL CATÁLOGO MANDA LA PROMESA/)
    expect(MIRANDA_HARD_RULES).toMatch(/JAMÁS evidencia para degradar la promesa/i)
    expect(p).toMatch(/EL CATÁLOGO MANDA LA PROMESA/)
  })

  it('regla 2 — no narrar diagnósticos internos (ni «noté que una vista no resolvía…»)', () => {
    expect(MIRANDA_VOICE).toMatch(/DIAGNÓSTICOS INTERNOS/)
    expect(MIRANDA_VOICE).toMatch(/no resolvía/i)
    expect(p).toMatch(/DIAGNÓSTICOS INTERNOS/)
  })

  it('regla 3 — decisión-raíz primero; la disponibilidad va como nota breve después; sin meta-preámbulos', () => {
    expect(p).toMatch(/DECISIÓN-RAÍZ PRIMERO/)
    expect(p).toMatch(/NOTA BREVE DESPUÉS/)
    expect(p).toMatch(/dos cosas que quiero\s+dejarte claras/i) // el meta-preámbulo, citado como prohibido
  })
})
