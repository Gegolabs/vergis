---
description: Compilar las políticas de acceso al dato (YAML) que el dueño del gobierno del dato ya decidió al DDL de RLS de la fuente, como artefacto local; no decide políticas (custos no tiene specify: crear una es del dueño del gobierno del dato), no las valida (custos:validate) y no las hace valer EN la instalación (custos:enforce). Ante una ambigüedad del YAML devuelve un error a su autor, jamás un supuesto. Hoy responde «no pude compilar desde el YAML», porque el Producto aún no compila el DDL desde las políticas (#390). Usar cuando cambie una política que el dueño ya decidió y haya que llevarla a la fuente, o se pida «compila la policy», «genera el DDL de RLS».
argument-hint: "<archivo de políticas> [--installation <id>]"
---

# custos:compile — de la política decidida al DDL de la fuente

**Custos gobierna el dato**: quién ve qué dato, quién pertenece a qué grupo, quién responde por qué dato. Lo que gobierna tiene dueño propio —el responsable del gobierno del dato, no el operador de la plataforma—, y por eso vive en su propio plugin. Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`).

## ¿Qué hace, cuando el Producto lo soporte?

| Entrada | Salida | Clase del acto |
|--|--|--|
| Las políticas YAML de la instalación | El DDL de RLS para la fuente, como archivo local | `read`: produce un artefacto local, no toca nada |

**`compile` no adivina.** Cada predicado del DDL sale de una regla del YAML. Un vacío o una ambigüedad (una tabla sin regla, un grupo que no existe, dos reglas que se contradicen) es un **error que vuelve al dueño del gobierno del dato**, jamás un supuesto del agente. Y **no decide**: crear o cambiar una política es del dueño; esta skill compila lo que él decidió.

## ¿Qué responde hoy?

El Producto no compila todavía el DDL desde el YAML (#390): el único camino disponible regenera el DDL desde el **inventario vivo** de la fuente, que no es compilar lo decidido sino copiar lo que ya está. Hasta que exista, esta skill responde, con estas palabras, y se detiene:

> **«No pude compilar desde el YAML.»** El Producto aún no compila las políticas al DDL de la fuente (#390). No genero el DDL a mano: sería un supuesto del agente sobre lo que el dueño del gobierno decidió.

No se simula: **no se escribe DDL con el conocimiento propio del agente**, ni se presenta como compilado un DDL regenerado desde la fuente viva.

## ¿Qué no hace esta skill?

- No decide ni redacta políticas: es del dueño del gobierno del dato.
- No valida (→ **custos:validate**), no aplica (→ **custos:enforce**), no verifica (→ **custos:verify**).

• *Generado con Wingworking*
