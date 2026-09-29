---
description: Verificar una instalación de Vergis distinguiendo «medí» de «no pude medir» — salud por el borde con el predicado canónico, smoke de TODOS los Lets en TODAS sus vistas con la identidad de sondeo, comprobaciones de RLS por identidad, marcas de dato con su corrida discriminante, y paridad espejo↔host por sha256 (completa si el acto tocó infraestructura, por familia si no), con el estado del espejo declarado. Usar SIEMPRE después de cualquier acto sobre una instalación (publicar, recargar, promover, volver atrás), y cuando se pregunte «¿está sano?», «¿quedó desplegado?», «¿sirve lo que el repo dice?», «corre el smoke», «¿el gráfico dibuja lo que debe?». No repara nada: un drift se reporta.
argument-hint: "[--installation <id>] [--family <familia>]"
---

# vergis:verify — ¿quedó desplegado, y puedo demostrarlo?

**Verificar es medir con un instrumento que sabe fallar.** Cada verbo de esta skill distingue «medí y salió mal» (exit 1) de «no pude medir» (3 a 7), y una verificación que terminó en «no pude medir» **no es una verificación**: se repite, o se declara no verificada. Un verde que no se pudo producir en rojo tampoco vale.

El CLI es `node ${CLAUDE_PLUGIN_ROOT}/bin/vergis-ops.mjs` (abajo, **`vo`**).

## La verificación estándar, en orden

```sh
vo health                    # 1 · el predicado por el borde, y la fase de cada anillo
vo smoke --rls               # 2 · todas las vistas de todos los Lets + las comprobaciones de RLS
vo parity                    # 3 · ¿el host sirve lo que el espejo dice? (o --family <f> si el acto fue acotado)
```

**1 · Salud.** `200 ∧ phase=serving ∧ lets.serving == lets.total` por el conmutador. Un standby da 200 con `ok:true` y **no** es sano; la sala de espera del borde es HTML y **no** es sana aunque lleve el literal de la fase en un comentario.

**2 · Smoke.** Deriva las vistas de los specs montados —la primera en `/<slug>`, las demás en `?page=<id>`— y **coteja qué vista sirvieron**: un `?page=` desconocido no da 404, cae en silencio a la primera con 200. Las vistas de drill (las que declaran `context:`) exigen valores de contexto que la sonda no inventa: se listan como **no medidas**. El inventario se reconcilia con `/healthz`: si los Lets probados no son `lets.total`, es medición a medias (7). Con `--rls`, cada comprobación de `rls_checks` exige sus `present` y la **ausencia** de sus `absent` (la comprobación fail-closed). Sin `rls_checks` declaradas, el reporte dice **«RLS no verificada»** — no «RLS bien».

Una ruta suelta, con textos que tienen que aparecer: `vo smoke <slug>[?page=<id>] --needle "<texto>" [--identity <id>]`.

**3 · Paridad.** Por sha256, artefacto por artefacto: `DRIFT` (distinto), `AUSENTE`, `SOLO-REPO` (nunca desplegado), `SOLO-HOST` (en el host sin contraparte — en un directorio de specs **se sirve**), `ERR` (existe y no se pudo leer: no-medición, no drift), `HYG` (AppleDouble), `EXCL` (exclusión declarada, con su motivo). Antes de tocar el host corre la **guardia G1**: cada montaje del compose espejado tiene que estar cubierto por una familia o declarado en `mirror.unmirrored` con su motivo; si no, la sonda **se niega** a medir con un inventario que sabe incompleto. **Completa** si el acto tocó infraestructura; `--family <f>` si tocó una sola familia. Criterio de cierre: **exit 0**.

**El estado del espejo se declara.** Una discrepancia sobre un archivo del espejo **sin commitear** sale marcada: un espejo sucio cambia la lectura del drift, y se dice junto al veredicto.

## ¿El gráfico dibuja lo que la consulta devuelve?

Donde la instalación lo necesite (un Let cuyo valor es un gráfico), el conteo es de la **marca de dato** (`aria-roledescription="bar"`, o `"point"` en series), jamás de los contenedores `mark-rect role-mark` (uno por barra en unas formas, uno por categoría en la apilada: coincide por casualidad). Y **ningún conteo se juzga sin su corrida discriminante**:

```sh
vo marks calibrar --forma <singular|agrupado|apilado|series> --html-a <f> --n-a <n₁> --html-b <f> --n-b <n₂>
vo marks contar --html <f> --forma <forma> --esperado <n>
vo marks ruta <slug>[?page=<id>]       # reporta, en el anillo activo; NO juzga
```

Dos documentos de la misma forma con cardinalidades conocidas y **distintas**: el contador vive si devuelve exactamente esos dos números. La calibración es por (versión del motor × forma) y **caduca sola** al cambiar el motor: `contar --esperado` sin calibración vigente sale **2** (no juzga: le falta su precondición, como un gate sin su evidencia), no un número. Una calibración cuyo contador devuelve el mismo número para las dos cardinalidades sale **1**: el instrumento está ciego, igual que un CN-1 verde. Un cero con el selector vivo es un gráfico vacío (hallazgo); un cero sin discriminante es ambiguo, y se dice así.

## ¿Qué dice el reporte?

- Cada verbo con **su exit** y qué significa — no «sin drift», sino «paridad exit 0: 214/214 pares».
- Lo no medido, nombrado: vistas de drill, RLS no declarada, familias opcionales ausentes, SINMEDIR.
- Que el smoke mide el tramo **del nodo** con identidad forjada por detrás del borde: el login real del borde queda fuera, y un verde es compatible con un SSO roto. En el borde de referencia (oauth2-proxy), un cambio de roles o claims se ve recién con un login fresco: la cookie de sesión dura días.
- El estado del espejo (commiteado o no) de lo que se comparó.

## ¿Qué no hace?

**No repara.** Un drift se reporta con su exit y se decide aparte, con vergis:ops y el gate de su clase. Corregir «de paso» mezcla el cambio propio con el ajeno y borra la evidencia de qué estaba mal.

• *Generado con Wingworking*
