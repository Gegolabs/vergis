# NEXT — Vergis

**0.21.0 es la versión publicada** (tag `v0.21.0`, 2026-08-19). **Es la primera versión que EXIGE algo
nuevo de la instancia**: el principal de serving debe poder leer el valor real de las columnas
gobernadas, y hay que regenerar y re-aplicar la DDL de la política para que el centinela exista.
**La instancia del cliente sigue en 0.18.0.**

> **No hay trabajo de este frente en vuelo.** Este archivo es el **estado** y el índice de lo que
> espera a César o a otro frente.

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **El aviso al operador** — ahora de 0.18.0 → **0.21.0** | **César** | Comunicación saliente. **Redactado y listo**, al pie de este archivo; no se envió |
| **PR #234** (docs del contrato de anillos, del frente arbol) | **Nuestro** — la custodia | Verde y limpio; espera nuestra verificación de composición y merge |
| **`shellcheck` en el CI** | **Nuestro** | Sin empezar. Ficha en `PENDINGS.md` |
| **#235** — default móvil en controles del DSL | **Nuestro** | Abierto hoy por César, sin empezar |
| **E3/E4/E5 de #238** | **Nuestro** | Exigen el SP de laboratorio **fuera** de la ventana de staleness de revocación, que sigue viva |
| **Cuenta de bot en GitHub** · **`CONTRIBUTING.md`** · **capacidades Fabric del tenant** · **header del theme `default`** | **César** | Sin cambios |
| **#228 / #232** (lease) | **arbol** | Sin cambios |

## Lo que cambió hoy

**#238 — la protección de columna no discriminaba para el sujeto que sirve.** Corregido y publicado
en 0.21.0: dos planos de identidad que estaban cableados **en serie** sobre el mismo camino de
lectura, un **centinela** que mide la precondición por conexión con tres estados que nunca se
colapsan, y negativa **ruidosa** por PI cuando falta.

**P5 quedó respondida** — y su primer veredicto fue **falso**, por la staleness de revocación de rol.
La corrección está en #237 y la regla que sale de ahí vive en `RESOURCES.md`: *una medición de
`UNMASK` solo vale si el rol no cambió recientemente*.

## Terreno ya recorrido — no reintentar

- **«El mecanismo de #238 se descubrió el 19-ago»** — **falso**: el arnés local lo medía desde el
  frente #163 y lo reportaba como *hallazgo*. Lo nuevo fue que **nada lo detectaba**.
- **Medir `UNMASK` con la cuenta de un admin** — no contesta nada: un admin siempre lo tiene.
- **Medir `UNMASK` justo después de tocar el rol** — miente a favor del privilegio durante >20 min.
- **`fn_my_permissions` / `DATABASE_PRINCIPAL_ID()` en Fabric** — no sirven; un `[]` significa «no
  pude medir», no «no tiene».
- **Consultar sin el prelude de `SESSION_CONTEXT`** — la row policy deniega todo y el control
  positivo sale vacío: no mide nada.
- **Correr dos suites de tests a la vez** — produce ~40 rojos en paquetes que el cambio no toca.
  Es contención; se re-corre solo antes de investigar.
- **Inscribir normas de aterrizaje en `POLICIES.md`** — descartado: esa pluma es **solo de César**, y
  el contenido pertenece a `CLAUDE.md` §«El aterrizaje». La custodia se inscribió allá.
- **Medir un mecanismo con SQL escrito a mano** — insuficiente y ya cobró su precio dos veces: entre
  el SQL del experimento y el que **emite el compilador** hay diferencias que nadie eligió. Se mide
  con lo emitido.
- **Cerrar un issue cuyo arreglo no alcanza a ninguna versión publicada** — pasó hoy con #229 y lo
  detectó otro frente. Un arreglo mergeado que nadie puede consumir no está entregado.
- **Leer «sin checks» como «todavía no corrió»** — un PR conflictuado **no da CI rojo: da CI ausente**,
  porque el workflow de `pull_request` corre sobre la merge ref y con conflictos no existe. Ante
  checks vacíos, preguntar si es *mergeable*.
- **Suponer que una sesión peer desconocida es un actor** — el mapeo `/tmp/cc-socks/*.sock` → PID →
  `cwd` lo resuelve en un comando. Las «dos sesiones fantasma» del 18-ago eran ceremonias headless
  del órgano de asimilación, no actores.

## Lo que cambió cómo se trabaja este repo: la custodia

**`arbol` propone · `vergis` dispone · jamás self-merge**, y el **aviso previo antes de abrir PR va en
los dos sentidos**. Vive en `CLAUDE.md` §«La custodia» (decisión de César, 2026-08-18).

Nació porque los dos frentes escribieron `Gegolabs/vergis` la misma tarde sin saberlo. **Ninguno hizo
nada prohibido: faltaba el custodio.** El dato que hay que internalizar, porque ningún reconocedor
clásico lo atrapa: **el lab de A.R.B.O.L. tiene un clon de este repo y pushea al mismo remoto**, así
que el trabajo ajeno **no aparece como cambios sin commitear — llega por `git pull` ya mergeado**,
con el árbol local impecable.

**Lo que el custodio hace, y no es revisar el código ajeno:** correr los gates **por mano propia**
antes y después del merge, y verificar los invariantes que el PR afirma en vez de leerlos de su
reporte. Ejercido tres veces hoy (#225, #233 y el rechazo de #233 en su primera forma).

## La ventana de Fabric, que ya no se pide

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
export FAB_SERVER="b5towqozkz5ebe7ayhs6w67cdq-vei4k2srzm5efe57d5tj2a75by.datawarehouse.fabric.microsoft.com"
export FAB_TOKEN=$(az account get-access-token --subscription $VERGIS_FAB_SUB \
                     --resource https://database.windows.net/ --query accessToken -o tsv)
npm run fab:resume && npm run fab:proof && npm run fab:pause
```

Entra bajo **POL-01** y **se corre sin preguntar** (≈US$0,01 la ventana de 2 min). Dos reglas que
costaron aprenderse hoy: **la ventana tiene que ser UN solo comando de shell** —si el `resume` va en
uno y el `proof` en otro, el `trap` del primero pausa la capacidad antes de medir— y **la pausa va en
`trap EXIT/INT/TERM`**, no en acordarse. El gasto se asienta en `POLICIES-ledger.md` (hoy: US$0,04 de
US$50).

<!-- /ww:finish · 2026-08-18 · HEAD f6b1295 -->

---

## El aviso al operador — REDACTADO, NO ENVIADO

> **Para César.** Comunicación saliente: es tu voz. Abajo va el borrador listo para copiar.
>
> **Dos cosas que tienes que saber antes de mandarlo, y que no puedo resolver yo:**
>
> 1. **No pude correr el paso cero.** La doctrina de `conversacion` exige reconstruir el hilo desde
>    la fuente viva —qué se le dijo y qué contestó, en todos los foros— antes de redactar. **No tengo
>    acceso a su canal**, así que este borrador se escribió sobre el estado del Producto, no sobre el
>    estado de la conversación. Si ya le adelantaste algo de esto en una reunión o por chat, **hay
>    partes que estarían re-vendiéndole lo que ya sabe** — se podan antes de enviar.
> 2. **El objetivo lo propuse yo, y el gate es que tú lo veas.** Lo escribo abajo para que lo
>    corrijas, no para que lo asumas.
>
> | Cabecera | |
> |---|---|
> | **Objetivo propuesto** | Que planifique el salto a 0.21.0 **con su control de cambio**, sabiendo que esta vez trae una migración que no es opcional y un requisito nuevo de configuración — y que **verifique la capacidad antes de subir**, no después |
> | **Actitud** | **Aliado.** Necesitamos su voluntad de agendar una ventana y tocar permisos; ninguna línea puede insinuar que se le lleva la cuenta |
> | **Canal** | Sin decidir — el que uses habitualmente. Si va por escrito, el detalle largo puede ir al CHANGELOG y el mensaje quedar corto |
>
> **Lo que deliberadamente NO lleva:** ningún número sobre su conducta (cuántas versiones lleva sin
> subir, cuánto tiempo pasó), ningún plazo que no exista en su calendario, y ninguna enumeración de
> sus pendientes. Son las marcas que reasignan la relación sin que nadie lo haya decidido.

### Borrador

> Salió **0.21.0**, y esta te la quiero avisar con detalle porque **no es como las anteriores: exige
> un cambio de configuración de tu lado**, y si no está, los productos con columnas protegidas
> dejan de servirse a propósito.
>
> **Qué hay que hacer, en orden:**
>
> **1 · Conceder la capacidad de desenmascarar al principal con el que corre Vergis.** En Fabric lo
> decide el **rol del workspace**: con `Member` lee el valor real de las columnas; con `Viewer` lee
> la máscara. Vergis no exige un rol concreto — mide si la lectura desenmascara.
>
> **2 · Regenerar y re-aplicar la security policy de cada tabla gobernada.** Es lo que instala la
> pieza con la que Vergis mide esa capacidad. Hasta que se re-aplique, un producto que ya venía
> sirviendo **sigue sirviendo** (no lo apagamos por una migración pendiente), pero uno nuevo con
> columnas protegidas no arranca, y el motivo lo dice.
>
> **3 · Verificar que surtió efecto.** Un usuario con permiso de ver el dato sensible tiene que ver
> el valor; uno sin permiso tiene que ver `•••`. **Si ves `xxxx`, la capacidad no quedó concedida**
> — los dos símbolos son distintos justamente para que se distinga de un vistazo.
>
> **Por qué:** la protección de columna tenía un defecto — la vista devolvía lo mismo con y sin
> permiso cuando el principal de serving no podía desenmascarar. **No se filtró nada** (falla
> cerrado), pero la capacidad de «este usuario sí puede ver el RUT» **no concedía nada y nada lo
> avisaba**. Ahora se mide y, si falta, se dice.
>
> **Una advertencia sobre el paso 1, medida:** conceder el rol surte efecto casi de inmediato, pero
> **quitarlo no** — sondeamos más de 20 minutos y el permiso seguía vigente, y una conexión ya
> abierta no se entera nunca. Si en algún momento revocan ese rol, hay que reiniciar Vergis en vez
> de confiar en que el motor propague.
>
> **Y como vienes desde 0.18.0, en el camino hay tres cosas más:**
>
> - **La vista de máscara ya funciona en Fabric** desde 0.19.0 (antes se creaba pero fallaba al
>   consultarla). Discrimina por permiso **siempre que el paso 1 esté hecho**.
> - **Cambió un contrato:** `bindColumn` se retiró. Para obtener el efecto hay que re-aplicar las
>   policies — y ojo con esto: **hasta que se re-apliquen, el compilador reporta cero dependencias
>   mientras la columna sigue atada en el motor.** O sea que un chequeo que dependa de ese reporte
>   queda mudo sin que nada lo grite.
> - **0.20.0 trae una fase `standby`.** Un nodo en standby responde HTTP 200 y `ok:true` sin estar
>   sirviendo: si algo enruta por salud, el chequeo tiene que exigir `phase=serving`, no solo el 200.
>
> Las notas completas de cada versión están en el CHANGELOG del repo. Desde 0.20.1 la imagen también
> las trae adentro; las anteriores no, así que para este tramo el repo es la fuente.

