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

## Migraciones del store embebido: la regla que hace posible el rollback

Una instancia de Vergis **estrena una versión conmutando entre anillos** y vuelve atrás por el mismo
camino (`deploy/rollout/`). Eso pone una obligación sobre el esquema de los stores embebidos que no
existía cuando desplegar era recrear el contenedor: **la versión de la que se viene y la versión a la
que se vuelve leen el mismo archivo**. Un `governance.sqlite` que la versión anterior no sabe abrir
convierte el rollback —la maniobra de emergencia— en el momento en que se descubre el problema.

**La regla, en una línea:** dentro de la ventana de retención —las últimas `RINGS_RETAIN` versiones
publicadas, default **3**— las migraciones del store son **aditivas y compatibles hacia atrás**.

Aditiva y compatible hacia atrás significa que una versión **anterior**, que no conoce el cambio,
sigue abriendo y escribiendo el archivo sin corromperlo:

| Migración | ¿Dentro de la ventana? |
|--|--|
| `ADD COLUMN` con default o nullable, condicionada a que no exista | **Sí** |
| Tabla nueva; índice nuevo | **Sí** |
| Fila nueva en una tabla de configuración | **Sí** |
| `NOT NULL` sin default sobre una tabla con datos | **No** — la versión vieja inserta sin esa columna y falla |
| Renombrar o eliminar una columna o tabla que la versión vieja lee o escribe | **No** |
| Cambiar el significado de un valor existente (misma columna, otra semántica) | **No** — es la peor de todas: no falla, miente |

### ¿Qué hace el autor de un PR?

1. **Prefiere la migración aditiva.** Si un cambio incompatible se puede partir en expand ahora +
   contract en una versión posterior (fuera de la ventana de retención), **pártelo**: el `DROP` de la
   columna vieja no viaja en el mismo release que el `ADD` de la nueva.
2. **Si la migración es incompatible, sube `SCHEMA_VERSION`** del store que tocas (las constantes
   `SCHEMA_VERSION`, `NOTAS_SCHEMA_VERSION`, `MASTER_DATA_SCHEMA_VERSION` en
   `packages/capabilities/src/`), **en el mismo commit que la migración**. No en un commit
   «de limpieza» después: entre los dos commits existe un build que escribe el esquema nuevo
   declarándose compatible con el viejo.
3. **Anúncialo en el `CHANGELOG.md`** con la frase que un operador puede buscar: **«rompe rollback a
   < X.Y»**, nombrando la versión. Es la única línea que le dice que su ventana de retención se
   acortó y que su plan de reversión ya no llega tan atrás como creía.
4. **La suite guarda los labels de la imagen.** `tests/imagen-anillo-labels.test.ts` compara
   `vergis.schema` / `vergis.schema.stores` del `Dockerfile` contra esas constantes; subir la
   constante sin el label deja el CI rojo. No hay que acordarse: hay que pasar.

### ¿Qué hace valer la regla por ti?

Nada de lo anterior depende de que alguien se acuerde en el momento del rollback:

- **Al abrir el archivo.** Un store cuyo `PRAGMA user_version` es **mayor** que la versión que el
  código soporta **se rechaza al abrir**, ruidoso, nombrando ambos números, sin tocar el archivo. La
  versión vieja no «intenta y ve qué pasa».
- **En el pre-flight de la promoción.** `vergis-rollout promote` lee el bloque `control` de
  `/contrato` del candidato y compara, store por store, el esquema que soporta contra el del archivo.
  Un candidato más viejo que el archivo **no se promueve**, y si el pre-flight no logra medir, **se
  niega** en vez de suponer.
- **Antes incluso de arrancar el candidato.** Los labels `vergis.schema*` de la imagen permiten
  descartar la incompatibilidad leyendo metadata, sin levantar un proceso.

De modo que el costo de olvidar la regla no es una pérdida de datos: es **un rollback que no
procede**, en pantalla, con los dos números en el mensaje. Eso es lo que hace que valga la pena
escribirla — y lo que hace que valga la pena no olvidarla.

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
