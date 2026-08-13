# Diseño — Cierre de pendientes del frente intake: contrato `_logs/` exigible · `watch:` por slot · control positivo en land-only · v1.0

> **Qué es.** El diseño del frente correctivo que cierra tres pendientes registrados en
> `PENDINGS.md` §Código/CI (`reg 2026-08-13`) al terminar el frente #161/#162. Es hijo del diseño
> `work/008-diseno-observabilidad-intake/01-diseno-161-162-v1.0.md` («el diseño 008»): hereda su
> modelo de datos y sus invariantes, pero **no hereda sus supuestos** — a ese diseño sus ejecutores
> le desmintieron tres afirmaciones sobre el repo, así que todo lo que este documento afirma del
> código fue re-verificado contra la fuente el 2026-08-13, commit `2a8cf7f`; lo no verificado está
> etiquetado **conjetura** con su experimento falsador. Dirige la implementación por hitos: cada
> hito lo ejecuta un subagente distinto, en frío, en un worktree propio (Norma 8).

---

## 1 · ¿Qué se decide para cada pendiente?

| # | Pendiente | Veredicto |
|---|---|---|
| P1 | `avisoContratoLogs` implementado y jamás visible (`corridasSinLog` no se llena) | **Se arregla**: el lazo mide el conteo por tick y lo persiste en la proyección (`intake_watch_state`); el render lo lee de ahí. La hipótesis del pendiente —«el conteo sale gratis del RESOLVER»— resultó **falsa** al verificarla (§2). |
| P2 | Sin `watch:` declarativo por slot (umbrales fijos, sin opt-out) | **Se arregla**: bloque `watch:` opcional en `intake/slots.yaml`, fail-closed, con compatibilidad total hacia atrás (§3). El opt-out es **total** (incluye el resolver de desenlaces), con su justificación en §3.3. |
| P3 | El control positivo se apaga en slots sin corridas observadas (contradice §3.3 del 008) | **La decisión del ejecutor de H4 se ratifica** para el control por-archivo: sin corte no hay predicción defendible, y ninguna variante evaluada lo salva (§4.1). Lo que sí se agrega, porque **no necesita corte**: un control positivo sobre el **directorio** del landing (§4.2). El vacío-con-éxito 200-vacío sobre directorio existente en land-only queda **sin control, aceptado y documentado** (§4.3). |

Los dos supuestos contra motor vivo del frente anterior (job muerto ↦ `Failed`; desfase de reloj
en la correlación carga↔corrida) **no son de este frente**: van al lote de gates manuales del
despliegue. Este diseño agrega **un** experimento nuevo a ese mismo lote (C6, §7) — es de un
mecanismo propio de este frente, no de aquellos dos.

---

## 2 · P1 — ¿Cómo llega `corridasSinLog` a la consola sin tocar almacenamiento en el request path?

### 2.1 El problema, verificado

`avisoContratoLogs` existe, renderiza y está testeado (`server/admin-cargas.ts:217`,
`tests/admin-cargas-vigilancia.test.ts:108–117`), y `admin-cargas.ts:439` lo invoca en la página.
Pero el campo que lo dispara, `SlotVigilancia.corridasSinLog`, queda ausente **a propósito**:
`slotVigilanciaDeProyeccion` (`server/intake-loop.ts:605–608`) declara que llenarlo exigiría
correlacionar corridas terminadas contra el listado de `_logs/` — lectura de almacenamiento,
prohibida en el request path por la doctrina que el propio módulo hereda de `freshness-loop.ts`
(el render lee solo la proyección) — y la proyección no guarda ese conteo.

### 2.2 La hipótesis del pendiente, desmentida

El pendiente conjetura que «el conteo sale gratis» de la fase RESOLVER, que ya resuelve logs por
corrida. **Verificado: no sale gratis.** El RESOLVER lista `_logs/` solo cuando hay cargas sin
desenlace (`server/intake-loop.ts:271–273`: `if (!pendientes.length) return` **antes** de
`corridasConLog`, que es quien llama `deps.runLogs.list`). En el estado estacionario —todas las
cargas resueltas— el lazo no lista `_logs/` nunca, y justo el slot cuyo job no escribe logs
alcanza ese estado rápido (sus cargas caen a `sin-informe` o `procesada` y dejan de estar
pendientes). Un conteo colgado del RESOLVER se congelaría.

Lo que **sí** sale gratis es la correlación: `resolveRunLog` (`run-logs.ts:95`) ya decide, por
corrida, `match | en-curso | purgado | sin-log`. El conteo es una función pura sobre ese veredicto.

### 2.3 El diseño

**Medición en el tick, persistencia en la proyección, lectura desde el snapshot.** Tres piezas:

**(a) Función pura** — en `packages/capabilities/src/run-logs.ts` (es su dominio: vive junto a
`resolveRunLog`, que reutiliza):

```ts
/** Corridas TERMINADAS consecutivas —desde la más reciente hacia atrás— cuya resolución de log
 *  es 'sin-log'. El conteo se corta en la primera corrida con 'match' O con 'purgado'. */
export function contarCorridasSinLog(runs: RunRecord[], entries: OneLakeEntry[]): number
```

Semántica, con su porqué:

- **Terminada = `Completed` | `Failed`.** El contrato del escritor obliga a escribir el log «al
  final de toda corrida (éxito, `✖ ABORTADO`, `✖ ERROR no controlado`)» (cabecera de
  `run-logs.ts`, verificada). Una corrida `Cancelled` o `Deduped` puede no haber arrancado el
  script jamás: contarla como incumplimiento sería fabricar una acusación. Se saltan (no cortan
  ni cuentan).
- **Cuenta solo `'sin-log'`.** `'purgado'` significa «el log más viejo retenido es posterior a la
  ventana de esta corrida» — no se puede afirmar que no se escribió, así que **corta** el conteo
  en vez de engordarlo (misma disciplina: la ausencia de medida no es evidencia de falta).
  `'match'` corta: la conducta reciente cumple. `'en-curso'` no aplica a corridas terminadas
  (verificado: `resolveRunLog` solo lo devuelve para `InProgress`/`NotStarted`).
- **Consecutivas desde la más reciente.** Es lo que el aviso ya redacta («las últimas N corridas
  terminadas no dejaron log») y lo que distingue conducta de accidente
  (`CORRIDAS_SIN_LOG_AVISO = 3`, `admin-cargas.ts:180`).

**(b) Medición y persistencia** — en el tick de `server/intake-loop.ts`, entre la construcción
del lote y `recordSlotObservations` (así viaja en el **mismo** persist por lote):

- Para cada observación **fresca** con `runs` presentes, si `slotRunLogsDir(slot) != null` y
  `deps.runLogs` está cableado: se lista `_logs/` **una vez**, se computa
  `obs.corridasSinLog = contarCorridasSinLog(obs.runs, entries)` y el listado se cachea en un
  mapa del tick que la fase RESOLVER reutiliza (para eso `corridasConLog` gana un parámetro
  opcional de entradas pre-listadas — sin él, lista como hoy).
- Si el listado de `_logs/` lanza: el campo queda `undefined` (no se toca lo persistido — el
  conteo previo pasa a ser «lo último conocido») y se loguea, sin tumbar el tick.
- Si el conteo **no aplica** al slot —sin `trigger`, `log: false`, motor no cableado, `runLogs`
  no cableado—: `obs.corridasSinLog = null` (limpia el valor persistido). Un slot que declaró
  `log: false` **optó por escrito** a no escribir logs por corrida: mostrarle el aviso de
  incumplimiento sería ruido contra una declaración legítima (el desenlace honesto de sus cargas
  ya es `sin-informe`, verificado en el comentario del wiring, `serve-rls.ts:1124–1127`).

`SlotObservation` (capabilities) gana `corridasSinLog?: number | null` con exactamente esa
semántica de tres valores: número = medido, `null` = no aplica (limpiar), `undefined` = no tocar.

**(c) Store y lectura** — `intake_watch_state` gana la columna `corridas_sin_log INTEGER`
(migración con `ensureColumns`, el patrón idempotente ya existente en
`governance-store.ts:577–583`); `recordSlotObservations` la escribe según (b) — y en observación
con **error** no la toca, igual que al resto del snapshot; `SlotWatchSnapshot` gana
`corridasSinLog: number | null`; `slotVigilanciaDeProyeccion` la copia al `SlotVigilancia` que ya
consume la página (y borra su nota «queda SIN LLENAR a propósito», que este frente vuelve falsa).
El wiring de `serve-rls.ts:1466–1483` no cambia: ya pasa el snapshot completo.

**Costo declarado:** un listado DFS de `_logs/` por slot-con-trigger por tick (default cada 10
min) que antes solo se pagaba con cargas pendientes. Mismo orden de magnitud que el listado del
landing que el lazo ya paga por slot. Con el conteo se muestra aunque la medida esté degradada
(`ultima-conocida`): es una métrica de conducta lenta y el banner de medida ya rotula la añejez.

### 2.4 Qué cierra

El punto 1 de #162 («el contrato se especifica **y se hace exigible**») queda entero: la
especificación ya vivía (`docs/contrato-ingesta-logs.md` + cabecera de `run-logs.ts`); ahora el
incumplimiento es **visible y ruidoso** donde el operador ya mira.

---

## 3 · P2 — ¿Cómo se declara la vigilancia por slot?

### 3.1 La forma declarativa

En `intake/slots.yaml`, por slot, bloque opcional `watch:` (claves en snake_case, como
`revert_delete` y `from_filename` — convención verificada del archivo):

```yaml
watch: false               # opt-out total de la vigilancia del slot (§3.3)
# — o —
watch:
  max_age_minutes: 1440    # edad máxima en el landing (entero > 0)
  max_run_minutes: 90      # corrida colgada (entero > 0; requiere trigger)
```

En `IntakeSlot` (tipado **inline**, sin tipo exportado nuevo — decisión deliberada: así el hito
de parse no toca `packages/capabilities/src/index.ts` y puede correr en paralelo con H1, que sí
lo toca):

```ts
/** §4.1 del diseño 008 · vigilancia declarada del slot. Ausente = defaults del producto. */
watch?: false | { maxAgeMinutes?: number; maxRunMinutes?: number }
```

Reglas de parse en `parseSlot` (`intake.ts:207`), fail-closed como todo el archivo:

- `watch: false` → `out.watch = false`. **`watch: true` es error**: no declara nada que el
  default no diga ya, y aceptarlo crearía dos formas de escribir lo mismo.
- `watch:` mapa: `max_age_minutes` y `max_run_minutes` deben ser enteros positivos (error si no);
  **mapa vacío es error** (una declaración que no declara nada es un typo, no una intención);
  **clave desconocida dentro del bloque es error** (el bloque nace estricto — no carga la deuda
  de tolerar typos que el nivel-slot sí tolera por historia); `max_run_minutes` en un slot **sin
  `trigger` es error** (no hay corridas que medir: coherencia declarativa, familia del aviso #56).
- Cualquier error lanza: el chequeo de arranque lo acusa y el hot-reload rechaza el swap
  conservando los slots vigentes (mecanismo existente, verificado en la cabecera de
  `parseIntakeConfig`).

### 3.2 La semántica en el lazo

`intakeWatchConfig(slot, pollMs)` (`server/intake-loop.ts:516`) pasa a leer `slot.watch`:

| Declaración | Config resultante |
|---|---|
| `watch: false` | `null` — el slot **no se vigila** (§3.3) |
| ausente | **idéntico a hoy**: con `trigger` → `maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES`; land-only → sin edad; `maxRunMinutes` default |
| mapa | `maxAgeMinutes = declarado ?? (trigger ? DEFAULT : ausente)` · `maxRunMinutes = declarado ?? DEFAULT` |

Esto le da al slot land-only el **opt-in de edad** que §4.1 del 008 prometía (declara
`max_age_minutes` y gana la señal de varados), y al slot legítimamente lento el camino correcto:
**subir el umbral**, no apagar el vigilante.

El bloque se consume a call-time (`watchConfigDe` por tick sobre el arreglo vivo `slots()`,
verificado `intake-loop.ts:141–142`), así que el hot-reload de `slots.yaml` lo aplica sin
restart y sin cablear nada nuevo. `summarizeIntakeWatch` y `slotVigilanciaDeProyeccion` llaman a
la misma función, de modo que tile, banner y lazo quedan coherentes por construcción.

### 3.3 ¿Qué apaga exactamente `watch: false`? — Todo, y por qué

`watch: false` saca al slot del lazo **completo**: sin observación, sin proyección que se
refresque, sin control positivo, sin conteo de contrato (P1) **y sin resolver de desenlaces
(#162)** — la consola vuelve a la página pre-#161 para ese slot (sin banner: `slotVigilancia…`
devuelve `null` con config `null`, ya implementado) y las cargas nuevas quedan sin desenlace ni
aviso al usuario.

Se evaluó la alternativa —«vigilado pero mudo»: observar y resolver, callar las alertas— y se
descarta: parte la semántica en un tercer estado que toda superficie tendría que explicar («este
slot se mide pero no avisa»), y el caso que motiva el pendiente (slot lento que mete ruido) se
resuelve mejor con el umbral declarado, que conserva TODO lo demás. El opt-out total queda para
el slot donde la vigilancia entera carece de sentido, y su costo (perder desenlaces) se documenta
en el propio bloque del YAML de referencia y en la cabecera de `intake.ts`. Quien quiera
silencio **y** desenlaces declara `max_age_minutes` alto — ambas herramientas quedan escritas
una al lado de la otra.

**El estado de alertas de un slot que opta por salir se retira en silencio.** Hoy un slot que
desaparece del diff de alertas emite `composeIntakeRecovery` («recuperado»). Para el opt-out eso
sería falso: no sanó — lo callaron. En la fase ALERTAR, antes del diff, las claves de
`alertState` que pertenezcan a slots **declarados con `watch: false`** se eliminan del estado
(con persistencia por transición, como todo cambio de estado) **sin notificar**. El slot
*ausente de la config* conserva el comportamiento vigente (recuperación por ausencia,
`intake-loop.ts:352–353`): cambiarlo no es de este frente y romperlo violaría la regresión cero.

### 3.4 Compatibilidad hacia atrás

- **YAML sin `watch:`** — parse resultante byte-idéntico al actual (criterio de aceptación con
  test de igualdad estructural) y comportamiento del lazo idéntico (los defaults no se mueven).
- **YAML que ya trajera una clave `watch:` inerte** — hoy `parseSlot` ignora claves desconocidas
  (verificado: no hay validación de claves sobrantes a nivel slot), así que un `watch:`
  preexistente estaría siendo ignorado y con este frente cobraría significado o rompería el boot.
  **No verificado que ninguna instancia la traiga** (los YAML de instancia viven fuera de este
  repo, en el `lab` de A.R.B.O.L.); el gate de despliegue debe grep-ear `watch:` en los
  `slots.yaml` de instancia antes de subir. El fallo, si lo hay, es ruidoso por diseño
  (boot/hot-reload rechazan), nunca un cambio de conducta silencioso.

---

## 4 · P3 — ¿Tienen control positivo los slots sin corridas observadas?

### 4.1 El argumento del ejecutor, evaluado en serio — y ratificado

La decisión declarada en `intake-loop.ts:230–239`: el control positivo por-archivo solo se
computa con `obs.runs` presentes, porque sin corridas no hay **corte** (la última `Completed`,
que archiva a `_processed/` lo procesado) y toda carga histórica se «esperaría» para siempre —
la primera drenada legítima fabricaría una contradicción falsa.

El argumento es correcto, y no por falta de imaginación. Se evaluaron las variantes de corte que
un slot land-only podría ofrecer, y todas fallan por la misma raíz:

- **«Visto una vez en el landing, su ausencia posterior es drenaje legítimo»** — falla en la
  ventana: el consumidor externo puede tomar el archivo **entre la subida y el primer tick** del
  vigilante (cadencia default 10 min). Un archivo subido y consumido en 5 minutos jamás fue
  «visto», y acusar contradicción por él es exactamente la alerta falsa que #161 no debe emitir.
- **«Cargas más recientes que el ritmo declarado (`max_age_minutes`) se esperan presentes»** —
  confunde cotas: el umbral de edad acota cuánto puede **tardar** el consumidor, no cuánto debe
  **esperar** el archivo; un consumidor que drena al instante es legítimo y desmiente la
  predicción.
- **Un evento de drenaje observable** (ledger que el consumidor escriba, sidecar de consumo) —
  exigiría un contrato nuevo con un actor externo que hoy no escribe nada; eso es otro frente,
  con dueño en la instancia, no un arreglo de este.

La raíz común: en land-only, **el drenaje está en manos de un actor invisible para la
plataforma**. Sin evento observable de consumo no existe predicción defendible sobre la
*presencia* de archivos. La restricción del ejecutor pasa de nota entre corchetes a **decisión de
diseño** de este documento, y el corchete de `intake-loop.ts:237–239` se reescribe citándolo.

### 4.2 Lo que sí se puede sin fabricar: el control del directorio

Hay una predicción que **no depende del ritmo de nadie**: la plataforma escribió ella misma ≥1
archivo en el directorio del landing (`onelake.put` del intake, registro de cargas #62), y un
consumidor consume **archivos**, no directorios. Si el registro conoce cargas vividas del slot y
`listOrAbsent` responde `absent` —el directorio **no existe**, distinguido de «existe vacío»
desde el frente anterior (`intake-onelake.ts:159`, 404 → `absent`)—, eso contradice lo que la
plataforma sabe de sí misma, con o sin corridas. Hoy el lazo aplana ese caso a listado vacío
(`intake-loop.ts:219–223`) y el caso land-only queda mudo.

**El mecanismo** (extiende, no reemplaza, el control por-archivo):

- `SlotObservation` gana `landingAbsent?: true`, que `observar()` marca cuando
  `listing.kind === 'absent'` (la proyección no cambia: `absent` se sigue registrando como
  listado vacío — el veredicto viaja por el estado de alertas, como toda contradicción).
- `SlotWatchInput` (capabilities) gana `registro?: { cargasVividas: number; ultimaCargaAt?: string }`,
  que el lazo llena con `deps.uploads(slot.id)` — la dependencia ya existe y ya filtra
  `origen === 'upload' && ok` en el wiring (`serve-rls.ts:1366–1367`); el lazo la consulta ahora
  para **todo** slot con observación fresca (hoy solo con `runs`), y el resultado alimenta ambos
  controles. Costo: una lectura SQLite local por slot por tick — despreciable frente al listado
  DFS que el mismo tick ya paga.
- En `classifySlot`, rama fresca: contradicción si «esperados ≥1 y ninguno visto» (regla vigente,
  intacta) **o** «`obs.landingAbsent` y `registro.cargasVividas ≥ 1`». La alerta porta
  `landingAusente: true` y `ultimaCargaAt`, y `composeIntakeAlert` agrega la línea de evidencia:
  «el directorio del landing no existe, y la plataforma registró cargas en él (la última:
  \<fecha\>)» — afirma **hechos observados** (el put exitoso registrado, el 404 de ahora), jamás
  la causa.
- El **banner** de la consola conserva su texto genérico de contradicción: la proyección no
  persiste el flag `absent`, y el texto vigente («el listado del landing CONTRADICE el registro…
  la causa no se puede determinar desde acá») sigue siendo verdadero para este caso. Imprecisión
  aceptada y declarada — espejo de la que el módulo ya declara para el banner de
  `ultima-conocida` (`intake-loop.ts:593–596`). A cambio, ningún hito toca `admin-cargas.ts` ni
  `admin.ts` (nota operativa: la memoria del proyecto registra que el cyber safeguard corta las
  revisiones de `server/admin.ts` — este frente no lo roza).

**El caso virgen no alerta**: slot sin cargas vividas + directorio ausente = estado normal de un
slot recién declarado (el primer `put` crea el directorio). La condición `cargasVividas ≥ 1` es
la que separa el control de una acusación gratuita, y lleva test de control negativo propio.

**La conjetura que este mecanismo carga (C6, §7):** que drenar TODOS los archivos de un landing
deja el directorio existente (`listOrAbsent` → `ok` con lista vacía, no `absent`) — tanto cuando
drena el job (archiva a `_processed/`) como cuando drena un consumidor externo. En ADLS Gen2 con
namespace jerárquico los directorios son objetos explícitos y borrar el último archivo no borra
el directorio — **se asume; sin confirmar contra el terreno OneLake real**. Si es falsa, este
control fabricaría una contradicción tras cada drenaje completo — el ruido exacto que el ejecutor
de H4 evitó — y se retira. El experimento va al lote de gates manuales del despliegue (§7).

### 4.3 Lo que se pierde y se acepta, dicho con todas sus letras

Con §4.2, el land-only queda cubierto contra la lente rota que se manifiesta como **404**
(directorio invisible: permisos a nivel de directorio, borrado, path reconfigurado dejando
cargas huérfanas). Queda **sin control** el vacío-con-éxito que se manifiesta como **200 con
lista vacía sobre un directorio existente**: en un slot land-only ese estado es indistinguible de
«el consumidor drenó todo», y distinguirlos exigiría el evento de consumo que no existe (§4.1).
En esos slots, esa clase del incidente fundante de #161 **sigue siendo posible**; lo que los
cubre es lo que no depende del ritmo de nadie: `sin-medida` (lecturas que fallan), el control del
directorio (§4.2) y el opt-in de edad (§3.2). Esta pérdida queda escrita en la cabecera de
`intake-observability.ts` (invariante 2) para que nadie la redescubra como sorpresa.

**Limitación observada, fuera de alcance:** en fase 1 el lazo persiste el listado aun cuando la
fase 3 lo va a desmentir (la proyección se escribe antes de clasificar), de modo que una
contradicción sostenida deja la proyección con el landing vacío del listado desmentido. Es
conducta del frente anterior, no de este; se registra aquí para que no se cite este diseño como
si la hubiera resuelto.

---

## 5 · ¿Dónde vive cada pieza?

| Pieza | Archivo | ¿Nuevo o extiende? | Hito |
|---|---|---|---|
| `contarCorridasSinLog` (pura) | `packages/capabilities/src/run-logs.ts` | extiende | H1 |
| Export de `contarCorridasSinLog` | `packages/capabilities/src/index.ts` | extiende (una línea; **solo H1 toca este archivo**) | H1 |
| Columna `corridas_sin_log` + semántica en `recordSlotObservations` + `SlotWatchSnapshot.corridasSinLog` | `packages/capabilities/src/governance-store.ts` | extiende (migración `ensureColumns`) | H1 |
| `SlotObservation.corridasSinLog` | `packages/capabilities/src/intake-observability.ts` | extiende (solo el campo del tipo) | H1 |
| Medición en el tick + caché del listado para el RESOLVER + copia snapshot→`SlotVigilancia` | `server/intake-loop.ts` | extiende | H1 |
| `IntakeSlot.watch` (tipo inline) + parse fail-closed + spec en cabecera | `packages/capabilities/src/intake.ts` | extiende | H2 |
| `intakeWatchConfig` lee `slot.watch` + retiro silencioso del estado en opt-out | `server/intake-loop.ts` | extiende | H3 |
| `SlotObservation.landingAbsent` + `SlotWatchInput.registro` + regla del directorio en `classifySlot` + `SlotAlert.landingAusente/ultimaCargaAt` | `packages/capabilities/src/intake-observability.ts` | extiende | H4 |
| `observar()` marca `absent`; `deps.uploads` consultado para todo slot fresco; corchete de §4.1 reescrito como decisión | `server/intake-loop.ts` | extiende | H4 |
| Línea de evidencia del directorio en `composeIntakeAlert` | `server/notify.ts` | extiende | H4 |

Ningún hito toca `server/admin-cargas.ts`, `server/admin.ts` ni `server/serve-rls.ts`: el render
y el wiring existentes ya consumen todo lo que estos hitos producen (verificado en §2.3.c y §4.2).

---

## 6 · ¿Cuáles son los hitos, qué puede ir en paralelo, y quién cablea cada empalme?

```
H1 (P1: conteo end-to-end) ─┐
                            ├─→ H3 (P2: consumo de watch en el lazo) ─→ H4 (P3: directorio)
H2 (P2: parse declarativo) ─┘
Paralelizables: H1 ∥ H2 (cero archivos en común — verificado en la tabla §5).
H3 y H4 son SERIALES entre sí y respecto de H1: los tres editan `server/intake-loop.ts`.
```

La lección del frente anterior —dos hitos paralelos cuyo empalme no era de nadie— se paga acá
con serialización deliberada: todo lo que atraviesa `intake-loop.ts` va en serie, y cada empalme
tiene dueño y test nombrados. Gates de siempre del repo (typecheck + tests + lint) en cada hito,
además de lo listado. **«Prueba por mutación»** significa: el ejecutor revierte temporalmente la
lógica indicada, corre el test nombrado, verifica que está ROJO, restaura y verifica VERDE — y lo
consigna en su reporte. **«Regresión cero»** significa: la suite existente pasa **sin editar
ningún test previo** (editar un test existente para que pase es fallo del hito, no arreglo).

### H1 — P1: el conteo del contrato `_logs/`, de la medición al aviso · sin dependencias

Archivos: `run-logs.ts`, `index.ts`, `governance-store.ts`, `intake-observability.ts` (solo el
campo), `intake-loop.ts`. Tests: `tests/run-logs.test.ts`, `tests/governance-store.test.ts`,
`tests/intake-loop.test.ts`.

**Aceptación:**

1. `contarCorridasSinLog`: `[sin-log, sin-log, match, sin-log]` (recientes primero) ⇒ **2**;
   `[sin-log, purgado, sin-log]` ⇒ **1**; `Cancelled`/`Deduped` intercaladas no cuentan ni
   cortan; sin corridas terminadas ⇒ 0. **Mutación:** contar no-consecutivas (quitar el corte)
   pone rojo el caso del `match` intercalado.
2. Store: observación fresca con `corridasSinLog: 3` lo persiste; siguiente con el campo
   `undefined` **no lo pisa**; con `null` lo limpia; observación con `error` no lo toca; una DB
   creada con el esquema anterior migra por `ensureColumns` sin pérdida (test con DB pre-poblada
   sin la columna). **Mutación:** hacer que `undefined` escriba NULL pone rojo el segundo caso.
3. **Empalme (dueño: este hito), end-to-end con fakes:** lazo con deps fake — 3 corridas
   `Failed` y `runLogs.list` vacío — tras un tick: el snapshot trae `corridasSinLog = 3`,
   `slotVigilanciaDeProyeccion` lo copia, y `avisoContratoLogs(slot, vigilancia)` devuelve el
   aviso (no `''`). Es el test que el frente anterior no tuvo: cruza medición → proyección →
   superficie en una sola aserción.
4. El RESOLVER reutiliza el listado del tick: con cargas pendientes y conteo medido en el mismo
   tick, `runLogs.list` se invoca **una** vez por slot (spy sobre el fake).
5. Slot `log: false` ⇒ `corridasSinLog` termina `null` y el aviso no aparece; ídem slot sin
   `trigger`.
6. Regresión cero: `tests/admin-cargas-vigilancia.test.ts`, `tests/intake-resolver.test.ts` y el
   resto de la suite pasan sin tocar.

### H2 — P2: el bloque `watch:` en el parse · sin dependencias · ∥ H1

Archivos: `intake.ts` (tipo inline + `parseSlot` + spec en la cabecera). Tests:
`tests/intake.test.ts`. **No toca `index.ts`** (empalme reservado a H1, §5).

**Aceptación:**

1. Parsea `watch: false` y el mapa con una o ambas claves; rechaza con mensaje que nombra slot y
   clave: `watch: true`, mapa vacío, clave desconocida en el bloque, valores no enteros o ≤ 0, y
   `max_run_minutes` sin `trigger`. **Mutación:** aceptar `watch: true` pone rojo su test.
2. **Compatibilidad:** un doc de config sin `watch:` produce un resultado **estructuralmente
   idéntico** al de hoy (test de igualdad profunda contra el parse actual de un YAML
   representativo con trigger, land-only, meta y catálogos).
3. La cabecera de `intake.ts` especifica el bloque —incluido que `watch: false` apaga también el
   resolver de desenlaces (#162) y que el slot lento se declara con `max_age_minutes`— citable a
   la instancia.

### H3 — P2: el lazo consume `watch:` · depende de H1 y H2 (edita `intake-loop.ts` tras H1)

Archivos: `intake-loop.ts` (`intakeWatchConfig` + retiro silencioso de claves opt-out en fase
ALERTAR). Tests: `tests/intake-loop.test.ts`.

**Este hito es el dueño del empalme H2 ↔ lazo** (el parse produce `slot.watch`; nadie más lo
consume), y lo prueba con:

1. Slot con `watch: false` en el arreglo de `slots()` ⇒ el lazo **no lo observa** (spy: `landing`
   jamás se llama para él), no cuenta en `vigilados` del tile, y `slotVigilanciaDeProyeccion`
   devuelve `null` (la consola no muestra banner). **Mutación:** ignorar `watch === false` en
   `intakeWatchConfig` pone rojo los tres.
2. Slot land-only con `watch.max_age_minutes` declarado ⇒ un archivo excedido produce alerta
   `varados` (el opt-in de edad que el 008 §4.1 prometía); sin declararlo, jamás la produce
   (conducta vigente, re-afirmada).
3. Slot con `trigger` y `max_age_minutes: 1440` ⇒ un archivo de 3 h no alerta (el default de 120
   quedó anulado). **Mutación:** aplicar el default por encima del declarado pone rojo este caso.
4. Opt-out en caliente: slot con alerta activa persistida → `slots()` pasa a traerlo con
   `watch: false` → tick: **cero** notificaciones (ni alerta ni «recuperado»), la clave sale del
   estado persistido; re-optar-in con el problema vigente ⇒ la alerta se emite de nuevo (es
   transición nueva). El slot **ausente** de `slots()` conserva la recuperación por ausencia
   (test de regresión explícito).

### H4 — P3: el control del directorio ausente · depende de H3 (edita `intake-loop.ts` al final de la cadena)

Archivos: `intake-observability.ts`, `intake-loop.ts`, `notify.ts`. Tests:
`tests/intake-observability.test.ts`, `tests/intake-loop.test.ts`, `tests/notify.test.ts`.

**Este hito es el dueño del empalme capabilities ↔ lazo ↔ aviso** (los tres archivos son suyos),
y lo prueba end-to-end con fakes:

1. `classifySlot`: obs fresca con `landingAbsent` + `registro.cargasVividas = 2` ⇒ medida
   `contradice-registro`, alerta con `landingAusente` y `ultimaCargaAt`, y el landing **no** se
   clasifica (cero varados aunque la proyección previa los tuviera — invariante 2). **Mutación:**
   quitar la condición `cargasVividas ≥ 1` pone rojo el control negativo del punto 2.
2. **Control negativo del slot virgen:** `landingAbsent` + `cargasVividas = 0` ⇒ medida `fresca`,
   cero alertas.
3. **Control negativo de la decisión ratificada (§4.1), cableado como test:** land-only
   (`runs` ausentes), listado **ok y vacío** (directorio existe) + cargas vividas ⇒ **cero**
   contradicción — la pérdida aceptada de §4.3 es conducta de diseño y este test la protege de
   un futuro «arreglo» bienintencionado.
4. End-to-end: lazo con `landing` fake que devuelve `{ kind: 'absent' }` y `uploads` con una
   carga ok ⇒ una notificación en el sink fake cuyo cuerpo contiene la línea del directorio
   inexistente con la fecha de la última carga, y sin causa afirmada; tick siguiente sin cambio ⇒
   cero notificaciones (dedup vigente).
5. El slot **con** corridas conserva intacto el control por-archivo (sus tests existentes pasan
   sin tocar), y `absent` + esperados ≥1 produce **una** alerta que trae ambas evidencias.
6. El corchete de `intake-loop.ts:237–239` queda reescrito citando §4.1 de este documento (la
   restricción ya no es «de este hito sobre el diseño»: es el diseño).

---

## 7 · ¿Qué está verificado y qué es conjetura?

### Verificado contra la fuente (este repo, commit `2a8cf7f`, 2026-08-13)

- El RESOLVER lista `_logs/` **solo** con cargas pendientes (`intake-loop.ts:271–273`) — la
  hipótesis «el conteo sale gratis» del pendiente P1 es falsa.
- `resolveRunLog` y sus cuatro veredictos; `'en-curso'` solo para corridas no terminadas
  (`run-logs.ts:95–128`). El contrato del escritor cubre éxito y aborto, no cancelación
  (`run-logs.ts:4–8`).
- `avisoContratoLogs` + `CORRIDAS_SIN_LOG_AVISO = 3` renderizan y están testeados
  (`admin-cargas.ts:180–222`, `admin-cargas.ts:439`, `tests/admin-cargas-vigilancia.test.ts`).
- El patrón de migración idempotente `ensureColumns` existe (`governance-store.ts:577–583`).
- `parseSlot` ignora claves desconocidas a nivel slot y usa snake_case + booleanos estrictos
  (`intake.ts:207–250`); el hot-reload valida-antes-de-swap (cabecera de `parseIntakeConfig`).
- `intakeWatchConfig` nunca devuelve `null` hoy (todos los slots se vigilan,
  `intake-loop.ts:516–520`); el opt-out y los umbrales declarados **no existen** (su corchete lo
  declara, `intake-loop.ts:512–514`).
- El control positivo exige `obs.runs` y su corchete declara la contradicción con §3.3 del 008
  (`intake-loop.ts:230–256`); `listOrAbsent` distingue `absent` (404) de vacío
  (`intake-onelake.ts:150–159`); `observar` aplana `absent` a listado vacío
  (`intake-loop.ts:219–223`).
- `deps.uploads` ya filtra `origen === 'upload' && ok` (`serve-rls.ts:1366–1367`); el slot que
  desaparece de la config se «recupera por ausencia» (`intake-loop.ts:352–353`).
- El wiring de la consola pasa snapshot + razón del lazo y no necesita cambios
  (`serve-rls.ts:1466–1483`).

### Conjeturas — cada una con el experimento que la falsaría

| # | Conjetura | Experimento falsador | Dónde cae si es falsa |
|---|---|---|---|
| C6 | **Drenar todos los archivos de un landing deja el directorio existente** (`listOrAbsent` → `ok` vacío, no `absent`) — base del control del directorio (§4.2). Se asume por la semántica de directorios explícitos de ADLS Gen2; **sin confirmar contra OneLake real**. | Gate manual del despliegue: en un slot real, vaciar el landing por completo (corrida que archive todo, o retiro manual del último archivo) y consultar `listOrAbsent` del path — debe dar `ok` con lista vacía. | H4 entero: si da `absent`, el control fabricaría una contradicción tras cada drenaje total y **se retira** (es exactamente el ruido que §4.1 evita). |
| C7 | **Ninguna instancia desplegada trae una clave `watch:` inerte en su `slots.yaml`.** Los YAML viven en el repo `lab` de A.R.B.O.L.; **no verificado desde este repo**. | Gate de despliegue: `grep -n 'watch:' <slots.yaml de cada instancia>` antes de subir la versión. | H2: un `watch:` preexistente malformado rompería el boot — ruidoso, no silencioso, pero rompería. |
| C8 | **El tope de 200 cargas de `deps.uploads` alcanza para el predicado `cargasVividas ≥ 1`** — solo fallaría en un slot cuyas últimas 200 filas del registro fueran todas rechazadas o retro, con cargas ok más viejas. Se asume improbable; **sin medir en instancia**. | Consultar en la instancia: `SELECT slot_id FROM intake_upload GROUP BY slot_id HAVING SUM(ok)>0 AND SUM(CASE WHEN rowid IN (SELECT rowid ... LIMIT 200) THEN ok ELSE 0 END)=0` (o revisión manual de volúmenes por slot). | §4.2: el control del directorio callaría en ese slot (falso negativo — no alerta falsa). |

Las conjeturas C1–C5 del diseño 008 siguen vigentes tal como allá se declararon; este frente no
las toca ni las salda. C6 se suma al mismo lote de gates manuales que ya espera C1 y los márgenes
de correlación.

---

## 8 · ¿Qué queda fuera a propósito?

- **Los dos supuestos contra motor vivo del frente anterior** (job muerto ↦ `Failed`; desfase de
  reloj carga↔corrida) — son del lote de gates manuales del despliegue, no de este diseño, y no
  se simulan.
- **El evento de consumo en land-only** (ledger o sidecar que el consumidor externo escriba al
  drenar) — es la única vía hacia el control por-archivo en land-only (§4.1) y exige contrato con
  un actor de la instancia: frente propio, si el vacío-con-éxito residual de §4.3 llega a doler.
- **Persistir el flag `absent` en la proyección** para afinar el banner de la consola —
  imprecisión aceptada (§4.2); reabrirlo pide un caso real donde el texto genérico confunda.
- **La escritura de proyección bajo contradicción** (§4.3, limitación observada) — conducta del
  frente anterior; corregirla es otro pendiente si alguna vez muerde.
- **«Vigilado pero mudo»** como tercer estado del opt-out — evaluado y descartado (§3.3).
- **N configurable para `CORRIDAS_SIN_LOG_AVISO`** — el 3 sigue siendo constante del producto;
  volverlo declarable espera evidencia de campo, igual que cuando se fijó.

---

• *Diseño del frente cierre-pendientes-intake · Simón Alero · 2026-08-13*
