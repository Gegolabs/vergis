# NEXT — Vergis

**0.17.0 sigue siendo la versión publicada.** Esta sesión no cortó versión: levantó el **terreno
Fabric propio** (#186) y con él midió que una capacidad **ya publicada** no funciona (#197).

> **No hay trabajo en vuelo.** Este archivo no es un kit de retome pendiente: es el **estado** del
> proyecto y el índice de lo que espera a César. `/ww:go` no tiene nada que reanudar acá — si buscas
> en qué trabajar, la lista de abajo dice de quién es cada partida.

**El despliegue es del operador**, con su control de cambio. Si pregunta, la respuesta sigue siendo
que tome **0.17.0**. Ver `CLAUDE.md` §«La frontera» y `DECISIONS.md` D-28.

**⚠ Lo primero que hay que decirle al operador** sigue vigente y ahora tiene compañía: el parseo de
`domains.yaml` se volvió **estricto** (#183) y una entrada de `stewards:` inválida falla al arrancar
— se revisa **antes** del despliegue. Y lo nuevo: **el plano de columna de 0.16.0/0.17.0 no protege
columnas en Fabric** (#197). Qué se le dice y cuándo es decisión de César: es comunicación saliente.

## Lo que cambió cómo se trabaja: ya no hay excusa para nada que toque Fabric

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
npm run fab:resume && npm run fab:proof && npm run fab:pause
```

Terreno propio en tenant **ultraBASE**, desconectado del cliente, datos sintéticos, capacidad **F2
pausada por defecto** (US$0,36/h encendida; una sesión ≈ un dólar). Declarado en `RESOURCES.md`,
runbook en `scripts/README-fabric-lab.md`.

**Las dos asimetrías, que van en sentidos opuestos y no se pueden confundir al citar:**

| Arnés | Un **negativo** | Un **positivo** |
|---|---|---|
| `lab:proof` — T-SQL local, gratis | refuta también para Fabric | **no** garantiza Fabric |
| `fab:proof` — Fabric real, cuesta | definitivo para Fabric | vale para **este SKU y este rol** |

**El corolario que el primer día dejó, y que ninguna doc tenía:** que el motor **acepte** el DDL no
significa que el artefacto **sirva**. El `CREATE VIEW` de la máscara pasa en verde y todo `SELECT`
sobre ella falla. Un arnés que solo aplicara el setup y mirara `sys` habría dado verde entero.

## Lo que sigue abierto, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **#197** — la vista de máscara no sirve en Fabric | **César** decide el rediseño; la medición ya está | **Bifurcación viva**: la alternativa que funciona (variable local + `CASE`) **no cabe en una `VIEW`**. Candidatos: función escalar, tabla-función, o mover la discriminación fuera del artefacto |
| **El aviso al operador** sobre #197 | **César** | Comunicación saliente a un tercero: nunca fue del agente |
| **Capacidades Trial FTL64 y PP3** en ultraBASE | **César** (gasto) | *Active* en Chile Central, con `arbol-lab-smoke-test` y `arbol-lab-qw04`. No las tocamos; declaradas en `RESOURCES.md` |
| **#186** — terreno Fabric | Nuestro | **Levantado**; quedan 2 de 6 criterios: la medición de #164 corrida ahí, y barrer el pasivo que decía «no hay dónde medirlo» |
| **#164** — el allow-all sin columna rehén | Nuestro, **y ya no gated** | La traba dejó de ser estructural. **No medido todavía**, y no se da por hecho |
| **PR #175** — digest de `caddy:2` | El reloj | `test` ✓ `review` ✓; cuelga `renovate/stability-days`. Cuando el cooldown de 14 días lo libere, mergea directo. **No se salta** |
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

- **«No hay dónde medir lo que toca Fabric»** — falso, y ahora por los dos lados: falso para la
  semántica T-SQL desde el 2026-08-14 (`lab:proof`), y falso para el SKU desde el 2026-08-16
  (`fab:proof`). **La excusa se acabó entera.**
- **El Trial de Fabric** — descartado dos veces: muere a los 60 días y se lleva el terreno, y además
  **no hacía falta** (el tenant ultraBASE ya tenía Fabric habilitado y licencia).
- **Copiar datos del cliente al terreno** — descartado: el arnés mide **formas**, no datos, y una
  copia arrastra responsabilidad sin aportar verificación.
- **Bajar el rol del SP como mitigación de `UNMASK`** — no sirve como se esperaba: la revocación
  **no tomó efecto en 6,5 min** de sondeo. Qué la destraba no está medido (ficha en `PENDINGS.md`).
- **Creer la primera lectura tras cambiar un rol de workspace** — envenenó una medición de esta
  sesión: el primer veredicto sobre `UNMASK` fue el opuesto al correcto.
- **Tirar y recrear la vista-contrato de la instancia** — descartado **por autoridad, no por
  dificultad** (`DECISIONS.md` D-30).
- **Sacar el DDM y enmascarar solo en la vista** — descartado: cambiaría la promesa de seguridad sin
  decirlo. Y hoy además la vista no sirve en Fabric.

<!-- /ww:finish · 2026-08-16 · HEAD 0687da5 -->
