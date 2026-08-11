<!--
  BORRADOR — NO PUBLICADO A PROPÓSITO.

  Este archivo se llama `CONTRIBUTING.draft.md` y no `CONTRIBUTING.md` por una razón operativa,
  no estética: GitHub muestra `CONTRIBUTING.md` a todo el que abre un issue o un PR, y en ese
  momento la cláusula de licencia de contribución empieza a **obligar a terceros**. Renombrarlo
  es el acto de publicación, y ese acto espera la revisión de César o de un abogado (TODO.md).

  Trabajo autorizado: el diseño `work/004-…/11-113-open-core-v1.0.md` §D5 (aprobada por César el
  2026-08-08) manda redactar este borrador con la cláusula marcada como sujeta a revisión legal.
  Lo que ahí se selló es la EXISTENCIA del mecanismo, no su texto.

  Urgencia real: la ventana se cierra sola. Hoy el copyright es 100 % de Gegolabs (236 commits,
  un solo autor). El primer PR externo sin este mecanismo en su sitio no lo dispara — lo VENCE.
-->

# Contribuir a Vergis

Gracias por el interés. Vergis es software libre bajo **AGPL-3.0-or-later**, y las contribuciones
son bienvenidas.

## Antes de escribir código

- **Abre un issue primero** si el cambio no es trivial. Vergis tiene decisiones de arquitectura
  registradas en `docs/adr-*.md` y diseños previos en `work/`; un PR que las contradiga sin
  saberlo cuesta más caro deshacerlo que conversarlo.
- **Lee el ADR-002** (`docs/adr-002-open-core.md`) si tu cambio toca la frontera entre lo abierto
  y lo comercializable. El corte está escrito y derogarlo exige un acto documentado.

## Los gates

Todo PR debe pasar, en local, lo mismo que corre el CI:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Dos expectativas que van más allá de «los tests pasan»:

- **Un test que no sabe reprobar no es un test.** Si tu cambio corrige un comportamiento,
  demuéstralo: el test debe fallar con el código viejo. Dilo en el PR.
- **Las justificaciones se verifican o se declaran conjetura.** Si afirmas que algo pasa *porque*
  otra cosa, o lo mediste, o lo etiquetas como supuesto con tus palabras. Una justificación falsa
  no solo desinforma: decide por quien venga después.

## Certificado de origen y licencia de la contribución

<!-- redacción sujeta a revisión legal -->

Cada commit debe llevar un `Signed-off-by` (DCO — Developer Certificate of Origin, versión 1.1):

```bash
git commit -s -m "tu mensaje"
```

Al firmar con `Signed-off-by`, certificas lo que dice el DCO 1.1 (el texto íntegro está en
<https://developercertificate.org/>): que tienes derecho a aportar ese trabajo bajo la licencia
del proyecto.

**Además**, al contribuir a este repositorio otorgas a Gegolabs SpA una licencia perpetua,
mundial, no exclusiva, gratuita e irrevocable para usar, reproducir, modificar, distribuir y
**relicenciar** tu contribución, incluyendo bajo términos comerciales, conservando tú la
titularidad de tu copyright y todos tus derechos sobre ella.

> **Por qué esta cláusula existe, dicho de frente:** el proyecto adopta AGPL con licenciamiento
> dual (el modelo de MySQL o MinIO). Ese modelo exige que el titular pueda relicenciar el conjunto;
> un DCO a secas mantiene el inbound limpio pero **no** habilita relicenciar, y cerraría esa
> puerta con el primer aporte externo. No se te pide firmar un formulario aparte ni ceder tu
> copyright: se te pide una licencia amplia sobre lo que aportas. Si no te acomoda, dilo en el
> issue — es una conversación legítima, no un obstáculo que haya que sortear en silencio.

## Estilo

- **Español** en comentarios, documentación y mensajes de commit. El código (identificadores,
  APIs) va en inglés donde ya lo está.
- **Los comentarios explican el porqué, no el qué.** El código dice qué hace; el comentario dice
  por qué se eligió así y qué alternativa se descartó.
- Sin dependencias externas nuevas en `packages/botler` ni `packages/policy`: su presupuesto de
  dependencias es **cero** por contrato (ADR-001). En cualquier otro workspace, una dependencia
  nueva es una decisión que se argumenta en el PR, no un default.

## Seguridad

¿Encontraste una vulnerabilidad? **No abras un issue público.** Escribe a
`security@gegolabs.com` <!-- dirección por confirmar antes de publicar --> y danos tiempo de
responder antes de divulgarla.

---

• *Generado con Wingworking*
