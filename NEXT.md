# NEXT — Vergis

**0.18.0 es la versión publicada** (tag `v0.18.0`, imagen construida). Trae cuatro afordancias que
maneja el lector —#203 #207 #209 #210—, sin migraciones que correr a mano y sin env nuevo.

> **No hay trabajo en vuelo.** Este archivo no es un kit de retome pendiente: es el **estado** del
> proyecto y el índice de lo que espera a César. `/ww:go` no tiene nada que reanudar acá — si buscas
> en qué trabajar, la lista de abajo dice de quién es cada partida.

**El despliegue es del operador**, con su control de cambio. Si pregunta, la respuesta es que tome
**0.18.0**. Ver `CLAUDE.md` §«La frontera» y `DECISIONS.md` D-28.

**⚠ Lo primero que hay que decirle al operador**, y sigue sin decirse: (1) el parseo de
`domains.yaml` es **estricto** desde #183 — una entrada de `stewards:` inválida falla al arrancar, y
se revisa **antes** del despliegue; (2) **el plano de columna no protege columnas en Fabric**, y eso
incluye 0.18.0 (#197). Qué se le dice y cuándo es decisión de César: es comunicación saliente. Ficha
en `PENDINGS.md`.

## Lo que cambió cómo se trabaja: ya no hay excusa para nada que toque Fabric

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
npm run fab:resume && npm run fab:proof && npm run fab:pause
```

Terreno propio en tenant **ultraBASE**, desconectado del cliente, datos sintéticos, capacidad **F2
pausada por defecto** (US$0,36/h encendida; una sesión ≈ un dólar). Declarado en `RESOURCES.md`,
runbook en `scripts/README-fabric-lab.md`.

**Higiene de la ventana, medida el 2026-08-18 y que conviene repetir:** la pausa va en un
`trap EXIT/INT/TERM`, no en acordarse — así la capacidad se apaga aunque el script reviente. Y
ningún comando `az` depende del default del CLI, que en esta máquina apunta al tenant **del
cliente**: se pasa `--subscription` explícito y se puede **verificar** decodificando el `tid` del
token emitido (debe dar `41eb660f…`, no `8c1604ef…`).

**Las dos asimetrías, que van en sentidos opuestos y no se pueden confundir al citar:**

| Arnés | Un **negativo** | Un **positivo** |
|---|---|---|
| `lab:proof` — T-SQL local, gratis | refuta también para Fabric | **no** garantiza Fabric |
| `fab:proof` — Fabric real, cuesta | definitivo para Fabric | vale para **este SKU y este rol** |

**Los dos corolarios que este terreno dejó, y que ninguna doc tenía:** que el motor **acepte** el DDL
no significa que el artefacto **sirva** — el `CREATE VIEW` de la máscara pasa en verde y todo
`SELECT` falla. Y su hermano, aprendido el 2026-08-18 corrigiendo un experimento propio a medio
medir: **que una vista se consulte no significa que discrimine**. Una vista que devuelve lo mismo con
y sin el claim pasa los dos filtros anteriores y no protege nada.

## Lo que sigue abierto, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **#197** — la vista de máscara no sirve en Fabric | **Nuestro**: la medición ya está, falta el rediseño | **Ya no es bifurcación a ciegas.** Medido el 18-ago: **C1** (CTE escalar + `CROSS JOIN`) y **C2** (`CROSS APPLY (VALUES …)`) aceptan, sirven **y discriminan**; C3 (sin `CASE`) rechazada. Falta cambiar `packages/policy/src/fabric.ts` y **re-correr `fab:proof` con la forma que emita el compilador**, no con el SQL a mano de P6 |
| **#164** — el allow-all sin columna rehén | **Nuestro**, medido | `ADD FILTER PREDICATE` **sin argumento: ACEPTADO** en el SKU, con control positivo y verificando que la tabla siga sirviendo sus filas (no deny silencioso). Falta el codegen. **Dos decisiones son de César**: qué pasa con `bindColumn` en la API (contrato que las instancias consumen) y si la instancia re-aplica los 34 `ADD FILTER PREDICATE` desplegados |
| **El aviso al operador** de 0.18.0 + #197 | **César** | Comunicación saliente a un tercero: nunca fue del agente. Ficha con el contenido exacto en `PENDINGS.md` |
| **P5 (#163)** — ¿el SP de serving tiene `UNMASK`? | **César** (credencial) | Sigue **sin responder**: falta `FAB_SP_TOKEN` y el secreto del SP no está en la máquina. El arnés lo declara y no lo cuenta como verde. Si nadie lo regenera antes, **la próxima ventana también lo desperdicia** |
| **#186** — terreno Fabric | Nuestro | Levantado y ya rindió. Queda **un** criterio: barrer las partidas de `PENDINGS.md` cuya única traba era «no hay dónde medirlo» |
| **Capacidades Trial FTL64 y PP3** en ultraBASE | **César** (gasto) | *Active* en Chile Central, con `arbol-lab-smoke-test` y `arbol-lab-qw04`. No las tocamos; declaradas en `RESOURCES.md` |
| **PRs #175 y #201** — digests de `caddy:2` y `python:3.12-slim` | El reloj | `test` ✓ `review` ✓; cuelga `renovate/stability-days`. Cuando el cooldown de 14 días los libere, mergean directo. **No se salta** |
| **`VERGIS_CSRF_SECRET` en QA** | César | Acto de instancia |
| **El ojo humano** al header del theme `default` | César | — |
| **Publicar `CONTRIBUTING.md`** | César | Renombrar el `.draft.md` *es* el acto |

**Las dos consultas de instancia que más rinden por lo que cuestan**, y deciden si #197 muerde hoy:
*¿algún PI nombra una `vw_mask_*`?* y *¿con qué rol de workspace corre el SP de serving?* Son
consultas, no frentes.

## Normas que rigen y no se re-litigan

| Norma | Dónde vive |
|---|---|
| **Rama + PR siempre** (nunca commit directo de código en `main`); la historia del repo **no** la deroga | `CLAUDE.md` · skill `git-repo-management` |
| **El merge de lo CONFIRMADO es nuestro** — gates + CI + evidencia medida. Sin medición no hay merge | `CLAUDE.md` · `DECISIONS.md` **D-31** |
| **La frontera Producto↔operador**: publicamos versión + changelog + aviso; el deploy es del operador | `CLAUDE.md` · `DECISIONS.md` D-28 |
| **El cierre del issue es nuestro** — el autor reabre si no correspondía. El cierre no afirma más de lo medido | `CLAUDE.md` · skill `ww:repo` |
| **El esquema admite Z** (corrección sin capacidad nueva) | `DECISIONS.md` D-29 |
| **El experimento lo corre quien publica**; la operación de un tercero corrobora, jamás mide por nosotros | Ley, **Norma 7** |

## Terreno ya recorrido — no reintentar

- **«No hay dónde medir lo que toca Fabric»** — falso por los dos lados: para la semántica T-SQL
  desde el 2026-08-14 (`lab:proof`), y para el SKU desde el 2026-08-16 (`fab:proof`).
- **«La discriminación por claim no cabe dentro de una `VIEW` en Fabric»** — **refutado el
  2026-08-18**. Era cierto de la forma con variable local (`DECLARE`), y de ahí se generalizó de más:
  C1 y C2 la expresan dentro de una vista y funcionan. Lo que decide no es el `CASE` sino **de dónde
  viene el claim** — materializado en una fuente escalar de una fila pasa; evaluado inline contra el
  scan, no. C3 lo confirma: no usa `CASE` y también la rechaza.
- **El Trial de Fabric** — descartado dos veces: muere a los 60 días y se lleva el terreno, y además
  **no hacía falta** (el tenant ultraBASE ya tenía Fabric habilitado y licencia).
- **Copiar datos del cliente al terreno** — descartado: el arnés mide **formas**, no datos, y una
  copia arrastra responsabilidad sin aportar verificación.
- **Bajar el rol del SP como mitigación de `UNMASK`** — no sirve como se esperaba: la revocación
  **no tomó efecto en 6,5 min** de sondeo. Qué la destraba no está medido (ficha en `PENDINGS.md`).
- **Creer la primera lectura tras cambiar un rol de workspace** — envenenó una medición: el primer
  veredicto sobre `UNMASK` fue el opuesto al correcto.
- **Declarar viable una forma de vista por verla «crear y consultar»** — insuficiente, y casi se
  publica así el 18-ago: falta el control de que **discrimine** con y sin el claim.
- **Tirar y recrear la vista-contrato de la instancia** — descartado **por autoridad, no por
  dificultad** (`DECISIONS.md` D-30).
- **Sacar el DDM y enmascarar solo en la vista** — descartado: cambiaría la promesa de seguridad sin
  decirlo. Y la vista, hasta que se rediseñe, no sirve en Fabric.

<!-- /ww:finish · 2026-08-18 · HEAD 2a52eeb -->
