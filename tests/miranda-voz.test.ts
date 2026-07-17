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

// Refinamiento de voz sobre 0.14.0 (batería del coordinador): Miranda no nombra sus artefactos ni
// procesos internos al usuario («el catálogo», «la capa de datos», «la spec», «exploré…») — habla del
// CONTENIDO, no del contenedor, y abre con la sustancia. El mundo del USUARIO («tu sistema contable»)
// sigue siendo lenguaje de negocio legítimo (no sobre-prohibir).
describe('voz · artefactos y procesos internos NO se nombran (refinamiento 099)', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('la regla viaja en MIRANDA_VOICE y en el prompt ensamblado', () => {
    expect(MIRANDA_VOICE).toMatch(/TUS ARTEFACTOS Y PROCESOS INTERNOS/)
    expect(p).toMatch(/TUS ARTEFACTOS Y PROCESOS INTERNOS/)
  })

  it('cita los contenedores prohibidos: «el catálogo», «la capa de datos», «la spec», «la ficha»', () => {
    expect(MIRANDA_VOICE).toMatch(/«el catálogo»/)
    expect(MIRANDA_VOICE).toMatch(/«la capa\s+de datos»/)
    expect(MIRANDA_VOICE).toMatch(/«la spec»/)
    expect(MIRANDA_VOICE).toMatch(/«la ficha»/)
  })

  it('manda contenido-no-contenedor con las sustituciones ejemplares', () => {
    expect(MIRANDA_VOICE).toMatch(/CONTENIDO, no del\s+contenedor/i)
    expect(MIRANDA_VOICE).toMatch(/la información que tenemos/)
    expect(MIRANDA_VOICE).toMatch(/los datos de ventas/)
  })

  it('prohíbe abrir narrando el propio proceso («exploré el catálogo…») y manda abrir con la sustancia', () => {
    expect(MIRANDA_VOICE).toMatch(/JAMÁS abras\s+narrando/i)
    expect(MIRANDA_VOICE).toMatch(/exploré el catálogo/)
    expect(MIRANDA_VOICE).toMatch(/abre con la SUSTANCIA/i)
  })

  it('NO sobre-prohíbe: el mundo del usuario («tu sistema contable», la planilla del equipo) sigue legítimo', () => {
    expect(MIRANDA_VOICE).toMatch(/tu sistema contable/)
    expect(MIRANDA_VOICE).toMatch(/planilla que mantiene tu\s+equipo/)
    expect(MIRANDA_VOICE).toMatch(/lenguaje de negocio legítimo/i)
  })
})
