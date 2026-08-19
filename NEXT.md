# NEXT — Vergis

**0.19.0 es la versión publicada** (tag `v0.19.0`, 2026-08-18). Antes: 0.18.0. Trae cuatro afordancias que
maneja el lector —#203 #207 #209 #210—, sin migraciones que correr a mano y sin env nuevo.

**En `main` y SIN publicar** (2026-08-18, tarde): **#197** —la vista de máscara ya sirve y discrimina
en Fabric— y **#164** —el allow-all dejó de tomar rehén a una columna de negocio; `bindColumn` salió
del contrato—. Los dos con su medición contra motor y con entrada de CHANGELOG escrita bajo «Sin
publicar». **El corte de versión no se hizo**, y la razón consta: `main` trae además #220 y #222, de
otra sesión, que ésta no midió — y una versión declara *qué trae*.

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

## Lo que cambió cómo se trabaja (2): el gasto chico ya no se pregunta

**Este proyecto tiene `POLICIES.md`** — el canónico donde César declara lo que autorizó de antemano.
Vigente **POL-01**: pote de **US$50/mes** para recursos externos con costo, con techo de **US$10 por
acto**. La regla: **lo que cae bajo el techo NO se consulta** —consultarlo le devuelve un trámite que
él ya resolvió— y **lo que lo excede se detiene y se pide**, nunca se ejecuta para avisar después.

**Efecto concreto para el trabajo que sigue:** encender la capacidad F2 del terreno propio
(US$0,36/h, ≈US$1 la sesión) **se hace sin preguntar** y se asienta en `POLICIES-ledger.md`, que nace
con el primer gasto. Lo que **sigue siendo de César** no cambió, y la distinción es la que importa:
`FAB_SP_TOKEN` es una **credencial**, no un gasto — ahí el gate nunca fue la plata. Y nada del tenant
**del cliente** entra jamás, cueste lo que cueste.

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
| ~~**#197**~~ — la vista de máscara no sirve en Fabric | — | **CERRADO** (PR #221). Forma C2 en el compilador, medida con el SQL **emitido**: la vista sirve **y discrimina**. Falta solo P5 (`UNMASK` del SP) |
| ~~**#164**~~ — el allow-all sin columna rehén | — | **CERRADO** (PR #223). Predicado sin argumento, medido en **los dos motores** con el SQL emitido y con el control que decide: el `ALTER` sobre una columna de negocio **con la policy instalada, ACEPTADO**. `bindColumn` retirado del contrato (D-40) |
| ~~**Cortar la versión**~~ | — | **HECHO: `v0.19.0` publicada** (PR #224, tag empujado, imagen construyéndose). Trae #197 #164 #220 #222. Los PRs ajenos resultaron del frente **arbol/lab**, que trabaja sobre un clon del mismo repo; su autor declaró qué midió y qué no |
| **CORTAR 0.20.0** ⟵ **el primer acto del retome** | **Nuestro, ya decidido** | César aprobó que el cableado entrara con una 0.20.0 detrás. **#225 ya está mergeado** (`7759491`) y los gates corridos por mí sobre el `main` integrado: **160 archivos · 2275 tests**, typecheck y build verdes. Falta solo el corte: CHANGELOG (la sección ya está escrita bajo «Sin publicar»), `package.json` → 0.20.0, tabla de tags, PR, CI, tag `v0.20.0`, y verificar el push de la imagen **en el log del workflow** |
| **El aviso al operador**, ahora de **0.19.0** | **César** | Comunicación saliente. Cambió de contenido: ya no es solo el parseo estricto de `domains.yaml` — ahora hay **cambio de contrato** (`bindColumn`) y una **migración no opcional** para obtener el efecto de #164, con su advertencia de aviso apagado. Todo escrito en el CHANGELOG |
| **El aviso al operador** de 0.18.0 + #197 | **César** | Comunicación saliente a un tercero: nunca fue del agente. Ficha con el contenido exacto en `PENDINGS.md` |
| **P5 (#163)** — ¿el SP de serving tiene `UNMASK`? | **César** (credencial, **no** gasto: POL-01 no lo cubre) | Sigue **sin responder**: falta `FAB_SP_TOKEN` y el secreto del SP no está en la máquina. El arnés lo declara y no lo cuenta como verde. Si nadie lo regenera antes, **la próxima ventana también lo desperdicia** |
| **#186** — terreno Fabric | Nuestro | Levantado y ya rindió. Queda **un** criterio: barrer las partidas de `PENDINGS.md` cuya única traba era «no hay dónde medirlo». **La ventana que ese barrido necesita ya no se pide**: entra bajo POL-01 |
| **Capacidades Trial FTL64 y PP3** en ultraBASE | **César** (gasto) | *Active* en Chile Central, con `arbol-lab-smoke-test` y `arbol-lab-qw04`. No las tocamos; declaradas en `RESOURCES.md` |
| **PRs #175 y #201** — digests de `caddy:2` y `python:3.12-slim` | El reloj | `test` ✓ `review` ✓; cuelga `renovate/stability-days`. Cuando el cooldown de 14 días los libere, mergean directo. **No se salta** |
| **`VERGIS_CSRF_SECRET` en QA** | César | Acto de instancia |
| **El ojo humano** al header del theme `default` | César | — |
| **Publicar `CONTRIBUTING.md`** | César | Renombrar el `.draft.md` *es* el acto |

**Las dos consultas de instancia que más rinden por lo que cuestan**, y deciden si #197 muerde hoy:
*¿algún PI nombra una `vw_mask_*`?* y *¿con qué rol de workspace corre el SP de serving?* Son
consultas, no frentes.

## El hilo abierto de la práctica: el canónico nuevo todavía no se consume solo

`POLICIES.md` quedó registrado en el Reglamento (`ww:wingworking`), enumerado por `ww:start` y con la
excepción de gasto corregida en `ww:deuda` §Paso 4 — que decía «Gasto» fuera de todo mandato **sin
excepción** y era citada por `ww:work` como la lista vigente.

**Lo que NO está hecho, y se dice con esas palabras:** el Reglamento promete que *«lo que cae bajo una
política vigente deja de aparecer en el bloque Decisiones de `/ww:work`»*, y **ninguna skill implementa
esa lectura**. En Vergis funciona **por otra vía** —el `CLAUDE.md` del proyecto lo ancla y se inyecta
en toda sesión—, así que la mitigación es local y la promesa es general. Ficha en `PENDINGS.md`
(`reg 2026-08-18`); lo barato es que el paso de enumeración de `/ww:work` lea el archivo y filtre.

**Cambios sin sellar en `protocolos` que NO son de esta sesión:** `sov/skills/asimilacion/SKILL.md` y
`skills/go/SKILL.md`. Fenómeno **W-01, ocurrencia 22** (registrada). No se juzgan ni se sellan desde
acá; el commit de esta sesión fue por ruta explícita.

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

## Lo que esta sesión dejó medido y no hay que volver a preguntar

- **La vista de máscara SÍ discrimina en Fabric** con la forma C2 emitida por el compilador. El
  `NVARCHAR(MAX)` del `CAST` **no** estorba (el diagnóstico que lo aislaba no llegó a correr).
- **El allow-all sin columna suelta el rehén de verdad**: con la policy instalada, el `ALTER` sobre
  una columna de negocio **se acepta** — en SQL Server 2022 y en el SKU F2. Ese control no existía en
  ninguna corrida anterior; P7 medía la forma, no la consecuencia.
- **La ventana cuesta ~US$0,01 por corrida** (2 min de F2). El pote de POL-01 está casi intacto:
  US$0,04 de US$50. El costo dejó de ser un argumento para no medir.
- **El `trap EXIT/INT/TERM` funciona y la ventana tiene que ser UN solo comando de shell** — si el
  resume va en un comando y el proof en otro, el trap del primero pausa la capacidad antes de medir.

## La custodia, que cambió cómo se trabaja este repo (2026-08-18)

**`arbol` propone · `vergis` dispone · sin self-merge**, y el aviso previo antes de abrir PR va en los
dos sentidos. Está en `CLAUDE.md` §«La custodia» (PR #226). Nació de que los dos frentes escribieron
el repo la misma tarde sin saberlo — ninguno hizo nada prohibido; **faltaba el custodio**.

**Qué significa en la práctica para la próxima sesión:** los PRs de arbol llegan y **los mergeamos
nosotros**, después de correr los gates **por nuestra mano** y verificar que componen. Ya se ejerció
una vez con #225 y funcionó: él avisó antes, no tocó el merge, y declaró sus «sin medir».

## Lo que la revisión de #225 dejó anotado y NO está en ningún PR

**El healthcheck de `docker-compose.yml` juzga por `r.ok`** —o sea, 200 = sano— y un nodo en
**`standby` responde 200 con `ok:true`**. O sea que Docker considerará «healthy» a un nodo que **no
está sirviendo**. Hoy no muerde: el `compose.reference.yml` que consume la instancia **no declara
healthcheck** (solo `depends_on` sin `condition: service_healthy`). Pero **muerde el día que alguien
enrute por salud**, y el predicado correcto está escrito en el código: `200 ∧ phase=serving ∧
pis.serving=N`. Conviene decirlo en el aviso de 0.20.0.

<!-- /ww:next · 2026-08-18 · HEAD 7759491 -->
