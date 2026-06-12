# TODO

Pendientes del proyecto. Registro cronológico en `BITACORA.md`.

## Roadmap técnico

Detalle y justificación en `docs/mejoras-diagnostico.md`:

- [ ] Refactor de los tres monolitos: `render-html-piece.ts` (826 LOC), `MiraBotlet.invoke()` (6 fases en un método), `serve-rls.ts` (discovery + identidad + render + bootstrap)
- [ ] HMAC criptográfico en el gateo de anotaciones (hoy: token opaco validado server-side)
- [ ] Aislamiento del render Vega en subproceso sin red ni filesystem (defensa en profundidad)
- [ ] Caché de discovery de specs (hoy re-escanea por request; aceptable hasta ~cientos de specs)
- [ ] Migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/` (declarado en README)
- [ ] Port del kernel `@vergis/policy` a Go — solo cuando exista driver de negocio (Custos standalone, embedding, librería); ver `docs/adr-001-lenguaje-y-supply-chain.md`

### Pendientes de sesión 2026-06-11

- [ ] **Habilitar la app de Renovate** en el repo/org Gegolabs — `renovate.json` no opera sin la app instalada en GitHub
- [ ] **Redesplegar la VM con la imagen 0.2.2** — PI-01/04/12 corren la imagen anterior; la nueva cambia el arranque (`node dist/serve-rls.mjs`, non-root) y conviene verificar el deploy en vivo
- [ ] **Verificar render de charts con vega 6 en un PI real** — la suite no cubre SVG exacto de `distribution`; mirar un dashboard vivo tras el redeploy
