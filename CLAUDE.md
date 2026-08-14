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

**La versión que no existe también rompe la frontera.** Un operador solo puede ejercer su control de
cambio sobre algo que pueda **nombrar**: sin versión publicada, lo único que puede consumir es el
último commit de `main`, y entonces mergear *es* desplegar. Por eso el tag no es ceremonia — es la
condición de que la frontera exista. (Ocurrió: hasta 0.16.0, `latest` se movía en cada push a `main` y
el compose de la instancia apuntaba ahí — ver `DECISIONS.md` D-28.)

## El aterrizaje: rama + PR

**Todo cambio de código del Producto aterriza por rama y Pull Request contra `main`.** El merge es acto
de César; el agente entrega el PR con sus gates corridos y comenta el issue **sin cerrarlo**.

**El `git log` de este repo contradice esta norma y no la deroga.** Hay commits de feature directos en
`main` (`feat(163)`, `feat(164)`, `feat(159)`, entre otros): documentan lo que se decidió entonces, no lo
que rige ahora. Ante el choque, gana la norma — la duda no se resuelve mirando más commits.

Excepciones, y ninguna más: los commits de **registro y cierre de sesión** (`BITACORA.md`, `NEXT.md`,
`TODO.md`, `PENDINGS.md`, `DECISIONS.md`, `INDEX.md`) y el **hotfix con mandato explícito** dado en la
sesión. La ausencia de instrucción no es autorización para commitear directo.

Regla general y su porqué: skill `git-repo-management` §«El aterrizaje: rama + PR». Procedimiento
end-to-end del issue público: `/ww:work` scope `external`.

## Los gates

Los tres, en local, antes de cualquier PR — `npm run typecheck`, `npm test`, `npm run build`. Están
escritos con su detalle en `CONTRIBUTING.draft.md`; acá solo consta que **no son opcionales** y que su
salida real va en el cuerpo del PR.

`node` es keg-only en esta máquina: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.

---

• *Generado con Wingworking*
