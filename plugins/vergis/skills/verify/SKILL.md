---
description: Verificar la plataforma de una instalación de Vergis, sin cambiar nada EN ella (publicar es vergis:publish; cambiar la versión DE Vergis, vergis:rollout), distinguiendo «medí» de «no pude medir» — salud por el borde con el predicado canónico, que cada Let responda en todas sus vistas, paridad espejo↔host por sha256 (completa si el acto tocó infraestructura, por familia si no) con el estado del espejo declarado, lo que el contrato del nodo declara, y el alcance de cada Conector. La RLS por identidad es custos:verify; las vistas, drills y marcas de un PI, mira:status. Es además donde vive la tabla completa de los códigos de salida del CLI. Usar SIEMPRE después de cualquier acto sobre una instalación (publicar, recargar, promover, volver atrás), y cuando se pregunte «¿está sana?», «¿quedó publicado?», «¿sirve lo que el repo dice?», «corre el smoke». No repara nada: un drift se reporta.
argument-hint: "[--installation <id>] [--family <familia>]"
---

# vergis:verify — ¿la plataforma sirve lo que el repo dice, y puedo demostrarlo?

**Verificar es medir con un instrumento que sabe fallar.** Cada verbo distingue «medí y salió mal» (exit 1) de «no pude medir» (3 a 7), y una verificación que terminó en «no pude medir» **no es una verificación**: se repite, o se declara no verificada. Un verde que no se pudo producir en rojo tampoco vale.

El CLI es `vergis-ops`. Sin `vergis-ops.json` se niega (ver `vergis:setup`); con más de una instalación, todo verbo lleva `--installation <id>`.

## ¿Qué dice cada código de salida?

Un solo vocabulario para todos los verbos, en los tres plugins. Lo que importa es no confundir **«medí y salió mal»** con **«no pude medir»**:

| Exit | Significa | Qué se hace |
|--|--|--|
| 0 | medí, sin hallazgo | seguir |
| 1 | medí, **hay hallazgo** sobre lo medido: el terreno — o el instrumento, cuando es él lo medido (un CN-1 verde, una calibración con el selector muerto) | reportarlo; no repararlo de paso |
| 2 | **no corrí**: uso, guardia, gate sin su evidencia, clave no declarada | leer el mensaje: dice qué falta |
| 3 | respuesta **cruzada** (llegó la salida de otra corrida) | no se entrega; serializar y reintentar |
| 4 | transporte **ocupado** (otro actor tiene el canal) | esperar y reintentar |
| 5 | remoto **mudo** (sin centinela) | **no hubo medición**: nada de eso es un veredicto |
| 6 | el transporte **falló** | revisar acceso, cuenta, red |
| 7 | medí **a medias** | lo no medido se lista; **no cuenta como OK** |

Un 3–7 **no es un verde**. Un «verificado» con uno de ellos es falso.

## La verificación estándar, en orden

```sh
vergis-ops health                    # 1 · el predicado por el borde, y la fase de cada anillo
vergis-ops smoke                     # 2 · que cada Let responda, en todas sus vistas
vergis-ops parity                    # 3 · ¿el host sirve lo que el espejo dice? (o --family <f> si el acto fue acotado)
vergis-ops contract                  # 4 · lo que el nodo declara: watches, envs de arranque, artefactos pendientes
```

**1 · Salud.** `200 ∧ phase=serving ∧ lets.serving == lets.total` por el conmutador. Un standby da 200 con `ok:true` y **no** es sano; la sala de espera del borde es HTML y **no** es sana aunque lleve el literal de la fase en un comentario.

**2 · Que cada Let responda.** `smoke` deriva las vistas de los specs montados —la primera en `/<slug>`, las demás en `?page=<id>`— y **coteja qué vista sirvieron**: un `?page=` desconocido no da 404, cae en silencio a la primera con 200. Las vistas de drill (las que declaran `context:`) exigen valores de contexto que la sonda no inventa: se listan como **no medidas**. El inventario se reconcilia con `/healthz`: si los Lets probados no son `lets.total`, es medición a medias (7). Juzgar si un PI **se ve bien** —sus vistas por identidad, sus drills, sus marcas de dato— es `mira:status`; la RLS por identidad, `custos:verify`.

**3 · Paridad.** Por sha256, artefacto por artefacto: `DRIFT` (distinto), `AUSENTE`, `SOLO-REPO` (nunca publicado), `SOLO-HOST` (en el host sin contraparte — en un directorio de specs **se sirve**), `ERR` (existe y no se pudo leer: no-medición, no drift), `HYG` (AppleDouble), `EXCL` (exclusión declarada, con su motivo). Antes de tocar el host corre la **guardia G1**: cada montaje del compose espejado tiene que estar cubierto por una familia o declarado en `mirror.unmirrored` con su motivo; si no, la sonda **se niega** a medir con un inventario que sabe incompleto. **Completa** si el acto tocó infraestructura; `--family <f>` si tocó una sola familia. Criterio de cierre: **exit 0**.

**El estado del espejo se declara.** Una discrepancia sobre un archivo del espejo **sin commitear** sale marcada: un espejo sucio cambia la lectura del drift, y se dice junto al veredicto.

**4 · Contrato.** Artefactos pendientes (`pending`) después de un acto son un despliegue no confirmado: `vergis-ops contract wait <archivo>`.

**5 · Alcance de cada Conector.** El CLI no tiene todavía la prueba de alcance con control negativo (#391). Hasta que exista, el reporte dice, con estas palabras: **«alcance de los Conectores: no pude medir»**. Que un Let haya respondido no demuestra que su Conector alcance la fuente con la credencial correcta y falle con una inválida.

## ¿Qué ve la sonda, y qué no?

`smoke` y `contract` entran **por detrás del borde**, desde dentro del anillo, **forjando** la identidad (`X-Forwarded-Email`/`X-Forwarded-Groups`): las de `probe_identities`, o la admin de `RINGS_ADMIN_EMAIL` para `/contrato`. Eso mide el tramo del nodo —imagen, spec, gobierno, dato— y **no** el login real del borde: un verde es compatible con un SSO roto. Y es un privilegio que se ejerce en cada consulta: **solo es seguro donde el nodo no está expuesto sin borde**. Si una instalación expone el nodo directo, eso se reporta antes de sondear. En el borde de referencia (oauth2-proxy), un cambio de roles o claims se ve recién con un login fresco: la cookie de sesión dura días.

## ¿Qué dice el reporte?

- Cada verbo con **su exit** y qué significa — no «sin drift», sino «paridad exit 0: 214/214 pares».
- Lo no medido, nombrado: vistas de drill, alcance de los Conectores, familias opcionales ausentes, `SINMEDIR`.
- Que el smoke mide el tramo **del nodo** con identidad forjada por detrás del borde.
- El estado del espejo (commiteado o no) de lo que se comparó.

## ¿Qué no hace?

**No repara.** Un drift se reporta con su exit y se decide aparte, con la skill del acto y el gate de su clase. Corregir «de paso» mezcla el cambio propio con el ajeno y borra la evidencia de qué estaba mal.

• *Generado con Wingworking*
