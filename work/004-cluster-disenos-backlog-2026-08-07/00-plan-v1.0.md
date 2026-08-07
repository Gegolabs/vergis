# 004 · Plan del cluster — diseño detallado de TODO el backlog (2026-08-07)

**Mandato de César:** diseñar en detalle, con subagentes Fable en paralelo, todas las piezas vivas del backlog público — incluidas las que hoy no se pueden implementar: su diseño se hace **previsor**, sellado con el disparador que lo destranca.

## Reglas compartidas de todos los frentes (parte del brief de cada diseñador)

1. **Eres Fable diseñando; NO implementas.** Tu producto es UN documento de diseño en la ruta exacta asignada. No tocas código, no tocas archivos existentes, no editas `INDEX.md`, no haces commits ni push.
2. **Norma 6 (Ley de Wingworking):** toda afirmación fáctica sobre el estado actual del código se verifica leyendo el código ANTES de escribirla, y se ancla (`archivo:línea`). Lo no verificado se etiqueta «conjetura». El repo está en tu cwd; el issue se lee con `gh issue view N --repo Gegolabs/vergis --comments` (exporta `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` en cada comando bash).
3. **Criterio de excelencia (ww:wingcoding Regla 1):** se diseña el camino ideal, como si nada estuviera implementado; lo construido es dato de planificación, no argumento de corrección.
4. **Estructura exigida del documento:**
   - **Estado actual verificado** — qué existe hoy, con anclas.
   - **Decisiones selladas con racional** — numeradas D1, D2… Si una decisión le pertenece a César (contratos de despliegue, gasto, alcance de terceros), se sella una **propuesta recomendada** marcada `[propuesta — revocable por César]` con la alternativa descartada.
   - **Arquitectura y contratos** — módulos, shapes, rutas, semánticas de error, autorización.
   - **Plan de construcción** — hitos con territorio de archivos, «hecho cuando» verificable por comando, y el juez (gates). Elaborado hasta ser ejecutable por un Opus en frío.
   - **Destranque** *(solo frentes diferidos)* — qué evento habilita construir esto, y qué partes del diseño son sensibles a envejecer mientras tanto (qué re-verificar al destrabar).
   - **Riesgos y no-metas.**
5. **Nivel de detalle por horizonte:** frentes implementables → contrato ejecutable completo; frentes de largo plazo (#113) → arquitectura decidida (contratos y cortes de módulos) + primer hito ejecutable, sin fingir precisión sobre terreno que va a moverse — decláralo donde aplique.
6. **Versionado:** `v1.0`, pie de autoría `• 🤖 Claude (Fable) · diseño del frente <id> · cluster 004`.

## Frentes

| Doc | Frente | Origen | Horizonte |
|---|---|---|---|
| `01-139-n2-delta-contrato` | Delta del contrato operativo entre versiones | #139 N2 | Implementable |
| `02-139-n3-miranda-contrato` | Miranda responde con el contrato de su versión | #139 N3 | Diferido (scope Miranda) |
| `03-138-2-config-recargable` | Config de arranque → vía recargable (elabora `work/003-…/03-…`) | #138·2 | Espera OK de César |
| `04-107-f2-publicacion-jobs` | Publicar definiciones de jobs en el motor desde Vergis | #107 fase 2 | Gate humano (API tenant) |
| `05-111-rubrica-convenciones` | Catálogo de convenciones como tercera rúbrica de Miranda | #111 | Diferido (≥2 casos) |
| `06-110-miranda-post-f1` | Piezas post-F1 de Miranda (preview RLS 2 identidades · probes multi-DB · webhook · scope) | #110 | Diferido (por pieza) |
| `07-113-realtime` | Botler persistente + SSE | #113 | Largo plazo |
| `08-113-canales-salida` | Email y Slack como destinos de primera clase | #113 (cruza #100/#102) | Largo plazo |
| `09-113-execute-sql-local` | Motor local para desarrollo y pruebas | #113 | Largo plazo |
| `10-113-hardening` | Endurecimiento del despliegue como fase propia | #113 | Largo plazo |
| `11-113-open-core` | Corte núcleo abierto / no abierto | #113 | Largo plazo |

## Integración

La sesión (Fable orquestador) revisa cada diseño contra el checklist, cruza los que se tocan (01↔02, 03↔01 por la clasificación de env, 06↔02 y 06↔05 por Miranda, 08↔06 por webhook/canales), corrige o devuelve, registra en `INDEX.md` y commitea el cluster. Los issues reciben el puntero a su diseño con las decisiones de César enumeradas. **Nada de este cluster se implementa en esta sesión.**

---
• 🤖 Claude (Fable) · cluster 004
