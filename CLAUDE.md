# Normas locales — Vergis

> Subordinado a la Constitución (`~/.claude/CLAUDE.md`): concreta sus reglas para este repo, nunca las
> contradice. Solo entra acá lo que **no** se deriva del código, del `git log` ni de la doc del repo.

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
