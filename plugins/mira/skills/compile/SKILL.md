---
description: Compilar una especificación técnico-funcional escrita por un consultor al spec DSL de un Producto de Información del Botlet Mira, con cada bloque trazado a la sección de la que sale, o devolver errores al especificador; no especifica conversando (mira:specify: compile no propone), no valida (mira:validate) ni especializa EN la instalación (mira:specialize). Usa el motor de Miranda en modo documento, no lo copia. Hoy responde «no disponible», porque Miranda aún no acepta documentos (#389). Usar cuando llegue o cambie una especificación técnico-funcional de un PI, o se pida «compila la especificación», «pasa este documento a spec».
argument-hint: "<especificación técnico-funcional> [--installation <id>]"
---

# mira:compile — de la especificación escrita al spec DSL

Mira es un Botlet del catálogo: su plugin opera el ciclo del spec de cada Producto de Información (PI). Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`).

## ¿Qué hace, cuando el Producto lo soporte?

| Entrada | Salida | Clase del acto |
|--|--|--|
| Una especificación técnico-funcional escrita por un consultor | El spec DSL, con **cada bloque trazado a la sección** de la especificación de la que sale — o **errores** que vuelven al especificador | `read` |

**`compile` no decide.** Un vacío o una ambigüedad de la especificación (un indicador sin fórmula, un filtro sin dominio, una fuente sin nombre) es un **error que vuelve al especificador**, jamás un supuesto del agente. Compilar no es proponer: proponer y dejar que la persona decida es `mira:specify`.

**Usa el motor de Miranda, no lo copia.** Miranda es el agente de especificación de Mira en el nodo: conoce el DSL, el catálogo de datos y sondea el dato por el riel con RLS. Una skill que enseñara a Claude Code a escribir specs por su cuenta duplicaría ese conocimiento y sondearía el dato por fuera del riel.

## ¿Qué responde hoy?

Miranda solo conversa: no acepta un documento como entrada (#389). Hasta que tenga el modo documento, esta skill responde, con estas palabras, y se detiene:

> **«No disponible.»** Miranda aún no acepta una especificación como documento (#389). No escribo el spec con el conocimiento propio del agente. Mientras tanto, el camino es `mira:specify`, conversando con Miranda en el nodo.

No se simula: **no se escribe el spec a mano** desde esta skill, ni se presenta como compilado un spec redactado por el agente.

## ¿Qué no hace esta skill?

- No propone ni decide (→ **mira:specify**). No valida (→ **mira:validate**). No publica (→ **mira:specialize**).
- No crea Conectores ni fuentes: un `database_ref` que la instalación no declara es un error de la especificación o un pedido a `vergis:connect`.

• *Generado con Wingworking*
