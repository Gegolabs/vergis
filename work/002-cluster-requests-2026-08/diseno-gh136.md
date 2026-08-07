# Diseño #136 — «Volver al catálogo» a la mano (logo-link + entrada en la bandeja)

> Contrato de delegación wingcoding: Fable diseñó, Opus implementa en frío.
> Issue: <https://github.com/Gegolabs/vergis/issues/136> · Aprobado por César 2026-08-06 («haz los dos»).

## ¿Qué se construye?

Convención de plataforma (todos los PIs, ambos themes, nada per-spec):

1. **El logo/marca del header enlaza a `/`** (el catálogo), con `title="Volver al catálogo"` y
   `aria-label="Volver al catálogo"`.
2. **Entrada «← Catálogo» al tope de la bandeja** (inspector), server-rendered, enlace simple a `/`.

## Decisiones selladas

- **D1 — Destino `/` literal.** El catálogo vive en la raíz (`renderIndexPage`); ya está gateado por
  identidad y filtra por lo abrible. No se inventa config para el destino.
- **D2 — El logo-link va en el THEME** (donde se compone el header): `themes/arbol.ts` (la imagen
  del logo) y `themes/default.ts` (la marca/título del header, lo que haga de «logo» ahí). El `<a>`
  no cambia el layout: `display:inline-block`/heredado, sin subrayado (`text-decoration:none`),
  cursor pointer.
- **D3 — La entrada de bandeja va PRIMERA**, antes de cualquier tab/sección existente, como enlace
  discreto (mismo idioma visual de la bandeja; clase nueva `.tray-catalog`). Texto exacto:
  `← Catálogo`. Es un `<a href="/">`, no un botón.
- **D4 — Print intacto**: la bandeja ya se oculta en `@media print` (ambos themes) — la entrada
  muere con ella; el `<a>` del logo no altera el render de papel (mismo `<img>`/texto adentro). El
  modo `print: true` del pipeline (#65) no lleva bandeja ni scripts — verificar que el logo-link no
  introduzca nada que el PDF no deba llevar (un `<a>` inerte es aceptable en PDF).
- **D5 — La página del catálogo (`/`) también recibe el logo-link** (auto-referencia inofensiva) si
  comparte theme/header — no se especializa.

## Territorio

- `packages/capabilities/src/themes/arbol.ts` · `themes/default.ts` (header + CSS mínimo).
- El módulo que compone la bandeja común (localizar: la bandeja/`tray-sections` se emite en
  `render-html-piece.ts` o el theme — seguir el código real) — SOLO para insertar la entrada D3.
- `tests/nav-catalogo.test.ts` (NUEVO).
- NO tocar: `interactive-script.ts`, `table-runtime.ts`, enforcement, specs, schema.

## Tareas

### T1 — Logo-link en ambos themes
**Hecho cuando**: test nuevo verifica en AMBOS themes que el HTML contiene el logo envuelto en
`<a href="/" ... aria-label="Volver al catálogo"` y que el href es exactamente `/`.

### T2 — Entrada «← Catálogo» en la bandeja
**Hecho cuando**: test nuevo verifica que el render de un PI contiene `class="tray-catalog"` con
`href="/"` y el texto `← Catálogo`, ANTES (posicionalmente en el HTML) del primer tab de la bandeja;
y que el render `print: true` NO la contiene.

### T3 — Regresión
**Hecho cuando**: `npm run typecheck` && `npm test` && `npm run build` verdes sin editar ninguna
aserción existente (los tests de themes/as-of/#65 pasan tal cual).

## Riesgos

- Doble `<a>` anidado si el logo ya estuviera dentro de un link (verificar — hoy no lo está).
- El CSS del header de arbol posiciona el logo con reglas propias; el wrapper no debe romperlas
  (heredar dimensiones; probar con el test de string + ojo en el deploy).

— Diseño Fable · cluster 002 · 2026-08-06
