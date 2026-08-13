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
type FileOutcome = { file: string; outcome: 'procesado' | 'saltado' | 'fallido'; motivo?: string }
function parseRunFileOutcomes(logText: string): FileOutcome[]
```

Su regla rectora: **una línea que no calza la gramática no existe.** Nunca se adivina un desenlace a
partir de texto libre. En detalle:

- Prefijos de canal adicionales se descartan; el par marcador↔palabra tiene que calzar; la palabra va
  en minúsculas exactas. Un `✔ fallido: x` no es del contrato: es ruido y se ignora entero.
- El corte archivo↔motivo es en la **primera** raya, así que el motivo puede contener más.
- Si el job escribió un path en vez del basename, se toma el basename — tolerancia del lector, no
  licencia del escritor: el contrato pide el basename.
- Un `saltado`/`fallido` **sin** motivo sí cuenta como desenlace, con el motivo ausente: perder el
  hecho sería peor que reportarlo sin causa, y la plataforma dice que el job no lo declaró.
- Dos líneas para el mismo archivo: gana la **última** (un reintento dentro de la misma corrida
  declara su resultado final).
- El motivo se devuelve **textual**; el enmascarado de secretos ocurre al renderizar.

## 4 · ¿Qué pasa si el job no cumple? — la degradación honesta

La plataforma presenta lo que hay y nombra lo que falta. Jamás promete lo que nadie escribió. La
tabla describe la **resolución de desenlaces y el aviso al usuario**, que se construyen sobre este
contrato y **aún no están implementados** (issue #162, hitos posteriores a esta especificación); lo
que ya existe hoy es el lado lector del log (§1) y el parser de la gramática (§3):

| El job… | La plataforma resuelve | Y le dice al usuario |
|---|---|---|
| escribió log **con** gramática | desenlace por archivo, con su motivo | el motivo del job, textual |
| escribió log **sin** gramática | desenlace por corrida (`Completed`/`Failed`) para los archivos que esa corrida cubrió | «la corrida falló; el job no declaró desenlace por archivo», más el titular `✖` del log si existe |
| **murió sin escribir** el log | `sin-informe` | «el proceso terminó sin reportar la causa» — tal cual |

La distinción entre las dos últimas filas es el punto entero del contrato: **una causa declarada por
el job y una causa que nadie declaró no se parecen**, y la plataforma no las mezcla.

## 5 · Obligaciones del job, en una lista

Para que un slot cumpla el contrato completo, su job debe:

1. Escribir `run-<YYYYMMDDTHHMMSSZ>.txt` al final de **toda** corrida, con el timestamp del
   **arranque** en UTC, en el directorio de logs del slot.
2. Podar sus propios logs a los últimos 60.
3. Emitir **una** línea de desenlace por archivo de datos encontrado en el landing, con la gramática
   de §2, **antes** de la línea de cierre.
4. Escribir motivos legibles por el usuario que subió el archivo, en términos del dato.
5. Archivar en `_processed/` lo que procesó, en las corridas que terminan `Completed`. *(Es el
   contrato de ingesta ya declarado en el registro de cargas; la plataforma lo usa como control
   positivo de que el landing drenó. **No verificado slot por slot en la instancia**: un slot que no
   archive produce falsos «varados» y hay que ajustarlo o corregirlo.)*

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

---

• *Documentación del Producto Vergis · contrato `_logs/` (#99) + gramática por archivo (#162)*
