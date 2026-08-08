# ADR-002 — El corte open-core: la edición abierta y su frontera comercial

**Versión:** 1.0
**Fecha:** 2026-08-08
**Estado:** Aceptado (decisiones D1–D5 del diseño `work/004-cluster-disenos-backlog-2026-08-07/11-113-open-core-v1.0.md`, aprobadas por César Obach el 2026-08-08; la decisión de marca — D6 — quedó diferida y registrada aparte)

---

## Contexto

Vergis es un monorepo público bajo AGPL-3.0-or-later, con un solo titular de copyright (Gegolabs).
El issue #113 pide definir el corte entre núcleo abierto y lo comercializable **antes** de que la
presión comercial o el primer contribuidor externo lo definan por accidente. Este ADR registra el
criterio, el mapa y las reglas — es la norma; el análisis completo (marcos evaluados, alternativas
descartadas, riesgos) vive en el documento de diseño citado arriba.

La observación estructural que ordena todo: por la doctrina Producto/instancia, lo que Vergis
monetiza hoy no son features retenidas sino **la operación de instancias** — specs, policies,
credenciales y despliegue viven fuera del repo por diseño. El corte no inventa una frontera:
reconoce la que ya existe.

## Norma 1 — El criterio del corte: dos vetos y un test de comprador

Una pieza es **núcleo abierto** si pasa cualquiera de los dos tests positivos. Es **comercializable**
solo si pasa el tercero y **ninguno** de los dos primeros:

1. **Test de confianza** — ¿su corrección tiene que poder auditarla un revisor de seguridad para
   creerle al producto? (gate, log encadenado, kernel RLS, riel de serving, QC de Miranda).
   Si sí → **abierta, sin excepción**.
2. **Test de adopción** — ¿la necesita un desarrollador para correr el producto entero, single-node,
   end-to-end, con datos reales? (runtime, DSL, conectores, CLI, server, ejemplos, schema).
   Si sí → **abierta**.
3. **Test del comprador** — ¿quien paga por esta pieza es una organización operando a escala, no el
   desarrollador que evalúa? (HA/K8s, control plane de flota, SLAs). Solo lo que pasa este test y
   ninguno de los anteriores es candidato a comercial.

**Los tests 1 y 2 son VETOS que el test 3 no puede pasar por encima.** Mover una pieza del lado
abierto al comercial exige derogar este ADR con un acto documentado — no basta la tentación de un
trimestre malo. Esta cláusula existe porque la derivación del criterio es el modo de falla #1 de
todo open-core (el patrón «SSO-tax»).

## Norma 2 — El mapa vigente, y cómo se clasifica lo nuevo

| Pieza | Veredicto | Test que decide |
|---|---|---|
| `packages/botler` (gate, log encadenado) | Abierta | 1 y 2 |
| `packages/policy` (Custos, kernel RLS) | Abierta | 1 |
| `packages/mira` (DSL + pipeline) | Abierta | 2 |
| `packages/capabilities` (conectores + render) | Abierta | 2 |
| `packages/cli` | Abierta | 2 |
| `packages/miranda` | Abierta | 1 y 2 |
| `server/` (serving RLS, admin de instancia, intake) | Abierta | 1 y 2 |
| `deploy/` (compose de referencia, pdf-sidecar) | Abierta | 2 |
| `schema/` · `examples/` · `docs/` · `tests/` | Abiertas | 2 |
| Canales de salida email/Slack (futuros) | Abiertas | 2 |
| HA / K8s / operator / carrier-grade (no existe) | Comercial | 3 |
| Control plane de flota / consola multi-instancia (no existe) | Comercial | 3 |
| Servicio hosteado / instancias operadas | Comercial (no es código) | 3 |
| Multi-tenancy en una instancia (no existe) | **Indecisa** — sesgo: si nace del hosting propio → comercial; si la pide el self-hoster → abierta | — |

**Toda pieza nueva del roadmap se clasifica en su documento de diseño, citando el test que decide.**
La clasificación tardía es la puerta del crippleware. Este mapa es registro vivo: se actualiza aquí
con cada pieza que nazca.

## Norma 3 — La regla del proceso separado

El código comercial futuro **jamás linkea dentro del proceso AGPL**: nace en repo privado como
programa separado que consume a Vergis por sus APIs y protocolos (imagen pública, env de instancia,
gate por headers, endpoints). La frontera «obra derivada» de la AGPL en linking no está testeada en
tribunales; la frontera proceso/red es la única universalmente aceptada — y es la que la
arquitectura de Vergis ya usa para todo.

**Regla de reparto para cada duda futura:** *superficie abierta, orquestación comercial.* Si una
pieza comercial necesita una superficie que no existe (un endpoint, un contrato de config), la
superficie se agrega al lado abierto — también le sirve al self-hoster (test 2) — y la orquestación
queda del lado comercial.

## Norma 4 — La promesa anti-crippleware

**La edición abierta es funcionalmente completa en single-node.** Esta frase deja de ser marketing
del README y pasa a ser cláusula normativa: una edición abierta deliberadamente incompleta como
demo viola este ADR. El test 2 la protege; esta cláusula la hace explícita.

## Licencia y contribuciones

- La licencia vigente (AGPL-3.0-or-later) **se mantiene**. Su cláusula de red disuade el fork
  cerrado y el SaaS silencioso, y su incompatibilidad con políticas corporativas anti-AGPL es el
  funnel del dual licensing — posible solo mientras Gegolabs conserve la titularidad íntegra del
  copyright.
- **Antes del primer PR externo** debe existir el mecanismo de contribución (DCO + cláusula de
  licencia de contribución que preserva el derecho de relicenciar). Ese evento no dispara el
  mecanismo: **lo vence** — un PR externo mergeado sin acuerdo cierra la ventana del dual licensing
  para siempre sobre ese código. El borrador vive en
  `work/005-cluster-ejecucion-atendibles-2026-08-08/02-borrador-contributing-v1.0.md`, gated por
  revisión legal antes de publicarse como `CONTRIBUTING.md`.
- Los eventos que destrancan las decisiones diferidas (cliente self-host, tercero hosteando,
  Custos standalone, multi-tenancy, primera pieza comercial con código) están catalogados en el
  diseño, §5, cada uno con qué re-verificar al llegar.

## Límite de certeza

Las lecturas de la AGPL §13, la irrevocabilidad de lo distribuido y la mecánica del dual licensing
son las mayoritarias de la industria, verificadas contra el texto de la licencia pero **no contra
jurisprudencia ni con un abogado**. Toda decisión que firme un contrato pasa por revisión legal.

---

*A Gegolabs project · Registrado con Wingworking*
