# NEXT — Vergis

**0.20.1 es la versión publicada** (tag `v0.20.1`, 2026-08-18). Ese mismo día salieron también 0.20.0
y 0.19.0; antes corría 0.18.0. **La instancia del cliente sigue en 0.18.0** —verificado contra su VM
por el frente arbol—, o sea sin ninguna de las correcciones del día.

> **No hay trabajo de este frente en vuelo.** Este archivo es el **estado** y el índice de lo que
> espera a César o a otro frente. `/ww:go` no tiene nada que reanudar acá; si buscas en qué trabajar,
> la tabla dice de quién es cada partida.

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

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **El aviso al operador de 0.20.1** | **César** | Comunicación saliente; ningún presupuesto la cubre. Es **el único canal que existe** hasta que la instancia corra ≥0.20.1. Contenido exacto en `PENDINGS.md` §Operación — cinco cosas, incluidas un **cambio de contrato** y una **migración no opcional** |
| ~~**`FAB_SP_TOKEN`** para responder P5 (#163)~~ | **SALDADO 2026-08-19** | César dio mandato en sesión; secreto emitido con `--append` y guardado en `local/fabric-lab-sp.env`. **P5 respondida: el SP en `Viewer` lee EN CLARO** — el DDM le es inerte. Contradice el registro del 16-ago y **cuál de las dos describe el mecanismo no está medido** (ver `RESOURCES.md`) |
| **PR #1 en `protocolos`** — enmienda a la Regla 1 de `ww:wingcoding` | **César** | El Reglamento lo escribe él. Rama `wingcoding/deber-de-instruccion-al-tercero` |
| **Cuenta de bot en GitHub** | **César** | Decidida para el **2026-08-19**. Hasta entonces todo escrito sale como `cobach`; regla interina en `TODO.md` |
| **Publicar `CONTRIBUTING.md`** · **`VERGIS_CSRF_SECRET` en QA** · **el ojo humano al header del theme `default`** | **César** | Sin cambios |
| **#228** — el lease queda huérfano si el arranque falla | **arbol** | Medido: **12,40 s** en el caso peor, y lo que muerde no es la espera sino que el único nodo vivo se declare `standby` citando un `pid` muerto |
| **#232** — el `release()` no nombra sucesor | **arbol** | Rollback medido en **3.019 ms**, cero errores crudos. **`17 bis` sigue viva**: la condición era corte cero *medido* |
| **`I9+I10`** del frente arbol | **arbol**, luego nuestro el merge | Desbloqueado al mergear #233. Avisará antes de abrir |
| **`shellcheck` en el CI** | **Nuestro** | Lo tomamos nosotros (es el CI de este repo); arbol lo cierra de su lado. Ficha en `PENDINGS.md` |

## Lo que apareció hoy y cambia el aviso al operador

**#238 — la vista de máscara no discrimina para el sujeto que sirve.** Medido en el arnés local con
la vista **emitida**: si el principal de serving no tiene `UNMASK`, el DDM enmascara en la lectura de
la tabla **antes** de que el `CASE` de la vista decida, y `ve_pii` no concede nada. Por la asimetría
declarada del terreno, **un negativo local refuta también para Fabric**.

**No hay fuga: falla cerrado.** Se pierde una capacidad en silencio, no se filtra PII.

**El hallazgo grande:** el cinturón DDM y la vista **se anulan entre sí** según el rol del sujeto —
con `Member` el DDM es inerte y la vista funciona; con `Viewer` el DDM muerde y la vista está muerta.
No hay configuración donde las dos aporten. **Es una bifurcación de diseño, y es de César.**

**Toca el aviso de 0.20.1**: la línea (a) iba a anunciar #197 como corregido. La vista **sí** se
consulta y **sí** discrimina —eso sigue siendo cierto— **para un principal con `UNMASK`**. Esa
salvedad tiene que ir, o el aviso afirma más de lo medido.

## Próximo paso de este frente

**Agregar `shellcheck -s sh` al job `test` del workflow**, midiendo primero contra lo que ya está en
`main`. El orden importa y no es cosmético:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
brew install shellcheck                     # no está en la máquina
shellcheck -s sh deploy/rollout/vergis-rollout tests/fixtures/anillos/fake-docker.sh
```

**Si sale limpio**, entra como gate duro en `.github/workflows/build.yml` (job `test`). **Si saca
hallazgos**, entran arreglados en el mismo PR o el gate entra acotado — lo que no puede pasar es que
el frente arbol reciba un CI rojo por código ya mergeado que se escribió sin linter. Son **867 líneas
de shell** (`vergis-rollout` + `fake-docker.sh`), y hoy solo se verificaron con `sh -n`, que **únicamente
atrapa errores de parseo**.

## Terreno ya recorrido — no reintentar

- **«La vista de máscara no sirve en Fabric»** — **falso desde 0.19.0**. Sirve y **discrimina** con la
  forma C2 (`CROSS APPLY (VALUES …)`). Lo que Fabric rechaza es `SESSION_CONTEXT()` **inline dentro
  del `CASE`** sobre el scan; lo que decide es **de dónde viene el claim**, no el `CASE`.
- **«El allow-all necesita una columna»** — **falso desde 0.19.0**, medido en los dos motores con el
  SQL emitido y con el control que decide: el `ALTER` sobre una columna de negocio **se acepta** con
  la policy instalada. `bindColumn` está **retirado del contrato**.
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
