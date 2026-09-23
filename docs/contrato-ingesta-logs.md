# Contrato de ingesta — el log por corrida (`_logs/`) y su gramática por archivo

> **Documentación canónica del Producto.** Es el contrato que un job de conversión —el notebook, el
> SJD o el script de terreno que toma los archivos del landing y los escribe en el warehouse— tiene
> que cumplir para que la plataforma pueda mostrar **qué pasó con cada archivo** y decírselo al
> usuario que lo subió. Escrito para ser citado íntegro a quien implementa esos jobs.
>
> El contrato tiene dos mitades, y la segunda no sirve sin la primera: **(1)** el log de la corrida
> existe, se llama como corresponde y se puede atribuir a una corrida (issue #99); **(2)** dentro de
> él, cada archivo del landing tiene su línea de desenlace (issue #162).
>
> **Quién lo hace cumplir.** El contrato es del Producto; los jobs son de la instancia. La
> plataforma **no puede forzar** al escritor: lee lo que hay, presenta lo que encuentra y **nombra
> lo que falta**. Un job que no cumple no rompe nada — degrada, y la degradación es visible.

## 1 · ¿Qué escribe el job, y cuándo?

Al **final de cada corrida** —en el éxito, en el aborto controlado (`✖ ABORTADO`) y en el error no
controlado (`✖ ERROR no controlado`); el mismo punto donde el job ya escribe su `_ingest_log.txt`—
el job escribe **además** su log completo, inmutable, en un archivo propio de esa corrida.

| | Regla |
|---|---|
| **Nombre** | `run-<YYYYMMDDTHHMMSSZ>.txt`, donde el timestamp es el **arranque** del script en **UTC** |
| **Directorio** | `Files/code/_logs` por default; si el slot declara `log:`, la carpeta de ese archivo con `/_logs` al final (`slotRunLogsDir`) |
| **Momento** | al final de la corrida, **siempre** — también cuando terminó mal |
| **Inmutabilidad** | un archivo por corrida; no se reescribe ni se append-ea después |
| **Retención** | el **escritor** conserva los últimos 60 y poda el resto |

La especificación normativa de esta mitad, con su implementación de referencia del lado lector, vive
en `packages/capabilities/src/run-logs.ts` (`runLogFileName`, `parseRunLogTimestamp`, `resolveRunLog`,
`RUN_LOG_DIR_DEFAULT`, `RUN_LOG_RETENTION`). Este documento no la reescribe: la cita.

### ¿Por qué la retención es del escritor y no del producto?

Porque dos escritores sobre el mismo directorio son una carrera. El producto **lee y jamás poda** —
si además podara, un job podría borrar el archivo que la plataforma está leyendo, y nadie sabría de
quién fue el borrado.

### ¿Cómo se sabe qué archivo es de qué corrida?

Por **ventana temporal**, no por id de instancia del motor: el script arranca después del inicio
declarado de la corrida y escribe antes de (o apenas después de) su fin, y los márgenes absorben
cola, boot y desfase de reloj. De ahí la exigencia dura del nombre: **el timestamp es el arranque
del script, en UTC**. Un job que estampe la hora de término, o la hora local, se descorrelaciona y
sus logs aparecen como «sin log» aunque existan.

## 2 · ¿Qué agrega la gramática por archivo?

Un log que solo dice que la corrida falló deja al usuario sin nada suyo: subió un archivo y la
plataforma solo puede decirle que «algo» falló. El caso fundante del issue #162 es exactamente eso —
el usuario recibió un mensaje de motor (`state=[dead]`) mientras la causa real, «ancho inesperado: 28
columnas (se esperaban 48)», estaba en un log agregado interno que él no ve.

**Por cada archivo de datos que la corrida encontró en el landing, el log lleva exactamente una
línea de desenlace**, con el prefijo de canal `[intake]` y el marcador de la familia ya usada por el
contrato (`✖`, `⚠`, `✔`):

```
[intake] ✔ procesado: <archivo>
[intake] ⚠ saltado: <archivo> — <motivo>
[intake] ✖ fallido: <archivo> — <motivo>
```

| Elemento | Regla |
|---|---|
| `[intake]` | prefijo de canal. Se toleran prefijos adicionales delante (`[ingest] [intake] …`) |
| marcador | `✔` (U+2714), `⚠` (U+26A0) o `✖` (U+2716). El par marcador↔palabra **debe** calzar |
| palabra | `procesado`, `saltado` o `fallido`, en **minúsculas exactas** |
| `<archivo>` | el **basename** tal como aterrizó en el landing (`cartera_2026W28.xlsx`) |
| `—` | raya (U+2014) rodeada de espacios, separando archivo de motivo |
| `<motivo>` | **una** línea, autocontenida, en términos del dato. Obligatorio en `saltado` y `fallido` |

### Las reglas del motivo

El motivo se le muestra **textual** al usuario que subió el archivo *(la superficie y el aviso que se
lo entregan son parte del mismo issue #162 y llegan con él; hoy el motivo ya se parsea, §3)*. La
plataforma **no parafrasea**:
parafrasear sería fabricar una causa, y ese es justamente el defecto que este contrato cierra. Por
eso la legibilidad es obligación del escritor:

- **Nombra qué se esperaba y qué se encontró.** El ejemplo normativo es el del incidente: «ancho
  inesperado: 28 columnas (se esperaban 48)».
- **Sin jerga del motor**: nada de ids de instancia, estados del scheduler, rutas de almacenamiento
  ni nombres de tablas internas.
- **Sin stack traces ni multilínea.** El resto del log sigue siendo **libre** y es donde eso vive;
  la línea de desenlace es el titular que el usuario lee.
- **Sin secretos.** La plataforma enmascara los patrones obvios al renderizar (`redactSecrets`), pero
  esa es una defensa en profundidad, no un permiso para escribirlos.

### El sufijo opcional: código estable y datos del caso (issue #346)

El motivo le dice al operador **qué pasó** en términos del dato; no le dice al usuario **qué hacer**.
Para eso la línea admite, **al final**, un sufijo estructurado que declara el desenlace con un
**código estable** y los **datos del caso**, y con eso la plataforma muestra una **guía** en lenguaje
de usuario (título, qué pasó, qué hacer) con el motivo técnico plegado detrás:

```
[intake] ✖ fallido: <archivo> — <motivo técnico> ⟦<codigo> <clave>=<valor> <clave>=<valor>⟧
```

| Elemento | Regla |
|---|---|
| `⟦ … ⟧` | U+27E6 / U+27E7, al **final** de la línea, precedido de un espacio. Solo en `saltado`/`fallido`. Lo emite el helper del job, nunca texto escrito a mano |
| `<codigo>` | `familia` o `familia/especifico`, con la gramática `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$`. La familia es una de las del Producto o una declarada por la instancia en su catálogo de guías (`guias:` del archivo de intake) |
| `<clave>=<valor>` | cero o más, separados por espacio; clave `[a-z][a-z0-9_]*`. El valor va **pelado** si no tiene espacios, `"` ni `⟧` (`faltan=58,88`), o **entre comillas dobles** si los tiene (`vigente="Control de despachos 2026-09-01.xlsx"`); dentro de las comillas no puede haber `"` ni `⟧`, y la raya `—` sí. Un valor pelado con comas es una **lista**; uno entrecomillado es siempre un escalar. Si un valor trae `"` o `⟧`, el helper los reemplaza por `'` y `]` |

El sufijo **no reemplaza** al motivo: el motivo técnico sigue siendo obligatorio y sigue sujeto a sus
reglas. **Todo o nada:** un sufijo que no calza la gramática completa (comillas sin cerrar, `⟦` sin
cerrar, un código con mayúscula, un valor pelado con espacio) **no existe** — la línea se lee como si
no lo tuviera y el texto queda dentro del motivo, sin código.

**Por qué al final y no dentro del marcador** (`✖ fallido[COD]: …`): un lector anterior a #346 no
reconocería esa línea y el desenlace **entero** desaparecería si el job se despliega antes que la
plataforma. Al final, el lector viejo conserva archivo y desenlace y deja el sufijo como texto visible
del motivo: degrada a texto, no a pérdida. Aun así, **el orden de despliegue es: primero la versión
de la plataforma que lee el sufijo, después el job que lo emite**.

### El orden importa: las líneas de desenlace van antes del cierre

La línea de cierre de un aborto (`✖ ABORTADO: …` / `✖ ERROR no controlado: …`) debe seguir siendo la
**última `✖` del log**. La plataforma toma la última `✖` como **titular de la corrida**
(`diagnosticoDeFalla`), así que una línea `✖ fallido: …` escrita después del cierre desplazaría el
titular de la corrida por el de un archivo. Requisito del escritor, no preferencia de estilo:

```
[ingest] ▶ inicio
[intake] ✔ procesado: cartera_2026W27.xlsx
[intake] ✖ fallido: cartera_2026W28.xlsx — ancho inesperado: 28 columnas (se esperaban 48)
[ingest] ✖ ABORTADO: archivo sin filas de datos (1 filas)
```

### ¿Por qué la gramática va en el mismo log y no en un sidecar JSON?

- Un solo artefacto **conserva la correlación ya resuelta**: la ventana temporal de §1 aplica intacta.
- El escritor es un notebook o un script que **ya escribe texto**. Pedirle un segundo archivo duplica
  los modos de falla —si muere entre los dos, queda un par inconsistente— y duplica el contrato de
  retención.
- La familia de marcadores **ya existe y ya se parsea** (`✖` como titular de falla, `[delta] sin
  cambios en el dato` como señal de delta cero).

El costo —parsear texto— se acota anclando la gramática por prefijo y marcador, no con heurística.

## 3 · ¿Cómo lee la plataforma lo que el job escribió?

El lector es `parseRunFileOutcomes(logText)` en `packages/capabilities/src/run-logs.ts`, función
pura, exportada desde `@vergis/capabilities`:

```ts
type FileOutcome = {
  file: string
  outcome: 'procesado' | 'saltado' | 'fallido'
  motivo?: string
  codigo?: string                              // #346 · del sufijo ⟦…⟧
  params?: Record<string, string | string[]>   // #346 · datos del caso
}
function parseRunFileOutcomes(logText: string): FileOutcome[]
```

Su regla rectora: **una línea que no calza la gramática no existe.** Nunca se adivina un desenlace a
partir de texto libre. En detalle:

- Prefijos de canal adicionales se descartan; el par marcador↔palabra tiene que calzar; la palabra va
  en minúsculas exactas. Un `✔ fallido: x` no es del contrato: es ruido y se ignora entero.
- El corte archivo↔motivo es en la **primera** raya, así que el motivo puede contener más. Sin raya,
  el guion ASCII con espacios (« - ») corta **solo si lo que queda a su izquierda termina en una
  extensión de archivo** (`.xlsx`, `.csv`…): los nombres reales traen « - » adentro
  (`20260921 - Recepción….xlsx`) y cortarlos en el primero inventaba el archivo `20260921` (#269·P26).
- **El estado de una carga no depende de este corte.** El resolvedor busca la línea del archivo por el
  **nombre conocido** de la carga (`declaracionDeArchivo`): cuerpo igual al nombre, o que empieza con
  el nombre seguido de fin, espacio o raya.
- Si el job escribió un path en vez del basename, se toma el basename — tolerancia del lector, no
  licencia del escritor: el contrato pide el basename.
- Un `saltado`/`fallido` **sin** motivo sí cuenta como desenlace, con el motivo ausente: perder el
  hecho sería peor que reportarlo sin causa, y la plataforma dice que el job no lo declaró.
- Dos líneas para el mismo archivo: gana la **última** (un reintento dentro de la misma corrida
  declara su resultado final).
- El motivo se devuelve **textual**; el enmascarado de secretos ocurre al renderizar.
- **El sufijo `⟦…⟧` se extrae primero, anclado al final** de la línea, y el corte archivo↔motivo se
  hace sobre lo que queda: una raya dentro de un valor entrecomillado no le gana el corte al
  separador. Cuando calza, `FileOutcome` trae además `codigo` y `params`, y `motivo` va **sin** el
  sufijo; cuando no calza, la línea se lee exactamente como antes de #346. El lector **no valida la
  familia** contra ningún catálogo: un código de familia desconocida se persiste igual y quien lo
  muestra lo trata como «sin código» (y lo cuenta para el operador).

## 4 · ¿Qué pasa si el job no cumple? — la degradación honesta

La plataforma presenta lo que hay y nombra lo que falta. Jamás promete lo que nadie escribió. El
**estado de cada carga** y el aviso al usuario se construyen sobre este contrato y corren dentro del
lazo de vigilancia del intake (`server/intake-loop.ts`, fase RESOLVER, función pura
`resolverEstadoDeCarga`). Desde 0.35.0 (#269) el estado es **exclusivamente** lo que el job declaró de
ESE archivo más los actos registrados (re-subida con el mismo nombre, retiro en `_retirado/`,
reversión): la **ausencia** de declaración nunca se convierte en un resultado.

El estado **avanza hasta uno final** (cargada, retirada, reemplazada, deshecha) y guarda la historia de
intentos: un archivo que falló y sigue en el landing se reintenta solo y puede terminar cargado, y la
plataforma lo dice.

| El job… | La plataforma resuelve | Y le dice al usuario |
|---|---|---|
| declaró el archivo `✔` | `procesada` (final) | — |
| declaró el archivo `⚠`/`✖` | `saltada`/`fallida`, con su motivo (no final: puede avanzar) | el motivo del job, textual |
| escribió log con gramática **que no nombra** el archivo | nada: esa corrida no lo vio | — |
| escribió log **sin** gramática y la corrida falló | `fallida` (legado), sin motivo por archivo | «la corrida falló; el job no declaró desenlace por archivo», más el titular `✖` del log si existe |
| **murió sin escribir** el log | `sin-informe` | «no sabemos qué pasó con este archivo» — tal cual |
| no lo declaró y el archivo **salió del landing** por un camino que no es `_retirado/` | `sin-informe` | ídem; la consola técnica lo lista como «salió fuera de contrato» |
| no lo declaró y el archivo **sigue en el landing** | sin estado («Recibido»); la edad es un dato, no un estado | — |

Una declaración que contradice lo archivado (declarado «no cargado» y archivado igual) no se resuelve
a favor del archivo: **gana la declaración**, y la consola técnica lo señala.

**El único puente, para lo anterior al contrato.** Las corridas anteriores a que un job declarara por
archivo nunca escribieron declaraciones. Para una carga subida **antes** de `contrato_desde` (clave del
slot, fecha ISO en que su job empezó a declarar), y solo para ella, la copia en lo archivado cuenta
como declaración `✔`. Sin `contrato_desde` no hay puente: sus cargas sin declaración quedan
`sin-informe`.

La distinción entre las dos últimas filas es el punto entero del contrato: **una causa declarada por
el job y una causa que nadie declaró no se parecen**, y la plataforma no las mezcla. En particular, el
motivo que el **motor** reporta de la corrida (`state=[dead]`, ids de instancia) **nunca** se usa para
rellenar el desenlace de una carga: es del operador, y no describe a ningún archivo en particular.

Dos casos más, por la misma disciplina: una corrida **en curso** deja la carga como está (su
resultado todavía puede decidirla; una `InProgress`/`NotStarted` más vieja que el umbral de corrida
colgada ya no se cree en curso), y un log que la plataforma **no pudo mirar** —dependencia no
cableada, lectura fallida— no deja concluir nada de la ausencia: no medir no es un hallazgo sobre el
job.

### ¿Cómo se enciende el correo al que subió?

El desenlace se persiste y se consulta **exista o no** el canal: el registro no depende del correo.
Para que además salga un email, la instancia declara en `VERGIS_NOTIFY` un destino suscrito al flujo
`cargas-usuario`:

```yaml
destinations:
  - id: aviso-usuario
    type: email-smtp
    events: [cargas-usuario]
    smtp: { host: smtp.relay.interno, port: 587 }
    from: Mira <mira@ejemplo.cl>
    to: ['$uploader', ops@ejemplo.cl]   # $uploader = quien subió el archivo; el resto, copia operativa
```

Reglas, todas verificadas en el arranque (config mala = boot roto con el nombre del destino, nunca un
correo que no sale en silencio): un `email-smtp` suscrito **debe** traer `$uploader` en su `to`; el
token sin la suscripción también rompe; un `slack-webhook` suscrito se **rechaza** (un canal
compartido no es una persona); un `webhook` genérico sí puede suscribirse y recibe `uploadedBy` en el
JSON para que el puente externo decida. Solo se avisa al **entrar** a `fallida` o `sin-informe`:
`procesada` y `saltada` se consultan en la consola, no llenan la bandeja de nadie.

**Al operador, por carga (#269·V12):** el flujo `cargas-operador` recibe un aviso por cada carga que
queda `sin-informe` o con una guía cuyo actor es el operador (deduplicado por carga). El aviso al
usuario dice «Le avisamos al equipo de la plataforma» **solo** si hay un destino suscrito a ese flujo;
si no, «Avísale a {contacto}» (clave `contacto:` en la raíz del archivo de intake, heredable por slot);
sin ninguno de los dos, no dice nada — y la consola técnica señala que falta `contacto`.

## 5 · Obligaciones del job, en una lista

Para que un slot cumpla el contrato completo, su job debe:

1. Escribir `run-<YYYYMMDDTHHMMSSZ>.txt` al final de **toda** corrida, con el timestamp del
   **arranque** en UTC, en el directorio de logs del slot.
2. Podar sus propios logs a los últimos 60.
3. Emitir **una** línea de desenlace por archivo de datos encontrado en el landing, con la gramática
   de §2, **antes** de la línea de cierre.
4. Escribir motivos legibles por el usuario que subió el archivo, en términos del dato.
5. *(Opcional para el escritor, #346.)* Agregar a cada línea `saltado`/`fallido` el sufijo `⟦…⟧` con
   el **código** del desenlace y los **datos del caso** que su guía interpola (§2). Sin él, la
   plataforma muestra el motivo técnico como siempre; con él, muestra la guía de ese código y deja el
   motivo plegado como detalle técnico. El motivo técnico sigue siendo obligatorio igual.
6. Archivar lo que procesó, en las corridas que terminan `Completed`, en el directorio que el slot
   declara (`target.processed: <ruta>`; sin declarar, `<padre del landing>/_processed`). Un proceso
   que **no** archiva (un catálogo que se lee siempre del landing) lo declara con
   `target.processed: false`: su archivo en el landing es el vigente, no un residuo.
7. **Sacar un archivo del landing sin procesarlo solo por `_retirado/`** (#269·§3.4), con el nombre
   `<padre>/_retirado/<epoch ms>-[<etiqueta>-]…<archivo>`, `<etiqueta>` en `revertido`/`retirado` y
   sellos repetibles. La plataforma reconoce las tres formas —`<ts>-<archivo>` (Retirar),
   `<ts>-revertido-<archivo>` (Revertir) y `<ts>-retirado-[<ts>-]<archivo>` (a mano)— y toma el
   **primer** sello como instante del retiro (un rename conserva el `mtime` del original: no sirve).
   **Otros caminos** (`_cargado-manual-*`, `_sin-metadata/`, cualquier directorio no declarado) **no
   cuentan como retiro**: la carga queda `sin-informe` y la consola lo lista como «salió fuera de
   contrato».
8. Declarar en el slot desde cuándo su job cumple el §2 (`contrato_desde`), si hay cargas anteriores
   que el puente histórico deba cubrir.

## 6 · ¿Cómo se verifica que un slot cumple?

- **Prueba mínima end-to-end** (la que vale por todas): subir por la consola de Cargas un archivo que
  el job deba **rechazar**, esperar a que la corrida termine y comprobar tres cosas — que existe el
  `run-<ts>.txt` de esa corrida, que trae la línea `[intake] ✖ fallido: <archivo> — <motivo>`, y que
  el motivo se entiende sin conocer el job.
- **Prueba del caso feliz**: subir un archivo válido y comprobar la línea `✔ procesado:` y que el
  archivo salió del landing hacia `_processed/`.
- **Señal en la consola**: la consola de Cargas del dominio ya muestra, por corrida, si su log
  existe, si quedó añejo o si no hay ninguno correlacionable. *(Un aviso de coherencia por slot —
  «este slot no cumple el contrato `_logs/`» tras N corridas terminadas seguidas sin log— está
  **diseñado y aún no implementado**.)* El Producto no puede forzar al escritor; sí puede volver el
  incumplimiento visible donde el operador ya mira.

## 7 · Las guías de carga: qué se le explica al usuario (issue #346)

El código del sufijo (§2) declara **qué pasó**; la instancia declara **cómo se le explica**; la
plataforma junta las dos cosas **al mostrarlas**. Se persisten el código y los datos del caso, nunca
la redacción: corregir una guía mejora de inmediato las cargas pasadas.

### ¿Qué familias trae el Producto, y quién actúa en cada una?

Cada código pertenece a una **familia**, y la familia fija **quién tiene que actuar**. Ninguna guía
cambia el actor: es el único dato que debe ser verdadero aunque el texto esté mal redactado.

| Familia | Actor | Qué agrupa |
|---|---|---|
| `formato` | usuario | ancho, encabezados u hojas inesperados; columna requerida ausente |
| `archivo-vacio` | usuario | sin filas de datos útiles |
| `lectura-incompleta` | usuario | lectura degradada, hoja truncada |
| `duplicado` | usuario | grano no único (una llave repetida) |
| `valor-invalido` | usuario | fecha, número o identificador inválido |
| `referencia-ausente` | usuario | el archivo nombra algo que su maestro no tiene |
| `catalogo-incompleto` | usuario | un archivo que reemplaza un catálogo dejaría huérfanos a los ya usados |
| `conflicto-declaracion` | usuario | el contenido contradice el nombre, la carpeta o lo declarado al subir |
| `descuadre` | usuario | dos archivos que deben cuadrar no cuadran |
| `volumen-anomalo` | usuario | mucho menos que lo vigente (el primer paso es del usuario; forzar la carga es del operador, y la guía lo dice) |
| `en-espera` | nadie | falta el archivo compañero; se procesará cuando llegue |
| `desplazado` | nadie | un archivo más reciente del mismo tipo lo reemplazó |
| `falla-plataforma` | operador | error no controlado, warehouse inaccesible, invariante interno roto |

Son **semilla, no lista cerrada**: la instancia declara familias propias con su actor obligatorio.

### ¿Dónde declara la instancia sus guías?

En un bloque raíz `guias:` del **mismo** archivo de intake (`VERGIS_INTAKE`), junto a `slots:`. Hereda
la recarga en caliente del archivo, sin variable de entorno nueva:

```yaml
guias:
  familias:                                   # opcional: familias propias
    - familia: vigencia-vencida               # no puede repetir una del Producto
      actor: usuario                          # obligatorio: usuario | operador | nadie
      titulo: "El archivo es de un período que ya no se acepta"
      que_paso: "El período {periodo} ya está cerrado."
      que_hacer: ["Sube el archivo del período vigente."]
  entradas:
    - codigo: catalogo-incompleto/maestro-tiendas
      slots: [oc_crossdocking_maestro]        # opcional: sin `slots`, aplica a todo slot
      titulo: "El maestro de tiendas tiene que venir completo"
      que_paso: "El que subiste trae {tiendas_archivo} tiendas y dejaría fuera {n}."
      que_hacer:
        - "Parte del maestro completo, no de una planilla nueva."
        - "Súbelo completo y después vuelve a subir la distribución que había fallado."
```

| Regla | Detalle |
|---|---|
| Validación | Estricta: clave desconocida, familia que repite una del Producto, familia propia sin `actor`, entrada **con** `actor`, código de familia desconocida, slot inexistente, `titulo`/`que_paso` vacíos o `que_hacer` sin pasos ⇒ error nombrando la guía. Al arrancar lo acusa el chequeo de despliegue; en la recarga en caliente se **conservan las guías vigentes** |
| Interpolación | `{clave}` toma los datos del caso; `{archivo}` y `{slot}` los pone la plataforma. Una lista se lee «58 y 88», o «58, 88, 95 y 7 más» con cinco o más elementos. Un marcador sin dato queda «(dato no informado)» y no rompe la vista |
| Precedencia | entrada con el código exacto y el slot → entrada con el código exacto sin `slots` → entrada con el código de la familia sola (con slot, luego sin) → guía genérica de la familia (de la instancia o del Producto) → sin guía. El actor sale siempre de la familia |

### ¿Qué ve el usuario, y qué pasa sin guía?

- **Cargas, celda Desenlace:** la insignia, la línea de actor («Hay que corregir el archivo» · «No es
  por tu archivo: el equipo ya fue avisado» · «No tienes que hacer nada»), el título y el qué pasó,
  el qué hacer numerado, y un plegado «Detalle técnico» con el motivo **completo** y el código.
- **«Errores frecuentes»** por casilla (`/admin/dominio/<id>/errores/<slot>`, enlazada desde el
  encabezado de la casilla y desde el correo, bajo el mismo gate que Cargas): las guías de la casilla
  ordenadas por cuántas veces ocurrió su código en 90 días. Se puede consultar antes de que algo falle.
- **Correo a quien subió** (§4): el título es el de la guía, el cuerpo dice quién actúa y qué hacer, y
  el motivo técnico va al final. Con actor `operador` no le pide corregir nada.
- **Señal de cobertura** para el operador, por casilla: desenlaces de 30 días sin código, con código
  sin guía de la instancia (usaron la genérica) y con código de familia desconocida, nombrando los
  códigos.

| Caso | Se ve |
|---|---|
| Sin código (job sin sufijo, o sufijo mal formado) | Como siempre: insignia y motivo recortado a 300. Si el recorte se comió algo, el motivo completo queda en «Detalle técnico» |
| Código de familia conocida sin guía de la instancia | La guía genérica de la familia, con su actor |
| Código de familia desconocida | Como «sin código», y se cuenta en la señal del operador |
| `sin-informe` y `varada` | Sin cambios: no hay declaración del job, no hay código |

**Lo que la plataforma NO hace:** reconocer el texto técnico con expresiones regulares para asignarle
una guía. Una guía mal asignada fabrica una causa — peor que el texto técnico. Sin código, no hay guía.

---

• *Documentación del Producto Vergis · contrato `_logs/` (#99) + gramática por archivo (#162) + código y guía del desenlace (#346)*
