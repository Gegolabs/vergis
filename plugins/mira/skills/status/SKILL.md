---
description: Ver cómo está EN la instalación de Vergis el Botlet de cada Producto de Información de Mira —sus vistas, drills y marcas de dato por identidad— y operar su ciclo de vida (status, activate, deactivate, retire), sin cambiar nada más; no verifica la plataforma (vergis:verify) ni la RLS (custos:verify), y no publica (mira:specialize). activate, deactivate y retire responden hoy «no disponible» (#392). Usar después de especializar un PI, y cuando se pregunte «¿PI-N se ve bien?», «¿el gráfico dibuja lo que debe?», «¿qué ve X en PI-N?», «retira el PI-N», «desactiva el PI».
argument-hint: "<slug del PI> [--identity <id>] [--installation <id>]"
---

# mira:status — el Botlet de cada PI, por identidad

Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`). **Verificar es medir con un instrumento que sabe fallar:** «medí y salió mal» (exit 1) no es «no pude medir» (3 a 7), y un 3–7 **no es un verde** (tabla completa en `vergis:verify`).

## `status` · ¿cómo se ve el PI?

```sh
vergis-ops smoke <slug>[?page=<id>] --identity <id> --needle "<texto que tiene que aparecer>"
```

- **Cada vista, con cada identidad que importa.** La primera vista está en `/<slug>`, las demás en `?page=<id>`. Un `?page=` desconocido **no da 404**: cae en silencio a la primera vista con 200 — la sonda coteja qué vista sirvieron.
- **Las vistas de drill** (las que declaran `context:`) exigen valores de contexto que la sonda no inventa: se miden con valores que la persona da, o se listan como **no medidas**.
- **Las needles** son el texto que tiene que aparecer (un título, un rótulo, un valor conocido): sin needle, un 200 solo dice que respondió.

### ¿El gráfico dibuja lo que la consulta devuelve?

El conteo es de la **marca de dato** (`aria-roledescription="bar"`, o `"point"` en series), jamás de los contenedores `mark-rect role-mark` (uno por barra en unas formas, uno por categoría en la apilada: coincide por casualidad). Y **ningún conteo se juzga sin su corrida discriminante**:

```sh
vergis-ops marks calibrar --forma <singular|agrupado|apilado|series> --html-a <f> --n-a <n₁> --html-b <f> --n-b <n₂>
vergis-ops marks contar --html <f> --forma <forma> --esperado <n>
vergis-ops marks ruta <slug>[?page=<id>]       # reporta, en el anillo activo; NO juzga
```

Dos documentos de la misma forma con cardinalidades conocidas y **distintas**: el contador vive si devuelve exactamente esos dos números. La calibración es por (versión del motor × forma) y **caduca sola** al cambiar el motor: `contar --esperado` sin calibración vigente sale **2** (no juzga), no un número. Una calibración cuyo contador devuelve el mismo número para las dos cardinalidades sale **1**: el instrumento está ciego. Un cero con el selector vivo es un gráfico vacío (hallazgo); un cero sin discriminante es ambiguo, y se dice así.

### ¿Qué ve la sonda, y qué no?

La sonda entra **por detrás del borde** y **forja** la identidad: mide el tramo del nodo —spec, gobierno, dato— y **no** el login real. Un verde es compatible con un SSO roto. Detalle en `vergis:verify` §«¿Qué ve la sonda, y qué no?».

## `activate` · `deactivate` · `retire`

Son verbos del ciclo de vida de un Botlet, y el Producto aún no define qué hacen con el Botlet de un PI (#392). Hasta que lo defina, esta skill responde, con estas palabras:

> **«No disponible.»** El Producto aún no define qué significa `<verbo>` para el Botlet de un PI (#392). No lo aproximo borrando o moviendo su spec.

No se simula: retirar un spec del host a mano no es `retire`, y desactivar un PI por gobierno (quitarle acceso) es `custos:enforce`, no `deactivate`.

## ¿Qué dice el reporte?

- Cada medición con **su exit** y qué significa, por identidad y por vista.
- Lo no medido, nombrado: vistas de drill sin contexto, marcas sin calibración vigente, `SINMEDIR`.
- Que la sonda mide el tramo del nodo con identidad forjada por detrás del borde.

## ¿Qué no hace?

**No repara.** Un PI que se ve mal se reporta con su exit y vuelve a su spec (`mira:specify` o `mira:compile`, luego `mira:validate` y `mira:specialize`).

• *Generado con Wingworking*
