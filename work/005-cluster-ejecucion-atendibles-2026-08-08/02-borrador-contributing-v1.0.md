# 005·02 · Borrador de `CONTRIBUTING.md` — NO publicado, gated por revisión legal

**Estado: BORRADOR.** César decidió (2026-08-08, TODO.md) que la cláusula de licencia de
contribución no se publica sin su revisión o la de un abogado. Este archivo es el insumo de esa
revisión; cuando la apruebe, su contenido (desde la línea de corte) se copia a `/CONTRIBUTING.md`
y este documento registra la fecha. **Riesgo mientras tanto (E1 del ADR-002):** si llega un PR
externo antes de publicarlo, el mecanismo se instala de emergencia primero — el evento lo vence.

---

## ⬇ Contenido propuesto para `/CONTRIBUTING.md` (corte aquí)

# Contributing to Vergis

Thanks for your interest in Vergis. Before opening a pull request, please read the two sections
below — the first is about code, the second is about licensing and takes one line of your commit
message.

## Running the gates

```bash
npm ci
npm run typecheck
npm test
npm run build
```

All three must pass. The suite is the same one CI runs; if it is green locally, CI will agree.

The open-core boundary of this project is defined in
[`docs/adr-002-open-core.md`](docs/adr-002-open-core.md) — new pieces are classified in their
design documents, citing the test that decides.

## Licensing of contributions

Vergis is licensed under **AGPL-3.0-or-later**. By submitting a contribution you agree to both of
the following:

1. **Developer Certificate of Origin (DCO).** You certify the
   [Developer Certificate of Origin v1.1](https://developercertificate.org/): the contribution is
   your original work (or you have the right to submit it) and you have the right to license it.
   Sign every commit with `git commit -s`, which appends:

   ```
   Signed-off-by: Your Name <your@email>
   ```

   Pull requests with unsigned commits will be asked to rebase.

2. **Contribution license grant.** <!-- redacción sujeta a revisión legal — NO publicar sin ella -->
   You grant Gegolabs a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to
   use, reproduce, modify, distribute and **sublicense or relicense** your contribution as part of
   Vergis, including under licenses other than the AGPL. Your contribution remains available under
   the AGPL-3.0-or-later in this repository; this grant additionally preserves the project's
   ability to offer commercial licenses. You retain your copyright.

If you cannot agree to the grant in (2), please open an issue describing your intended
contribution instead of a pull request, so we can discuss options.

---

## Notas para la revisión legal (no van al archivo publicado)

- La cláusula (2) es un **CLA-ligero inline**: el mínimo que preserva la ventana del dual
  licensing (diseño `004/11` D5). La alternativa descartada — DCO solo — mantiene limpio el
  inbound pero NO habilita relicenciar.
- Preguntas concretas para el abogado: (a) ¿la aceptación implícita por el acto del PR es
  ejecutable en las jurisdicciones que importan, o hace falta un check explícito (bot de
  CLA-assistant)?; (b) ¿la redacción del grant cubre patentes o conviene una cláusula de licencia
  de patente expresa (estilo Apache-2.0 §3)?; (c) ¿«as part of Vergis» acota demasiado el
  sublicenciamiento?
- El enforcement mecánico del sign-off (DCO check en CI) se agrega cuando esto se publique —
  una action estándar, sin infra.

---
• 🤖 Claude (Fable) · borrador para revisión de César/abogado · cluster 005 · 2026-08-08
