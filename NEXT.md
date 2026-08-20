# NEXT — Vergis

**0.21.0 es la versión publicada** (tag `v0.21.0`, 2026-08-19). **Es la primera versión que EXIGE algo
nuevo de la instancia**: el principal de serving debe poder leer el valor real de las columnas
gobernadas, y hay que regenerar y re-aplicar la DDL de la política para que el centinela exista.
**La instancia del cliente sigue en 0.18.0** — medido por el frente arbol contra la VM viva
(`docker ps` → `ghcr.io/gegolabs/vergis:0.18.0`), o sea **tres minors de gap**.

> **`main` tiene trabajo sin publicar.** La sesión del 2026-08-19 (noche) dejó en «Sin publicar» dos
> capacidades del DSL (#235, #246), el healthcheck por fase y la corrección de E3/E5. **Nadie puede
> consumirlo hasta que se corte una versión** — ver «Lo que espera».

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **Cortar 0.22.0** | **Nuestro** | `main` acumula **#235, #246, #248, #228** y el healthcheck por fase, más la corrección de E3/E5. Sin corte, nada de eso es consumible |
| **El aviso al operador** — de 0.18.0 → la versión que se corte | **César** | Comunicación saliente. **Redactado al pie de este archivo**, y **corregido**: la capacidad de desenmascarar tiene **dos** vías y la del `GRANT` es mejor |
| **Issue #245** — hay `UNMASK` **granular por columna** en Fabric | **César decide**: ¿el emisor lo emite (a), o se documenta como vía del operador (b)? | Medido con control positivo, negativo y revoke verificado. **Recomiendo (b)** por frontera: los privilegios del principal los decide quien opera |
| **E4 de #238** — ¿la aptitud vale toda la vida de la conexión? | **Nuestro** | Sigue **sin medir**, y ahora se sabe qué cuesta: por la vía del rol arrastra la staleness (>20 min, techo desconocido) y deja el terreno inutilizable; **por la vía del `GRANT` es viable** y cabe en una ventana propia |
| **`tsconfig.json` no incluye `scripts/`** | **Nuestro** | `npm run typecheck` **nunca** chequeó `fabric-lab-proof.ts` ni `tsql-lab-proof.ts`. Descubierto al promover el arnés; no se tapó porque tocar el `include` afecta a otros scripts |
| **PRs #201 y #175** (Renovate) | **Nadie, todavía** | **No se mergean**: su `renovate/stability-days` está en `pending` — es el cooldown de 14 días del ADR-001 (6 y 2 días cumplidos). Se aterrizan solos cuando pase. Ver `DECISIONS.md` D-51 |
| **Cuenta de bot en GitHub** · **`CONTRIBUTING.md`** · **capacidades Fabric del tenant** · **header del theme `default`** | **César** | Sin cambios |
| **PR #2 en `protocolos`** — enmienda a la Regla 1 de `ww:wingcoding` | **César** | El Reglamento lo escribe él. Rama `wingcoding/quien-aplica-el-criterio`; propuesto, sin mergear |
| **#232** (lease: el release no nombra sucesor) | **arbol** | Sin empezar. **#228 CERRADO** — PR #247 mergeado con su invariante de runtime verificado por esta casa |
| **Drift de specs en la instancia** — `pi04` y `pi12` desplegadas difieren del repo | **arbol** | Detectado al medir #248 (`md5sum` de `/opt/mira/specs/` contra el árbol: 7 de 9 idénticos). **No toca controles** —verificado leyendo sus bloques vivos—, así que no invalidó esa medición |

## Lo que cambió en la sesión del 2026-08-19 (noche)

Dos PRs mergeados —**#243** y **#244**— con cinco frentes y todos los gates por mano propia antes y
después. Detalle en `BITACORA.md`; lo que hay que saber para retomar:

- **#242 cerrado**: la entrada de anillos I7+I8 volvió a la sección 0.21.0, que es la versión cuyo tag
  contiene su código. La imagen `0.21.0` ya horneó el CHANGELOG sin ella y **eso no se corrige** — para
  ese tramo la fuente es el repo.
- **#246 cerrado**: el `enum` del schema tenía **muerto** al default literal de #92 desde agosto. El test
  que debía protegerlo **bendecía el defecto** — aceptaba cualquier rechazo sin distinguir la capa.
- **#235 cerrado**: `controls[].defaultField`. El criterio de verdad es una **lista cerrada** (no
  truthiness: `String(false)` es truthy), el conteo va sobre **opciones deduplicadas**, y la ausencia de
  resolución **emite evento**.
- **El gate de shell es reproducible**: shellcheck pinneado a 0.11.0 con checksum, y el CI **más
  estricto que el local** (`LINT_SHELL_STRICT=1`). Si tocas shell, corre `npm run lint:shell`.
- **El arnés de Fabric tiene P9 y P10**: el control de premisa (mide **leyendo**, en el plano de datos) y
  el centinela. Y `npm run fab:sql` imprime el SQL emitido **sin motor y sin gasto** — es la revisión
  previa a abrir una ventana.

## Próximo paso

**Cortar 0.22.0**, que es lo único que vuelve consumible el trabajo de `main`. Lo que el corte tiene que
declarar ya está escrito en «Sin publicar» del CHANGELOG, y trae dos cosas que el operador necesita: el
healthcheck para su plantilla y la corrección de E3 (que **cambia la recomendación** de cómo concederle
la capacidad al principal de serving).

**Antes de taggear, y esta vez en el orden correcto:** correr `npm run fab:proof` con su ventana. La
lección de 0.21.0 fue que el DDL del centinela se midió **20 minutos después** de empujar el tag; ahora
P10 existe justamente para que el corte no dependa de que alguien se acuerde. Su cabecera lo declara.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm run typecheck && npm test && npm run build && npm run lint:shell
npm run fab:sql          # gratis: revisa el SQL emitido antes de gastar
# y la ventana, UN solo comando de shell con la pausa en trap (ver más abajo)
```

## La ventana de Fabric, que ya no se pide

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
export FAB_SERVER="b5towqozkz5ebe7ayhs6w67cdq-vei4k2srzm5efe57d5tj2a75by.datawarehouse.fabric.microsoft.com"
. local/fabric-lab-sp.env                      # el secreto del SP; su valor no se cita en ningún registro
export FAB_TOKEN=$(az account get-access-token --subscription $VERGIS_FAB_SUB \
                     --resource https://database.windows.net/ --query accessToken -o tsv)
npm run fab:resume && npm run fab:proof && npm run fab:pause
```

Entra bajo **POL-01** y **se corre sin preguntar** (≈US$0,02 la ventana de 4 min). Tres reglas que
costaron aprenderse:

1. **La ventana es UN solo comando de shell** — si el `resume` va en uno y el `proof` en otro, el `trap`
   del primero pausa la capacidad antes de medir.
2. **La pausa va en `trap EXIT/INT/TERM`**, no en acordarse. Y el `trap` **no** protege contra que te
   maten desde afuera: un sondeo largo se corre **en background con su propio techo de tiempo**, porque
   un SIGTERM por timeout del ejecutor deja la capacidad viva.
3. **Los sondeos piden el token de dos maneras distintas.** `centinela-fabric.ts` exige `FAB_SP_TOKEN`
   **pre-obtenido**; los demás lo sacan solos por `client_credentials`. Una ventana entera se perdió por
   esto. `fab:proof` ya lo unificó, pero los scripts de `local/` no.

El gasto se asienta en `POLICIES-ledger.md` (mes en curso: **US$0,24** de US$50).

## Los scripts de medición viven en `local/` (ignorado, no versionado)

| Script | Qué mide |
|---|---|
| `local/unmask-a-public.ts` | **la escalera de `GRANT UNMASK`** (issue #245): columna → objeto → schema → base, cada peldaño medido dos veces («¿lo acepta el motor?» y «¿surte efecto?») |
| `local/unmask-granular-y-conexion.ts` | E3 por principal (negativo: Fabric no soporta `CREATE USER … FROM EXTERNAL PROVIDER`) y el andamiaje de E4 |
| `local/rol-experimento.ts` | propagación de un cambio de rol de workspace por tres vías, sin tocar DDL |
| `local/centinela-fabric.ts` | **superado por P10 de `fab:proof`** — se conserva como referencia |
| `local/discrimina-como-sp.ts` | **⚠ instrumento DÉBIL**: juzga por desigualdad de JSON, que no sabe reprobar (`•••` y `xxxx` difieren sin traer el dato). Su control de premisa sí es bueno. Superado por P9 |
| `local/fabric-lab-sp.env` | el secreto del SP (modo 600). Se carga con `source` |
| `local/rollback-roleassignments-2026-08-19.json` | snapshot de asignaciones de rol del workspace, para revertir |

## Terreno ya recorrido — no reintentar

- **Juzgar la discriminación de máscara por «las dos lecturas difieren»** — no sirve, y no en una sola
  dirección: la vista devuelve `•••` y el DDM `xxxx`, así que **difieren sin traer el dato** (verde
  falso) y **coinciden cuando el DDM aplasta las dos ramas** (rojo falso sobre un Producto sano, porque
  desde #240 el gate declara ese PI no servible a propósito). Se juzga por **valor real**.
- **Medir `UNMASK` con la cuenta de un admin** — no contesta nada: un admin siempre lo tiene.
- **Medir `UNMASK` justo después de tocar el rol** — miente a favor del privilegio durante >20 min.
- **Conceder `UNMASK` a un principal específico en Fabric** — imposible: `CREATE USER … FROM EXTERNAL
  PROVIDER` no está soportado, así que el SP **no tiene principal propio en la base**. La granularidad
  que sí existe es **por objeto/columna, vía `public`** (#245).
- **`fn_my_permissions` / `DATABASE_PRINCIPAL_ID()` en Fabric** — no sirven; un `[]` significa «no pude
  medir», no «no tiene».
- **Consultar sin el prelude de `SESSION_CONTEXT`** — la row policy deniega todo y el control positivo
  sale vacío: no mide nada.
- **Correr dos suites de tests a la vez** — ~40 rojos por contención en paquetes que el cambio no toca.
- **Arreglar hallazgos de un linter sin pinnear su versión** — el gate sigue siendo irreproducible y el
  próximo bump del runner trae otros. Se pinnea.
- **`git ls-files` sin `--others`** en un gate de descubrimiento — la corrida local previa al commit no
  ve el archivo nuevo y sale **verde** justo cuando tenía que atrapar el error.
- **Medir un mecanismo con SQL escrito a mano** — se mide con **lo que emite el compilador**. Ya cobró
  su precio dos veces.
- **Cerrar un issue cuyo arreglo no alcanza a ninguna versión publicada** — pasó con #229.
- **Leer «sin checks» como «todavía no corrió»** — un PR conflictuado **no da CI rojo: da CI ausente**.
- **Inscribir normas de aterrizaje en `POLICIES.md`** — esa pluma es **solo de César**.

## Coordinación con el frente arbol — funcionó, y así

**El aviso previo antes de abrir un PR se pagó solo el 2026-08-19.** El frente arbol anunció cuatro
partidas y **tres ya estaban hechas**: mató dos subagentes en vuelo antes de gastar, y de paso se le
corrigió un diagnóstico falso (tenía el check rojo de #244 como «falta sanear el archivo» cuando la
causa era el gate no reproducible). El canal es `SendMessage` sobre el socket de la sesión.

**Y la lección propia sobre repartir frentes en paralelo** (ocurrencia 27 de W-01): los archivos de
*trabajo* se reparten solos, los que colisionan son los **canónicos de registro** —`PENDINGS.md`,
`CHANGELOG.md`, `DECISIONS.md`— porque *todos* los frentes terminan escribiéndolos. La mitigación va en
el encargo: **los registros los escribe el orquestador**, o se reparten nominalmente uno por frente.

---

## El aviso al operador — REDACTADO, NO ENVIADO

> **Para César.** Comunicación saliente: es tu voz. Abajo va el borrador listo para copiar.
>
> **Dos cosas que tienes que saber antes de mandarlo, y que no puedo resolver yo:**
>
> 1. **No pude correr el paso cero.** La doctrina de `conversacion` exige reconstruir el hilo desde
>    la fuente viva —qué se le dijo y qué contestó, en todos los foros— antes de redactar. **No tengo
>    acceso a su canal**, así que este borrador se escribió sobre el estado del Producto, no sobre el
>    estado de la conversación. Si ya le adelantaste algo de esto, **hay partes que estarían
>    re-vendiéndole lo que ya sabe** — se podan antes de enviar.
> 2. **El objetivo lo propuse yo, y el gate es que tú lo veas.** Lo escribo abajo para que lo
>    corrijas, no para que lo asumas.
>
> | Cabecera | |
> |---|---|
> | **Objetivo propuesto** | Que planifique el salto **con su control de cambio**, sabiendo que esta vez trae una migración que no es opcional y un requisito nuevo de configuración — y que **verifique la capacidad antes de subir**, no después |
> | **Actitud** | **Aliado.** Necesitamos su voluntad de agendar una ventana y tocar permisos; ninguna línea puede insinuar que se le lleva la cuenta |
> | **Canal** | Sin decidir — el que uses habitualmente. Si va por escrito, el detalle largo puede ir al CHANGELOG y el mensaje quedar corto |
>
> **Lo que deliberadamente NO lleva:** ningún número sobre su conducta (cuántas versiones lleva sin
> subir, cuánto tiempo pasó), ningún plazo que no exista en su calendario, y ninguna enumeración de
> sus pendientes. Son las marcas que reasignan la relación sin que nadie lo haya decidido.
>
> **⚠ Y una nota de vigencia:** el borrador dice «0.21.0». Si se corta **0.22.0** antes de enviarlo,
> hay que actualizar la versión y agregar lo que esa versión trae (el healthcheck y los defaults del
> DSL). El paso 1 ya está corregido con el hallazgo de #245 y **ése no caduca**.

### Borrador

> Salió **0.21.0**, y esta te la quiero avisar con detalle porque **no es como las anteriores: exige
> un cambio de configuración de tu lado**, y si no está, los productos con columnas protegidas
> dejan de servirse a propósito.
>
> **Qué hay que hacer, en orden:**
>
> **1 · Conceder la capacidad de desenmascarar al principal con el que corre Vergis.** Hay **dos
> vías**, y la segunda es la que recomiendo:
>
> - **Subir el rol del workspace a `Member`.** Funciona, y es privilegio **amplio**: lectura y
>   escritura de todo el workspace. Y con un costo que medimos: **quitarlo después no surte efecto
>   inmediato** — sondeamos más de 20 minutos y el permiso seguía vigente.
> - **Conceder `UNMASK` sobre la columna, y nada más:**
>   `GRANT UNMASK ON [esquema].[tabla]([columna]) TO [public]`. Lo medimos contra un warehouse Fabric:
>   el motor lo acepta, surte efecto, la vista discrimina correctamente, y **revocarlo sí es
>   inmediato**. Es del tamaño del dato que protege.
>
>   Con una advertencia que hay que decir: `public` es un rol al que pertenece **todo** principal de la
>   base, así que la capacidad queda para todos los que puedan consultar ese warehouse — no solo para
>   Vergis. No se puede hacer más fino: Fabric no permite crearle un usuario propio a un service
>   principal (`CREATE USER … FROM EXTERNAL PROVIDER` no está soportado). Si en ese warehouse consultan
>   otros principals, esto los alcanza.
>
> Vergis no exige ninguna de las dos: mide si la lectura desenmascara, y le da igual cómo lo lograste.
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
> **Una advertencia sobre el paso 1, medida, y aplica a la vía del ROL:** conceder el rol surte
> efecto casi de inmediato, pero **quitarlo no** — sondeamos más de 20 minutos y el permiso seguía
> vigente, y una conexión ya abierta no se entera nunca. Si en algún momento revocan ese rol, hay que
> reiniciar Vergis en vez de confiar en que el motor propague. **Con la vía del `GRANT` esto no pasa**:
> el revoke lo verificamos efectivo en la misma corrida. Es la segunda razón para preferirla.
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

<!-- /ww:next · 2026-08-19 · HEAD c223394 -->
