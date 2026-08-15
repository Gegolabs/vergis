# NEXT — Vergis

**0.16.1 es la última versión publicada, y `main` ya tiene material para la siguiente.** Entraron
tres frentes (#182, #183, #185) con sus issues cerrados. Integrados y medidos juntos sobre `main`:
typecheck ✓ · **2120 tests** ✓ · build ✓ — la suma exacta de los tres, así que ningún test se perdió
en los merges.

**La instancia de A.R.B.O.L. corre 0.15.0, y eso NO es pendiente nuestro.** Acá se es el Producto: se
publica la versión con su changelog y su aviso; qué versión corre una instancia y cuándo entra lo
decide quien la opera. Ver `CLAUDE.md` §«La frontera» y `DECISIONS.md` D-28.

## Lo primero al retomar: dos decisiones, y son de César

**PR #190 abierto, CI verde, sin mergear** — el arnés T-SQL local. **No arregla nada a propósito**:
solo mide.

1. **Mergear #190** (o no). Es instrumento puro: un script, su README y tres scripts de npm. No toca
   una línea del Producto ni entra en la suite.
2. **Qué hacer con la colisión vista-contrato ↔ máscara** (#163, reabierto). Es **diseño**, y por eso
   no se resolvió dentro del PR que la descubrió. Los caminos que aparecieron, sin elegir ninguno:
   enmascarar sobre la vista · recrear la vista-contrato dentro del setup · declarar la combinación
   no soportada y **fallar ruidoso** en vez de en silencio.

## Lo que el arnés T-SQL local cambió — lo más importante de la sesión

**La justificación «no hay dónde medir lo que toca Fabric» es falsa para la mitad de las preguntas.**
El compilador emite **T-SQL**, y un motor T-SQL cabe en un contenedor: gratis, local, sin ventana y
sin tocar el tenant de nadie. `npm run lab:up && npm run lab:proof && npm run lab:down`.

El arnés aplica `compileFabric(...).setupSQL` **tal cual sale** — uno que escriba su propio SQL se
mide a sí mismo.

| Hallazgo | Estado |
|---|---|
| **La vista-contrato `SCHEMABINDING` bloquea el `ADD MASKED`** de las columnas que proyecta. Control de causa corrido: quitando **solo** la vista, la misma sentencia se acepta | 🔴 **#163 reabierto** — el plano de columna no se instala en las tablas que la instancia usa, y salió en 0.16.0 |
| **Sin `UNMASK`, ni el sujeto con el claim ve el valor.** Con `UNMASK`, la vista discrimina por claim como se prometió | Confirmada la degradación que #163 temía |
| **#164: el motor acepta función sin parámetro y `ADD FILTER PREDICATE` sin argumento** — la columna deja de ser rehén. Con control positivo y verificando que no sea deny silencioso | 🟢 destrabado — comentado en #164 |
| El **emulador** que sostiene los 2120 tests coincide con el motor en los cinco casos | Nunca antes contrastado contra un motor |

**La asimetría que NO se puede olvidar al citar cualquiera de estos resultados:** un **negativo** de
este arnés refuta también para Fabric; un **positivo NO garantiza Fabric**. Está escrito en la
cabecera del script y en `scripts/README-tsql-lab.md` para no depender de que alguien se acuerde.

## #186 — sigue vivo, mejor delimitado, menos urgente

El terreno Fabric propio **no se reemplaza** con lo anterior. Queda para lo que solo Fabric contesta:
**SKU**, permisos del **Service Principal** de una instancia, **costo** de enforcement, plano de
control, **OneLake/`Files/`**, jobs, contrato `_logs/`, correlación carga↔corrida (#161/#162) y los
gates manuales de 0.14.0.

Baja la **urgencia**, no la necesidad: ya no bloquea corregir defectos publicados. Y aparece un
criterio que el issue no tenía: **el bootstrap del terreno Fabric debe levantar la MISMA forma que el
arnés local**, para que la única diferencia entre los dos sea el motor. Un banco que además difiere
en el esquema mide dos cosas a la vez y no distingue cuál falló.

Sigue en pie lo decidido: terreno **desconectado** del cliente, datos **sintéticos**, capacidad **F2
pausada** (≈US$0,36/h, una sesión ≈ un dólar), **NO Trial**. El gasto es decisión de César cualquiera
sea su tamaño.

## La ventana de terreno vivo del cliente — qué queda de ella

Encender `vm-vergis-qa` (`az vm start -g rg-arbol-qw04 -n vm-vergis-qa`, ~1 min) contra `ws-arbol-qa`,
medir, apagar. **Se le cayeron dos de las cuatro preguntas**: la del `ADD MASKED` sobre vista-contrato
y la de la forma de #164 ya tienen respuesta en la familia T-SQL. Queda lo genuinamente de Fabric:

1. **¿El SP de serving tiene `UNMASK`?** — ahora se sabe **qué se juega**: sin él, la columna no se
   sirve a nadie. Control obligatorio, misma sesión: consulta a la tabla **sin** vista.
2. **¿El SKU acepta las formas que acá pasaron?** — los positivos no viajan solos.
3. El **costo de enforcement por columna**, de paso.

El gate no es el tamaño de la factura —es modesto— sino que **el gasto es decisión de César**, y que
esa infraestructura vive en el tenant del cliente. El runbook está en la skill `mira-ops`, que se
ejecuta **con el sombrero de operador**, desde el repo del lab, no desde acá.

## Lo que espera a César (no lo mueve nadie más)

- **Las dos decisiones de arriba** (#190 y el diseño de #163).
- **#186**, y con él la ventana de terreno vivo.
- Los dos actos de QA: **`VERGIS_CSRF_SECRET`** y los **permisos del SP** sobre dos items del motor.
- El **ojo humano** al header del theme `default`.
- **Publicar `CONTRIBUTING.md`**: renombrar el `.draft.md` *es* el acto de publicación, y la ventana
  del dual licensing se cierra con el primer PR externo sin acuerdo.
- **Cortar la versión** que publique #182/#183/#185. El CHANGELOG no se tocó en ninguno de los tres
  PRs — la entrada se escribe al cortar, que es acto aparte.

**⚠ Al cortarla, el aviso al operador tiene que incluir el parseo estricto de `domains.yaml`** (#183):
una entrada de `stewards:` que no sea correo ni `group:<slug>` ahora **falla al arrancar**. Es lo que
el issue pide y el fallo es deseable —era una autorización que la instancia creía tener—, pero se
avisa antes, no después.

## Lo que espera al reloj

**PR #175** (digest de `caddy:2`): `test` ✓ `review` ✓, solo cuelga `renovate/stability-days`. Cuando
el cooldown de 14 días lo libere, mergea directo. **No se salta.**

**Sin verificar todavía**: que la regla de `renovate.json` gane sobre el preset `docker:pinDigests`.
La señal es que Renovate **no** vuelva a abrir `renovate/ghcr.io-gegolabs-vergis-latest`.

## Normas que rigen y no se re-litigan

| Norma | Dónde vive |
|---|---|
| **Rama + PR siempre** (nunca commit directo de código en `main`); la historia del repo **no** la deroga | `CLAUDE.md` · skill `git-repo-management` |
| **La frontera Producto↔operador**: publicamos versión + changelog + aviso; el deploy es del operador | `CLAUDE.md` · `DECISIONS.md` D-28 · preámbulo del `CHANGELOG.md` |
| **El cierre del issue es nuestro** — el autor reabre si no correspondía. El cierre no afirma más de lo medido | `CLAUDE.md` · skill `ww:repo` (Paso 6) |
| **El esquema admite Z** (corrección sin capacidad nueva) | `DECISIONS.md` D-29 · preámbulo del `CHANGELOG.md` |
| **El experimento lo corre quien publica**; la operación de un tercero corrobora, jamás mide por nosotros | Ley, **Norma 7** · corolario «quién corre el experimento» |

## Terreno ya recorrido — no reintentar

- **«No hay dónde medir lo que toca Fabric»** — falso para la semántica T-SQL (ver arriba). Sigue
  siendo cierto para SKU, permisos, costo y plano de control.
- **Esperar el despliegue del cliente para medir algo nuestro.** Es lo que decía el pendiente de #139
  y estaba mal escrito: la medición era **local**. La causa resultó ser que la observación del boot
  corría **antes** de registrar los watches, y como `env.reloadableContent` se **deriva** de ellos, el
  contrato persistía `VERGIS_POLICIES` como `bootOnly`. Arreglado en 0.16.1 sin depender del orden.
- **Subproceso para aislar el render Vega** — descartado con medición: el permission model de Node 22
  **no cubre la red**. La E/S se cerró con gate declarativo + loader que niega.
- **Migrar los specs del canon a `docs/`** — no se hace: el libro es **GNU FDL v1.3** y no mezcla con
  la AGPL de este repo. Se cita, no se copia (`docs/canon.md`).
- **Enmascarar en ClickHouse** — no hay dónde: ese back-end no controla la proyección.
- **Reconocer la vista de máscara por el prefijo `vw_mask_`** — descartado: falsificable por
  cualquiera con `CREATE VIEW`. El reconocimiento exige corroboración en `sys`.
- **Worktrees para paralelizar subagentes en este repo** — no sirven tal cual: un worktree nuevo no
  trae `node_modules` y los gates no corren. El reparto que funcionó fue por **conjuntos de archivos
  disjuntos**, con los ejecutores sin tocar git y el orquestador integrando.
- **`git add -A` con `NEXT.md` sucio** — se lleva el kit de retome dentro de un PR de código. Pasó en
  esta sesión (#190) y se corrigió con `--amend`. `NEXT.md` vive en disco y no se commitea.

<!-- retome escrito a mano · 2026-08-14 19:22 -04 · HEAD 15b0475 · sesión: #182/#183/#185 entregados, mergeados y cerrados · arnés T-SQL local (PR #190, sin mergear) · #163 reabierto con medición · #164 destrabado -->
