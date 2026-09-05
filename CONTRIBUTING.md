# Contribuir a Vergis

Gracias por el interés. Vergis es software libre bajo **AGPL-3.0-or-later**, y las contribuciones
son bienvenidas.

## ¿Cómo empezar?

Necesitas **Node 22 o superior** y **npm 10.9.9 o superior** — es lo que declara `engines` en
`package.json`, lo que corre el CI (`.github/workflows/build.yml`) y la base de la imagen
(`Dockerfile`: `node:22-slim`). Con eso:

```bash
git clone https://github.com/Gegolabs/vergis.git && cd vergis
npm ci
./bin/vergis run examples/hello.yaml   # escribe hello.html + vergis.log.jsonl
npm test                               # suite hermética: no necesita red ni credenciales
```

Si `hello.html` existe y la suite está verde, tienes todo lo que hace falta para trabajar en el
motor. Lo que **no** hace falta —y por eso no lo pedimos— es una cuenta de Fabric, un SQL endpoint ni
una instancia desplegada: las credenciales y los specs de cada instancia entran **desde afuera**
(`VERGIS_CONNECTIONS`, `VERGIS_SPECS`) y nunca viven en este repo. Los scripts `lab:*` y `fab:*` de
`package.json` son arneses de los mantenedores contra motores reales; exigen capacidad prendida y
plata, y ningún PR depende de ellos.

## ¿Cómo se abre un buen issue?

**Un issue, un problema.** No porque la burocracia lo pida, sino porque un issue que mezcla dos
problemas no se puede cerrar hasta que se resuelvan los dos, y el segundo suele quedar enterrado en
el hilo del primero. La separación es de *issues*, no de *PRs*: un mismo PR puede cerrar varios
(`Fixes #A`, `Fixes #B` en su descripción) si la corrección es una sola.

Lo que sí agrupa es el **tracking issue**, y se declara como tal en su primera línea — mira #113 o
#110: «no es un requerimiento accionable», enumera frentes y dice que cada uno se abre como issue
propio cuando se priorice. Un tracking issue no se cierra con un PR; se cierra cuando sus piezas ya
tienen issue propio o dejaron de importar.

Lo que vuelve **accionable** un reporte de defecto, en este orden:

1. **Qué esperabas** y **qué pasó** — dos frases separadas; la brecha entre ellas es el defecto.
2. **Cómo reproducirlo**: el spec (o el mínimo que lo dispara — `examples/` es un buen punto de
   partida), el comando y la salida. Un log `vergis.log.jsonl` vale más que una descripción del log.
3. **La versión**: el tag de la imagen o `git rev-parse HEAD` si corres desde el árbol.

Sin el punto 2 el issue es una hipótesis; se agradece igual, pero nadie puede cerrarlo con un test
que demuestre que estaba roto.

**¿Dónde preguntar?** En un issue. Este repo no tiene Discussions habilitadas, y una pregunta cuya
respuesta debió estar en la documentación es un defecto de la documentación — el issue es el lugar
correcto para que quede registrada la respuesta.

## Antes de escribir código

- **Abre un issue primero** si el cambio no es trivial. Vergis tiene decisiones de arquitectura
  registradas en `docs/adr-*.md` y diseños previos en `work/`; un PR que las contradiga sin
  saberlo cuesta más caro deshacerlo que conversarlo.
- **Lee el ADR-002** (`docs/adr-002-open-core.md`) si tu cambio toca la frontera entre lo abierto
  y lo comercializable. El corte está escrito y derogarlo exige un acto documentado.
- **Mira el catálogo antes de proponer una capacidad**: `docs/capacidades.md` lista lo que Vergis ya
  sabe hacer, con identificadores `CAP-NN` citables. Puede que lo que ibas a pedir ya exista.

## Antes de abrir el PR

- **Si tu cambio agrega una capacidad, agrega su fila al catálogo** (`docs/capacidades.md`), en el
  mismo PR: número `CAP-NN` nuevo —los números no se reusan—, cómo se llama o se declara, desde qué
  versión, y el enlace a donde se explica. Un catálogo que envejece es peor que ninguno: miente con
  la autoridad del repo. `npm run capacidades:cotejo` verifica la numeración y que lo declarado en
  máquina esté citado; lo demás lo pone el autor.

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

## Ramas, commits y el PR

**Rama:** `tipo/NNN-descripcion-corta`, en kebab-case, con el número del issue cuando lo hay:
`fix/229-instrucciones-viajan-con-la-imagen`, `feat/207-nombre-visible-editable`,
`docs/changelog-253`. Es lo que se ve en `git branch -r`, y sirve para que el nombre de la rama ya
diga a qué issue responde.

**Mensaje de commit:** `tipo(ámbito): resultado`, en español, con el resultado escrito como **la
frase que un lector del `git log` querría leer** — qué quedó distinto, no qué archivos se tocaron:

```
fix(164): el allow-all deja de tomar rehén a una columna de negocio (#223)
store(sqlite): plano de escritura único — gate de esquema y fencing de escritura concurrente (#220)
docs(changelog): #253 entra a «Sin publicar» — la pertenencia del proceso al dominio (#254)
```

Dos honestidades sobre esa convención, para que no te la creas más rígida de lo que es:

- **El conjunto de tipos es abierto.** Conviven los clásicos (`feat`, `fix`, `docs`, `chore`,
  `release`) con el área tocada usada como tipo (`store`, `control`, `schema`, `server`, `deploy`,
  `lab`, `bench`). Ningún gate lo valida; lo que se exige es que el prefijo le diga al lector dónde
  mirar.
- **Lo que sí importa es la referencia `#NNN`.** El corte de una versión corre `npm run corte:cotejo`,
  que contrasta los `#NNN` de los commits contra el `CHANGELOG.md`: un commit que no cita su issue
  **es invisible para ese cotejo** y puede quedar publicado sin declararse. Por eso el número va en
  el mensaje —en el ámbito, `fix(164)`, o al final, `(#223)`— y no solo en la rama.

Cada commit lleva `-s` (ver «Certificado de origen»).

**El PR** dice tres cosas que el diff no puede decir por sí mismo: qué issue cierra (`Fixes #N`),
cómo demostraste que el test reprueba con el código viejo, y —si el cambio lo amerita— qué entrada
del `CHANGELOG.md` trae. **Quién mergea:** un mantenedor del repo, nunca el autor del PR, aunque
tenga permisos. No es desconfianza: es el único punto donde alguien verifica que tu pieza **compone**
con las demás que están en vuelo, y el día que dos frentes mergearon lo suyo sin ese punto el corte
de versión quedó bloqueado porque nadie podía declarar qué traía.

## ¿Cuándo va una entrada en el `CHANGELOG.md`?

Cuando el cambio **viaja al operador**: toca la imagen, el DSL, el contrato operativo (`/contrato`),
la herramienta de despliegue (`deploy/rollout/`) o cualquier comportamiento que quien opera una
instancia notaría al actualizar. La entrada va bajo **«Sin publicar»**, en el mismo PR que el
cambio, y cuenta **qué cambia para él y por qué** — el CHANGELOG de este repo no es una lista de
commits sino la explicación que el operador leería antes de decidir si adopta la versión. Un
cambio que no le llega (un test, un banco de medición, un documento interno) **no lleva entrada**, y
si la rama mezcla ambos, la sección lo dice para que el cotejo no lo reclame.

Si la migración de un store rompe el rollback, la entrada es obligatoria y tiene frase fija — ver
la sección siguiente.

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
- **En el pre-flight de la promoción.** `botler-rollout promote` lee el bloque `control` de
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

## Código de conducta

Este proyecto adopta el [Contributor Covenant 2.1](https://www.contributor-covenant.org/es/version/2/1/code_of_conduct/)
sin modificaciones. No lo reescribimos aquí porque un código de conducta redactado en casa es una
promesa que nadie más ha probado; el Covenant ya tiene definido qué se espera, qué no se tolera y
cómo se responde a un reporte. Lo único propio es el canal para reportar un incidente, y ese
canal todavía no está definido <!-- TODO (mantenedor, antes de publicar): decidir el correo de
contacto para reportes de conducta y copiar el texto íntegro del Covenant 2.1 —sin alterarlo— a
CODE_OF_CONDUCT.md; ese archivo GitHub lo publica al instante, por eso no nace con el borrador -->.

## Seguridad

¿Encontraste una vulnerabilidad? **No abras un issue público.** Escribe a
`security@gegolabs.com` <!-- dirección por confirmar antes de publicar --> y danos tiempo de
responder antes de divulgarla.

---

• *Generado con Wingworking*
