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

  it('regla 3 — decisión-raíz primero (condicionada por plan 100); la disponibilidad va como nota breve después; sin meta-preámbulos', () => {
    expect(p).toMatch(/DECISIÓN-RAÍZ PRIMERO/)
    expect(p).toMatch(/NOTA\s+BREVE \(≤2 líneas\) DESPUÉS/) // plan 100 detalló la nota (≤2 líneas)
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

// Plan 100 · entrega-primero: el mayordomo sirve el default servible en el mismo turno (hasta preview
// por el riel RLS) en vez de negociar alcance; la decisión-raíz queda condicionada a lo no servible; la
// voz cierra las fugas de vocabulario de método y las paráfrasis de maquinaria, y exige valor por turno.
describe('reglas del plan 100 · prompt ensamblado', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('ELICITATION contiene ENTREGA-PRIMERO (servible → mismo turno hasta preview)', () => {
    expect(p).toMatch(/ENTREGA-PRIMERO/)
    expect(p).toMatch(/render_preview/)
    expect(p).toMatch(/permiso previo para arrancar/i)
  })

  it('ELICITATION no delega las decisiones operativas (subconjunto/orden), solo eleva las de dominio', () => {
    expect(p).toMatch(/DECISIONES OPERATIVAS NO SE DELEGAN/)
    expect(p).toMatch(/decisiones de DOMINIO/)
  })

  it('ELICITATION deja la DECISIÓN-RAÍZ PRIMERO condicionada a que NADA sea servible', () => {
    expect(p).toMatch(/DECISIÓN-RAÍZ PRIMERO \(CONDICIONADA\)/)
    expect(p).toMatch(/cuando NADA es servible/i)
    expect(p).toMatch(/niveles 3–6/)
  })

  it('ELICITATION mantiene el gate de publish tras validación explícita del usuario', () => {
    expect(p).toMatch(/PUBLICAR NO CAMBIA/)
    expect(p).toMatch(/validación EXPLÍCITA del usuario/)
    expect(p).toMatch(/NUNCA publica solo/)
  })

  it('addendum — la database_ref sale de la entrada de catálogo, jamás de ejemplos del DSL', () => {
    expect(p).toMatch(/database_ref de cada dataset sale de la ENTRADA DE CATÁLOGO/)
    expect(p).toMatch(/JAMÁS de un ejemplo del\s+documento DSL/)
  })

  it('VOZ prohíbe el vocabulario de método interno («decisión raíz», «self-check», …)', () => {
    expect(MIRANDA_VOICE).toMatch(/VOCABULARIO DE MÉTODO INTERNO/)
    expect(MIRANDA_VOICE).toMatch(/«decisión raíz»/)
    expect(MIRANDA_VOICE).toMatch(/«self-check»/)
  })

  it('VOZ prohíbe las paráfrasis de maquinaria con el test operativo', () => {
    expect(MIRANDA_VOICE).toMatch(/PARÁFRASIS DE MAQUINARIA/)
    expect(MIRANDA_VOICE).toMatch(/la capa que alimenta los reportes/)
    expect(MIRANDA_VOICE).toMatch(/TEST OPERATIVO/)
    expect(MIRANDA_VOICE).toMatch(/DISPONIBILIDAD\s+NETA/)
  })

  it('VOZ exige valor por turno (algo en la mano del usuario; prohibido solo-negociar)', () => {
    expect(MIRANDA_VOICE).toMatch(/VALOR POR TURNO/)
    expect(MIRANDA_VOICE).toMatch(/EN LA MANO del usuario/)
  })
})

// Plan 102 · Etapa D: el prompt instruye la estructura lead + notas (marcador [[NOTAS]]) y prohíbe
// enumerar en prosa lo que el reporte ya muestra (el lienzo es la evidencia).
describe('prompt · estructura lead + notas (plan 102 etapa D)', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('instruye el LEAD corto y las NOTAS a demanda con el marcador [[NOTAS]]', () => {
    expect(p).toMatch(/ESTRUCTURA DE TU RESPUESTA \(lead \+ notas\)/)
    expect(p).toMatch(/LEAD corto/)
    expect(p).toMatch(/\[\[NOTAS\]\]/)
  })

  it('prohíbe enumerar en prosa lo que el reporte ya muestra (el lienzo es la evidencia)', () => {
    expect(p).toMatch(/NO ENUMERES EN PROSA\s+lo que el reporte ya muestra/)
    expect(p).toMatch(/el reporte está a la vista en el lienzo/)
  })

  it('el usuario NUNCA ve el marcador (la UI lo vuelve «Alcance y notas»)', () => {
    expect(p).toMatch(/El\s+usuario NUNCA ve ese marcador/)
    expect(p).toMatch(/Alcance y notas/)
  })
})

// Plan 103 · Etapa 3: bugs de camino de contenido/voz atacados por el prompt.
describe('prompt · bugs de camino (plan 103 etapa 3)', () => {
  const p = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })

  it('menos auto-narración: prohíbe el play-by-play del proceso en el chat', () => {
    expect(p).toMatch(/NO NARRES TU PROCESO PASO A PASO/)
    expect(p).toMatch(/ahora corro la verificación de calidad/)
    expect(p).toMatch(/indicador de progreso/)
  })

  it('refuerzo anti-«dwh»: la database_ref sale EXACTA del catálogo, jamás inventada', () => {
    expect(p).toMatch(/NUNCA INVENTES una\s+ref/)
    expect(p).toMatch(/«dwh»/)
    expect(p).toMatch(/valor EXACTO del campo/)
  })

  it('texto plano en el contenido del reporte (el renderer del PI no interpreta markdown de énfasis)', () => {
    expect(p).toMatch(/TEXTO PLANO en el contenido del REPORTE/)
    expect(p).toMatch(/sin\s+guiones bajos ni asteriscos de énfasis/)
  })
})
