# Plan · `VERGIS_MENU` bajo recarga en caliente

| Campo | Valor |
|--|--|
| Objetivo | Las secciones de menú que declara la instancia (`VERGIS_MENU`, CAP-190) pasan a recargarse **sin recrear el proceso**, como ya lo hacen los avisos, los dueños de PI y el registro de fuentes. Editar el YAML y el menú cambia; hoy hay que esperar a un anillo nuevo. |
| Origen | Instancia GH: el portal de ayuda (`/ayuda/`) reemplaza seis enlaces del menú y el cambio quedó atrapado hasta la próxima promoción. **Medido el 2026-09-21** contra `0.29.0` en producción: se escribió el `menu.yaml` nuevo y el catálogo vivo siguió sirviendo los seis enlaces viejos — el watch de instancia no lo cubre. |
| Diseño | Fable (esta sesión), sobre `main@e80ac72` (= `v0.29.0` + un commit de bitácora) |
| Ejecutor | Subagente Opus, worktree `../vergis-wt/menu-reload`, rama `feat/menu-hot-reload` |
| Versión | «Sin publicar» → será **0.30.0** (capacidad nueva ⇒ sube la Y). Catálogo: **`CAP-194`** |

## ¿Por qué esta forma y no otra?

El mecanismo ya existe y está declarado: `RELOADABLE_SLICES` (`server/instance-config.ts:156`) + el watch de `instanceTargets` (`server/serve-rls.ts:~3049`) + `reloadInstanceSlices` (`:2811`). El menú se queda fuera solo porque se carga con `loadOne` en vez de `loadSlice`. **Esto es mover una config de una tabla a la otra, no inventar maquinaria.**

Y el consumo ya está listo para verlo: los tres consumidores leen `INSTANCE_CFG.menuSections` **por request** (`serve-rls.ts` 1108, 1263, 1974), así que basta con que la recarga deje el valor nuevo donde ellos miran.

## ¿Qué se decide acá y no se re-decide?

1. **El arranque no cambia:** la clave raíz `menu:` ausente sigue siendo **fatal** al arrancar (contrato vigente de CAP-190). Lo que cambia es qué pasa **después**.
2. **Una recarga jamás tumba el nodo.** Es la regla que ya siguen los otros slices (`reloadInstanceSlices` comenta: «su incumplimiento RECHAZA EL SLICE (no el proceso)»). Si el archivo nuevo no parsea, o le falta la clave raíz, o el YAML está a medio escribir: **se conserva lo vigente**, se avisa por log con el motivo y el menú sigue sirviendo lo último bueno. Un menú mal escrito no vale sacar la plataforma de servicio.
3. **Las entradas inválidas se siguen omitiendo una por una, con su aviso** — igual que en el arranque (sección sin `title`, enlace sin `label`/`href`, `href` que no sea ruta `/…` ni `https://`). En la recarga esos avisos se **re-emiten** al log, nombrando que vienen de una recarga, no del arranque.
4. **Los consumidores no se tocan.** La recarga deja el valor nuevo en `INSTANCE_CFG.menuSections` / `INSTANCE_CFG.menuWarnings` de modo que los tres puntos de lectura lo vean sin cambiar una línea. ⚠️ **Verificar antes de elegir cómo**: si algún consumidor **captura** el arreglo al arranque en vez de leer la propiedad por request (mirar `serve-rls.ts:1974`, que lo pasa dentro de un objeto), entonces mutar el arreglo **en sitio** (`splice`) es obligatorio y reasignar la propiedad no alcanza. Medir los tres, no suponer.
5. **Cero env nueva, cero cambio de contrato, cero migración.** Una instancia sin `VERGIS_MENU` no registra el watch y se comporta idéntico.

## ¿Dónde se toca?

| # | Archivo | Cambio |
|--|--|--|
| 1 | `server/instance-config.ts` | `RELOADABLE_SLICES` gana `menu: { env: 'VERGIS_MENU', parse: parseMenuConfig }` (tipo `InstanceSlice<…>` con lo que devuelva `parseMenuConfig`). `loadInstanceConfig` pasa a cargarlo con `loadSlice(env, RELOADABLE_SLICES.menu, readFile)` — el comentario de arriba ya dice por qué: «el boot no puede parsearlos distinto de como los parseará el watch». Actualizar el comentario de la tabla (hoy enumera «avisos, dueños de PI y registro de fuentes») y el de `menuSections`/`jobTemplates` si nombran al menú como no-recargable. |
| 2 | `server/serve-rls.ts` `instanceTargets` (~3049) | añadir `MENU_PATH` (la ruta de `VERGIS_MENU`) al arreglo y `'VERGIS_MENU'` a los `envs` declarados del watch; extender el texto de `reloads:` para nombrar las secciones de menú. Si no existe una constante `MENU_PATH`, derivarla como las hermanas (`NOTIFY_PATH`, `PI_OWNERS_PATH`). |
| 3 | `server/serve-rls.ts` `reloadInstanceSlices` (~2811) | bloque nuevo para el menú, con el **mismo patrón validate-before-swap** de los hermanos: parsear a una variable, y solo si salió bien, volcar a `INSTANCE_CFG.menuSections` y `INSTANCE_CFG.menuWarnings` (según lo que decida el punto 4 de arriba). Ante `throw`: conservar lo vigente y loguear `[vergis-rls] VERGIS_MENU: recarga rechazada, se conserva lo vigente: <motivo>`. Ante éxito: loguear el conteo nuevo (`menu N sección(es) · M enlace(s)`) y re-emitir los avisos de omisión. |
| 4 | `server/serve-rls.ts` línea de `SIGHUP` (~3093) | el texto que enumera qué recarga la señal debe nombrar también las secciones de menú. |
| 5 | `docs/capacidades.md` | Fila **`CAP-194`**: «Las secciones de menú de la instancia (`VERGIS_MENU`) se recargan en caliente; una recarga inválida conserva lo vigente» · `<sin publicar>`. Si la fila de `CAP-190` dice o implica que el menú es de arranque, corregirla. |
| 6 | `docs/` | El documento donde vive CAP-190 (buscar `VERGIS_MENU` en `docs/`; probablemente `arquitectura-multi-reporte.md`): un párrafo con la recarga y su regla de fallo. |
| 7 | `CHANGELOG.md` «Sin publicar» | `### El menú declarado por la instancia se recarga en caliente (`VERGIS_MENU`)`: qué trae, **por qué** (el caso medido de la instancia GH), qué exige (nada), qué NO hace (el arranque sigue siendo fatal ante la clave raíz ausente; no cubre el resto de la config de instancia). |
| 8 | `INDEX.md` | Fila `016` → este directorio. |

## Tests (`tests/menu-hot-reload.test.ts`, cada uno debe fallar contra `main`)

Mirar antes `tests/` por los que ya cubren la recarga de los hermanos (buscar `reloadInstanceSlices`, `RELOADABLE_SLICES`, `watch`) y **seguir ese patrón**, no inventar uno.

1. `RELOADABLE_SLICES.menu` existe y su `env` es `VERGIS_MENU`; `loadSlice` con él parsea igual que el boot (mismo objeto para el mismo YAML).
2. **Recarga feliz:** con un `menu.yaml` de 1 sección/2 enlaces cargado, se reescribe a 1 sección/1 enlace y tras la recarga `INSTANCE_CFG.menuSections` refleja lo nuevo.
3. **Los consumidores lo ven:** el HTML de `avatarMenu` construido con `INSTANCE_CFG.menuSections` después de la recarga trae el enlace nuevo y **no** trae el viejo. (Si el punto 4 del diseño obligó al `splice`, este test es el que lo prueba: comparar además la **identidad** de la referencia antes/después.)
4. **Recarga rota:** YAML inválido o sin clave raíz ⇒ no lanza, `menuSections` **sigue siendo el vigente**, y hay un aviso con el motivo.
5. **Entradas inválidas:** una sección sin `title` y un `href: javascript:…` ⇒ se omiten con aviso y el resto entra (mismo comportamiento que el arranque).
6. **Control — sin `VERGIS_MENU`:** no hay target de watch para el menú y la config queda con cero secciones, idéntica a hoy.
7. **Contrato:** el snapshot/declaración del contrato lista `VERGIS_MENU` entre lo recargable (y ya no como `bootOnly`).

## Qué NO hacer

- No cambiar el comportamiento del **arranque** (clave raíz ausente sigue siendo fatal).
- No tocar los otros slices ni su orden, ni el render del avatar (`server/ui.ts`), ni `parseMenuConfig`.
- No meter `VERGIS_GROUPS` ni otras configs «de paso»: la fase 3 de #138·2 no es de este plan.
- No mergear ni taggear.

## Criterios de aceptación

- [ ] `npm run typecheck` · `npm test` · `npm run capacidades:cotejo` · `npm run build` en verde.
- [ ] Stash-check: con el código fuera y los tests puestos, fallan al menos los tests 2, 3, 4 y 7.
- [ ] El arranque de un nodo sin `VERGIS_MENU` no cambia (test 6).
- [ ] PR contra `main`: `feat(instancia): VERGIS_MENU se recarga en caliente`, con la medición y lo que queda sin evidencia.

## Riesgos y reversión

- Riesgo real: que un consumidor capture el arreglo al arranque (punto 4). Se mide leyendo los tres, y el test 3 lo ataja.
- Reversión: revertir el PR. Sin env, sin migración, sin estado.

## Cierre (lo llena el ejecutor)

**Ejecutado** el 2026-09-21 por el subagente Opus, en el worktree `../vergis-wt/menu-reload`
(rama `feat/menu-hot-reload`), sobre `main@e80ac72`.

### La medición que el punto 4 exigía (los tres consumidores)

**El resultado cambia la implementación: el `splice` es obligatorio.**

| Punto de lectura | Qué hace con `INSTANCE_CFG.menuSections` | ¿Le basta reasignar? |
|--|--|--|
| `serve-rls.ts:1108` — `renderIndexPage` (catálogo `/`) | Lee la propiedad **por request** y la pasa a `avatarMenu` | Sí |
| `serve-rls.ts:1263` — `avatarFor` del wiring de notas | Lee la propiedad **por request** | Sí |
| `serve-rls.ts:1974` — `createAdmin({ menuSections })` | **CAPTURA el arreglo al arranque**: `createAdmin` se llama una sola vez y guarda la referencia en sus `deps`; el render la lee a call-time en `admin.ts:1041` (`sections: deps.menuSections`) | **No** |

O sea: reasignar la propiedad habría dejado al avatar de `/admin` sirviendo el menú viejo mientras el
catálogo servía el nuevo — **un menú que cambia según la pantalla**, exactamente lo que CAP-190 existe
para evitar. La implementación hace `splice` sobre `menuSections` **y** sobre `menuWarnings`, y el
test 3 lo pone en riesgo reproduciendo la captura de `createAdmin` literalmente (compara además la
identidad de la referencia con `toBe`); el test 7-bis lo ancla al texto de `serve-rls.ts` (exige el
`.splice(` y prohíbe `INSTANCE_CFG.menuSections =`).

### Qué se tocó (los 8 puntos)

| # | Estado | Nota |
|--|--|--|
| 1 | ✅ | `RELOADABLE_SLICES.menu = { env: 'VERGIS_MENU', parse: parseMenuConfig }` (tipo `InstanceSlice<MenuConfig>`); `loadInstanceConfig` lo carga con `loadSlice`; `InstanceSlice.env` gana `'VERGIS_MENU'`. Comentarios actualizados: cabecera del módulo, doc de `RELOADABLE_SLICES` («los tres» → «los cuatro», con el porqué), y `menuSections`/`menuWarnings` ahora declaran que son **arreglos vivos** y por qué el swap es un splice. `jobTemplates` no nombraba al menú: no se tocó. |
| 2 | ✅ | `MENU_PATH` derivado igual que las hermanas; entra en `instanceArtifacts()` (`source: 'menu'`), en `instanceTargets` y en los `envs` del watch; el texto de `reloads:` nombra las secciones de menú. |
| 3 | ✅ | Bloque `menu` al final de `reloadInstanceSlices`, mismo patrón validate-before-swap. Éxito: log con el conteo (`N sección(es) · M enlace(s)`) + re-emisión de los avisos de omisión + `contract.record(ok:true)` con el artefacto. Fallo: `[hot-reload] VERGIS_MENU: recarga rechazada, se conserva lo vigente (<reason>): …` + `contract.record(ok:false, error: 'menu: …')`. |
| 4 | ✅ | `contract.signal` de `SIGHUP` nombra ahora «secciones de menú». |
| 5 | ✅ | `docs/capacidades.md`: fila `CAP-194`, `sin publicar`. **Desviación menor:** se tocó además la fila de `CAP-165` (que enumeraba los slices recargables y habría quedado mintiendo), agregando «(y `VERGIS_MENU` desde CAP-194)» sin alterar su `Desde`. `CAP-190` no afirmaba que el menú fuera de arranque: se dejó intacta. |
| 6 | ✅ | `docs/arquitectura-multi-reporte.md` §Config declarativa: dos párrafos — la recarga (con el porqué del splice) y su regla de fallo, más la constancia de que el arranque no cambia. |
| 7 | ✅ | `CHANGELOG.md` «Sin publicar»: qué trae · por qué (el caso medido del 2026-09-21) · qué exige (nada) · qué NO hace. |
| 8 | ✅ | `INDEX.md`: fila `016` + «Próximo disponible: 017». |

### Los tests y el stash-check

`tests/menu-hot-reload.test.ts` — **11 casos** (los 7 del plan; el 4 se desdobla en tres variantes de
archivo roto y el 5 y el 7 tienen un `-bis`). Siguen el patrón de `tests/instance-reload.test.ts`
(el orquestador reducido a su esqueleto con las piezas reales, porque `serve-rls.ts` no es
importable) y, para el cableado, el de `tests/imagen-anillo-labels.test.ts` (aserción anclada al
texto del módulo, que falla nombrando el ancla en vez de aprobar por omisión).

**Stash-check ejecutado** (`git stash push -- server/`, tests puestos, suite del archivo):
**9 de 11 fallan sin el código**, incluidos los 2, 3, 4 (las tres variantes) y 7-bis.

| Caso | Sin el código |
|--|--|
| (1) el slice está en la tabla | ❌ falla |
| (2) recarga feliz | ❌ falla |
| (3) el consumidor que capturó el arreglo | ❌ falla |
| (4) ×3 — YAML roto · decapitado · `menu` no-lista | ❌ fallan las tres |
| (5) y (5-bis) omisión por entrada | ❌ fallan |
| (6) control sin `VERGIS_MENU` | ✅ pasa — **es el control**: mide que el comportamiento de hoy no cambia |
| (7) el contrato reclasifica al registrar el watch | ✅ pasa — mide el registro de contrato, que ya tenía el mecanismo |
| (7-bis) el CABLEADO real de `serve-rls.ts` | ❌ falla — **es el que ata la promesa al código**, y el que reprueba el estado de `0.29.0` |

**Desviación anotada en el caso 4:** la primera variante («YAML que no parsea») pasaba con el código
fuera, por el motivo equivocado — sin `RELOADABLE_SLICES.menu`, `loadSlice` lanza un `TypeError` que
el `catch` envuelve con el mismo texto, y un `motivo: /VERGIS_MENU/` lo daba por bueno. Se endureció
a la cita literal del parser de `yaml` (`Block collections are not allowed within flow collections`):
ahora reprueba. Un instrumento que no distingue «medí y salió negativo» de «no pude medir» produce
datos con cara de verdad.

### Los gates (salida real)

| Gate | Resultado |
|--|--|
| `npm run typecheck` | ✅ `tsc --noEmit`, sin salida (corrido **después** de escribir los tests) |
| `npm test` | ✅ **198 archivos · 2.828 tests, todos pasando**, 42,67 s. Ningún test ajeno se rompió |
| `npm run capacidades:cotejo` | ✅ «Numeración sana y todo lo declarado en máquina está citado» · capacidades vigentes: **194** · retiradas: 0 |
| `npm run build` | ✅ `dist/serve-rls.mjs` 2,8 MB |

Diff revisado por secretos: sin coincidencias (`password`/`secret`/`token`/`api key`/clave privada).

### Lo que queda SIN evidencia

- **La recarga no se midió contra un nodo vivo con el watch real de `fs`.** Lo medido es el
  mecanismo —tabla, parser, swap in-place, consumidor capturado, contrato— con las piezas reales, más
  el cableado anclado al texto de `serve-rls.ts`. Lo que **no** se corrió es un proceso levantado que
  reciba el evento de `fs.watch` y sirva el menú nuevo por HTTP: eso exige el arnés vivo con archivo
  montado, el mismo hueco que `tests/instance-reload.test.ts` declara para sus hermanos. La condición
  que lo cerraría: un nodo local con `VERGIS_MENU` montado, reescribir el YAML y hacer `GET /`.
- **No se verificó contra la instancia GH.** Su despliegue corroboraría; no mide por nosotros.
- El plan decía `reloadInstanceSlices (~2811)` y `SIGHUP (~3093)`: las ubicaciones reales en
  `main@e80ac72` son `~2812` y `~3085`. Se adaptó la ubicación, no la semántica.

---

• *Generado con [Wingworking](https://wingworking.org)*
