# NEXT — Vergis

**0.17.0 publicada** (2026-08-14) — CHANGELOG, tag `v0.17.0`, imagen multi-arch y GitHub Release.
Cuatro issues cerrados (#182 #183 #185 #163) y el plano de columna documentado en `docs/`; suite en
**2125 tests**, typecheck y build verdes, `main` limpio y pusheado.

> **No hay trabajo en vuelo.** Este archivo no es un kit de retome pendiente: es el **estado** del
> proyecto y el índice de lo que espera a César. `/ww:go` no tiene nada que reanudar acá — si buscas
> en qué trabajar, la lista de abajo dice de quién es cada partida.

**El despliegue es del operador**, con su control de cambio. Si pregunta, la respuesta es que tome
**0.17.0** directamente. Ver `CLAUDE.md` §«La frontera» y `DECISIONS.md` D-28.

**⚠ Lo primero que hay que decirle al operador**, y ya está en el Release y en el CHANGELOG: el
parseo de `domains.yaml` se volvió **estricto** (#183). Una entrada de `stewards:` que no sea correo
válido ni `group:<slug>` **falla al arrancar**. Es deseable —era una autorización que la instancia
creía tener—, pero se revisa **antes** del despliegue, no después.

## Lo que cambió cómo se trabaja: el terreno T-SQL propio

`npm run lab:up && npm run lab:proof && npm run lab:down`. Un motor real en contenedor, local, gratis
y sin tocar infraestructura de nadie, que aplica **el DDL que emite `compileFabric`** — uno que
escriba su propio SQL se mide a sí mismo.

**La premisa que sostenía siete pendientes —«no hay dónde medir lo que toca Fabric»— es falsa para la
semántica del lenguaje.** El compilador emite T-SQL, y un motor T-SQL cabe en un contenedor. De ahí
salieron los tres defectos de #163; ninguno se dedujo.

**La asimetría que NO se puede olvidar al citar un resultado de ahí:** un **negativo** refuta también
para Fabric; un **positivo NO garantiza Fabric**. Está escrito en la cabecera del script y en
`scripts/README-tsql-lab.md` para no depender de que alguien se acuerde.

## Lo que sigue abierto, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **#186** — terreno Fabric propio | **César** (gasto + tenant) | Vivo, mejor delimitado, **menos urgente**: ya no bloquea corregir defectos publicados |
| **#164** — el allow-all sin columna rehén | Nuestro, **pero gated por Fabric** | La forma **es válida en T-SQL**, medida con control positivo. Falta verla pasar en Fabric: emitirla antes sería la Norma 7 al revés |
| **PR #175** — digest de `caddy:2` | El reloj | `test` ✓ `review` ✓; cuelga `renovate/stability-days`. Cuando el cooldown de 14 días lo libere, mergea directo. **No se salta** |
| **`VERGIS_CSRF_SECRET` en QA** y los **permisos del SP** sobre dos items del motor | César | Dos actos de instancia |
| **El ojo humano** al header del theme `default` | César | — |
| **Publicar `CONTRIBUTING.md`** | César | Renombrar el `.draft.md` *es* el acto; la ventana del dual licensing se cierra con el primer PR externo sin acuerdo |

**El dato de instancia que más rinde por lo que cuesta:** *¿el service principal de serving tiene
`UNMASK`?* El **mecanismo** ya está medido —sin él, ni el sujeto con el claim ve el valor; con él, la
vista discrimina por claim—. Lo que falta es una **consulta**, no un frente.

## #186 — qué queda y con qué criterio nuevo

Solo lo que Fabric contesta: **SKU**, permisos de un service principal concreto, **costo** de
enforcement, plano de control, **OneLake/`Files/`**, jobs, contrato `_logs/`, correlación carga↔corrida
(#161/#162) y los gates manuales de 0.14.0.

Sigue en pie lo decidido: terreno **desconectado** del cliente, datos **sintéticos**, capacidad **F2
pausada** (≈US$0,36/h, una sesión ≈ un dólar), **NO Trial**.

**Criterio que el issue no tenía y conviene fijar al levantarlo:** el bootstrap del terreno Fabric
debe levantar **la misma forma** que el arnés local, para que la única diferencia entre los dos sea
el motor. Un banco que además difiere en el esquema mide dos cosas a la vez y no distingue cuál falló.

## La ventana de terreno vivo del cliente — encogida

`az vm start -g rg-arbol-qw04 -n vm-vergis-qa` (~1 min) contra `ws-arbol-qa`, medir, apagar. **Se le
cayeron dos de las cuatro preguntas** (el `ADD MASKED` sobre vista-contrato y la forma de #164 ya
tienen respuesta en la familia T-SQL). Queda:

1. **¿El SP de serving tiene `UNMASK`?** — control obligatorio, misma sesión: consulta a la tabla
   **sin** vista.
2. **¿El SKU acepta las formas que acá pasaron?** — los positivos no viajan solos.
3. El **costo de enforcement por columna**, de paso.

El gate no es el tamaño de la factura —es modesto— sino que **el gasto es decisión de César**, y que
esa infraestructura vive en el tenant del cliente. El runbook está en la skill `mira-ops`, que se
ejecuta **con el sombrero de operador**, desde el repo del lab, no desde acá.

## Normas que rigen y no se re-litigan

| Norma | Dónde vive |
|---|---|
| **Rama + PR siempre** (nunca commit directo de código en `main`); la historia del repo **no** la deroga | `CLAUDE.md` · skill `git-repo-management` |
| **La frontera Producto↔operador**: publicamos versión + changelog + aviso; el deploy es del operador | `CLAUDE.md` · `DECISIONS.md` D-28 · preámbulo del `CHANGELOG.md` |
| **El cierre del issue es nuestro** — el autor reabre si no correspondía. El cierre no afirma más de lo medido | `CLAUDE.md` · skill `ww:repo` (Paso 6) |
| **El esquema admite Z** (corrección sin capacidad nueva) | `DECISIONS.md` D-29 · preámbulo del `CHANGELOG.md` |
| **El experimento lo corre quien publica**; la operación de un tercero corrobora, jamás mide por nosotros | Ley, **Norma 7** · corolario «quién corre el experimento» |

## Terreno ya recorrido — no reintentar

- **«No hay dónde medir lo que toca Fabric»** — falso para la semántica T-SQL. Sigue siendo cierto
  para SKU, permisos, costo y plano de control.
- **Tirar y recrear la vista-contrato de la instancia** para poder enmascarar — descartado **por
  autoridad, no por dificultad** (`DECISIONS.md` D-30): es artefacto suyo, su forma es un contrato con
  sus consumidores, puede tener índices, y un fallo a mitad la deja sin él.
- **Sacar el DDM y enmascarar solo en la vista** — descartado: cambiaría la promesa de seguridad sin
  decirlo. Que hoy sea inerte para el serving no lo vuelve inútil, lo vuelve inútil *para ese principal*.
- **Guardar un `DROP MASKED` con `IF EXISTS` a secas** — no guarda: T-SQL compila el batch antes de
  ejecutarlo. El `ALTER` va dentro de `EXEC(...)`.
- **Mirar la dependencia de OBJETO en el preflight de máscara** — falso positivo: la propia security
  policy de fila es `SCHEMABINDING`. Solo dependencias de **columna**. Hay test de regresión.
- **Esperar el despliegue del cliente para medir algo nuestro** (#139) — la medición era local. La
  causa era el orden de cableado del boot; arreglado en 0.16.1 sin depender del orden.
- **Subproceso para aislar el render Vega** — descartado con medición: el permission model de Node 22
  **no cubre la red**.
- **Migrar los specs del canon a `docs/`** — no se hace: el libro es **GNU FDL v1.3** y no mezcla con
  la AGPL de este repo. Se cita, no se copia (`docs/canon.md`).
- **Enmascarar en ClickHouse** — no hay dónde: ese back-end no controla la proyección.
- **Reconocer la vista de máscara por el prefijo `vw_mask_`** — falsificable por cualquiera con
  `CREATE VIEW`. El reconocimiento exige corroboración en `sys`.
- **Worktrees para paralelizar subagentes en este repo** — un worktree nuevo no trae `node_modules` y
  los gates no corren. El reparto que funcionó fue por **conjuntos de archivos disjuntos**.
- **`git add -A` con `NEXT.md` sucio** — se lleva el kit de retome dentro de un PR de código. Pasó en
  esta sesión (#190) y se corrigió con `--amend`. `NEXT.md` vive en disco y no se commitea.

<!-- /ww:finish · 2026-08-16 · HEAD 1c93ce4 · estado, no residuo: 0.17.0 publicada y sin trabajo en vuelo -->
