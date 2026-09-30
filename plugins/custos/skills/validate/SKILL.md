---
description: Validar una política de acceso al dato ANTES de hacerla valer EN la instalación —el DDL compilado, contra la fuente viva—, con tres veredictos: acepta, rechaza (una tabla viva con predicado queda fuera del DDL) o no pude medir; no la compila (custos:compile) ni la aplica (custos:enforce). Es validación de gobierno del dato, no la validación de contenido de la capa de confianza (alucinaciones, inyección, fuga de datos). Hoy responde «no pude medir», porque la validación contra la fuente aún no está en el Producto (#390). Usar antes de hacer valer una política en la fuente, o cuando se pida «valida la policy», «¿el DDL cubre todas las tablas?».
argument-hint: "<DDL compilado> [--installation <id>]"
---

# custos:validate — la política, antes de hacerla valer

Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`). **Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí · 3 a 7 **no hubo medición completa**; un 3–7 **no es un verde** (tabla completa en `vergis:verify`).

## ¿Qué valida, y con qué veredictos?

| Entrada | Veredicto | Clase del acto |
|--|--|--|
| El DDL que produjo `custos:compile`, contra la fuente **viva** | **acepta** · **rechaza** · **no pude medir** | `read` |

- **Rechaza** si alguna tabla viva que tiene predicado de seguridad queda fuera del DDL: aplicarlo retiraría un predicado vigente sin que nadie lo haya decidido.
- **No pude medir** no es un verde: sin acceso a la fuente, sin inventario, o con una medición a medias, el veredicto es ese, y `custos:enforce` no aplica en la fuente sin un «acepta».

## ¿Qué responde hoy?

La validación contra la fuente todavía no está en el Producto (#390). Hasta que exista, esta skill responde, con estas palabras:

> **«No pude medir.»** La validación de la política contra la fuente viva aún no está en el Producto (#390). Sin veredicto «acepta», la política no se hace valer en la fuente.

No se simula: un «se ve bien» leído a ojo sobre el DDL no es un veredicto.

## ¿Qué no hace esta skill?

- No compila (→ **custos:compile**), no aplica (→ **custos:enforce**), no verifica la política ya vigente (→ **custos:verify**).
- No decide políticas: es del dueño del gobierno del dato.

• *Generado con Wingworking*
