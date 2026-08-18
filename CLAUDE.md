# Normas locales — Vergis

> Subordinado a la Constitución (`~/.claude/CLAUDE.md`): concreta sus reglas para este repo, nunca las
> contradice. Solo entra acá lo que **no** se deriva del código, del `git log` ni de la doc del repo.

## La frontera: acá se es el PRODUCTO, no el operador

**Este repo es el Producto. Su entregable termina en una versión publicada, con su changelog y su
aviso. El despliegue es de quien opera la instancia, con su política de control de cambio.**

No es una división de tareas: es **quién tiene la autoridad**. Un despliegue toca datos, disponibilidad
y ventanas de un tercero, y esa decisión no es del que escribe el código.

| Nos toca | No nos toca |
|---|---|
| Cortar la versión (CHANGELOG + `package.json` + tag `vX.Y.Z`) | Elegir **qué** versión corre una instancia |
| Publicar la imagen (la dispara el tag; ver la tabla de tags del CHANGELOG) | Decidir **cuándo** entra |
| Declarar **qué trae y qué exige** — migraciones, env nuevo, capacidades sin verificar contra motor vivo | El `pull`, el recreate, la ventana, el rollback |
| Avisar por el canal del cliente | Su control de cambio, su QA, su respaldo |

**El sombrero se elige por el repo, no por la capacidad.** La skill `mira-ops` sabe desplegar y **es del
operador**: se ejecuta desde el repo del lab de A.R.B.O.L., no desde acá. Una sesión de este repo que
recibe «hay que desplegar esto» no despliega — **publica y avisa**. Si César pide explícitamente en la
sesión que operemos la VM, ahí el sombrero cambia por su acto, y consta.

**El corolario que se olvida:** un pendiente que dice «falta desplegar» **no es pasivo nuestro**. Si de
verdad lo es, es porque falta publicar o falta avisar — y eso se escribe con esas palabras.

**Y el corolario que corta para el otro lado: su despliegue corrobora, jamás mide por nosotros.** La
frontera reparte autoridad sobre el despliegue; **no** traslada nuestra verificación. Un pendiente
escrito como *«esperando el próximo despliegue para saber si esto funciona»* está mal escrito dos
veces: el mecanismo se mide con arnés propio —local, sin VM, sin plata—, y lo único que legítimamente
se espera del operador es si el cambio **satisface** lo que pidió. Las dos preguntas se distinguen por
quién puede responderlas:

| Pregunta | ¿De quién es? |
|---|---|
| «¿Mi mecanismo hace lo que digo?» | **Nuestra.** Si falta medirla, falta el arnés — no falta un despliegue |
| «¿Esto satisface lo que pedí?» | Del que pidió. Se espera, y no bloquea el cierre del issue |

Ley, Norma 7 · «Corolario sobre quién corre el experimento». Precedente: el delta del contrato de #139,
publicado dos versiones con su mecanismo sin medir y el pendiente redactado como si dependiera del
operador.

**La versión que no existe también rompe la frontera.** Un operador solo puede ejercer su control de
cambio sobre algo que pueda **nombrar**: sin versión publicada, lo único que puede consumir es el
último commit de `main`, y entonces mergear *es* desplegar. Por eso el tag no es ceremonia — es la
condición de que la frontera exista. (Ocurrió: hasta 0.16.0, `latest` se movía en cada push a `main` y
el compose de la instancia apuntaba ahí — ver `DECISIONS.md` D-28.)

## El aterrizaje: rama + PR

**Todo cambio de código del Producto aterriza por rama y Pull Request contra `main`.** El agente entrega
el PR con sus gates corridos, **cierra el issue que atendió** y **mergea lo que está confirmado**.

**El merge de lo confirmado es nuestro** (decisión de César, 2026-08-16 — deroga para este proyecto el
default de `git-repo-management`, que reserva el merge al humano). *Confirmado* tiene un significado
exacto y no es «me parece que quedó»: **gates verdes, CI verde, y evidencia medida de que el problema
que el PR dice resolver quedó resuelto**. Con eso, pedir el merge le devuelve un trámite, no una
decisión — y el pasivo se acumula por un clic.

Lo que **no** se mergea solo, porque ahí sí hay decisión y no trámite:

| Caso | Por qué sube a César |
|---|---|
| El PR **no tiene la medición** que respalde su promesa | Mergear afirmaría más de lo medido (Ley, Norma 7) |
| Diseño abierto — el PR elige un camino entre varios vivos | La bifurcación es suya; el PR es el material para decidirla |
| Toca **gasto por encima del presupuesto declarado** | Bajo el techo de `POLICIES.md` el agente actúa sin consultar y lo asienta; **por encima se detiene y pide** |
| Toca **comunicación saliente** a un tercero | Nunca fue del agente — es su voz y su relación, y ningún presupuesto la cubre |
| **PR de otra persona** | El acto es suyo; nuestro entregable es el veredicto comentado |

Si al ver un merge considera que no correspondía, revierte — revertir es barato y el PR conserva la
conversación entera. Es la misma economía que ya rige para el cierre de issues.

**El cierre del issue es nuestro, no del autor** (decisión de César, 2026-08-14 — deroga para este
proyecto el default de `ww:work`/`ww:repo`, que reserva el cierre al autor). No se puede esperar a que
el autor de cada request lo cierre: el pasivo se acumularía por un trámite. **Si al verlo considera que
no correspondía, lo reabre** — reabrir es barato, y el issue conserva la conversación entera.

Lo que el cierre **no** hace es afirmar más de lo medido: el comentario de cierre dice qué se verificó,
qué versión lo publica y **qué queda sin evidencia**. Un requisito nacido de un incidente no está
demostrado hasta que la instancia corra la versión y el fenómeno no reaparezca; eso se escribe con esas
palabras y se nombra la condición que reabriría el issue.

Sigue intacto lo que protege a terceros: **jamás se cierra el issue ni el PR de otra persona** — ahí el
acto es suyo, y el entregable nuestro es el veredicto comentado.

**El `git log` de este repo contradice esta norma y no la deroga.** Hay commits de feature directos en
`main` (`feat(163)`, `feat(164)`, `feat(159)`, entre otros): documentan lo que se decidió entonces, no lo
que rige ahora. Ante el choque, gana la norma — la duda no se resuelve mirando más commits.

Excepciones, y ninguna más: los commits de **registro y cierre de sesión** (`BITACORA.md`, `NEXT.md`,
`TODO.md`, `PENDINGS.md`, `DECISIONS.md`, `INDEX.md`) y el **hotfix con mandato explícito** dado en la
sesión. La ausencia de instrucción no es autorización para commitear directo.

Regla general y su porqué: skill `git-repo-management` §«El aterrizaje: rama + PR». Procedimiento
end-to-end del issue público: `/ww:work` scope `external`.

## Lo autorizado por adelantado: `POLICIES.md`

**Este proyecto tiene autorizaciones permanentes declaradas por César, y viven en `POLICIES.md`.**
Se lee al arrancar cualquier trabajo que pueda gastar: **lo que cae bajo una política vigente NO se
consulta** —consultarlo le devuelve un trámite que él ya resolvió— y **lo que la excede se detiene y
se pide**, jamás se ejecuta para avisar después.

Vigente hoy: **POL-01**, presupuesto de recursos externos con costo. El caso que más aparece acá es
la capacidad F2 del terreno Fabric propio (US$0,36/h): **entra, y se corre sin preguntar**. La del
tenant del cliente no entra jamás — ahí el gate nunca fue la plata, sino la frontera de arriba.

El consumo se asienta en `POLICIES-ledger.md`, que nace con el primer gasto.

## Los gates

Los tres, en local, antes de cualquier PR — `npm run typecheck`, `npm test`, `npm run build`. Están
escritos con su detalle en `CONTRIBUTING.draft.md`; acá solo consta que **no son opcionales** y que su
salida real va en el cuerpo del PR.

`node` es keg-only en esta máquina: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.

---

• *Generado con Wingworking*
