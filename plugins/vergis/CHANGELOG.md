# Changelog — plugin `vergis`

El plugin tiene **la versión del Producto** (lockstep: `plugin.json` sigue a `package.json`, y el
marketplace lo fija al tag `vX.Y.Z`). Lo que el operador consume de cada versión está en el
`CHANGELOG.md` de la raíz del repo; este archivo registra lo que es **del plugin**: decisiones de
implementación del CLI y de las skills, y la historia que las skills heredaron.

## Sin publicar

- **El CLI sale por `salir(code)`** (`lib/util.mjs`), que espera a que se vacíen stdout y stderr antes
  de `process.exit`. Con `process.exit` a secas, lo encolado en stdout se perdía por la cola con exit 0
  (la prueba de #369 en el CI del corte; entre 4 y 7 de cada 8 corridas en Linux). **Toda medición de
  `vergis-ops` leída por pipe con un CLI anterior a este arreglo se re-mide**: pudo ser un verde
  truncado. El costo: el CLI espera a su lector en vez de truncar. Los `process.exit` de los scripts que
  corren del lado del host (`contract.mjs`, `smoke.mjs`) emiten una sola línea corta antes de salir y
  quedan como están.

Nace el plugin (issue #366).

- **Cuatro skills**: `vergis:ops` · `vergis:rollout` · `vergis:verify` · `vergis:setup`.
- **El CLI `vergis-ops`** (Node ≥ 22, sin dependencias): `check` · `recon` · `health` · `contract` ·
  `smoke` · `marks` · `parity` · `poller` · `publish` · `exec`.
- **Decisiones de implementación** (del ejecutor, dentro de los contratos del diseño):
  - El validador de la declaración es un subconjunto de JSON Schema que **lee el esquema publicado**; la
    suite exige que coincida con ajv sobre cada fixture. Una sola fuente de la regla.
  - El transporte enmarca la salida entre `VERGIS-OPS-BEGIN <nonce>` y el centinela
    `VERGIS-OPS <nonce> rc=<n> lines=<m>`: además del cruce y del remoto mudo, detecta el corte del
    transporte por **cualquiera de los dos extremos** (el centinela solo al final no ve un recorte por el
    principio).
  - `publish` escribe **en sitio** (mismo inodo, dueño y modo): un montaje de archivo en Docker sigue el
    inodo. La clasificación de un archivo que ningún contenedor vivo monta es `service`: publicarlo no
    cambia lo que corre, y su efecto llega con el acto de servicio que lo aplique, con su propio gate.
  - La paridad barre el host a la **profundidad que usa el espejo** en cada familia: lo que el espejo no
    declara en un nivel que él mismo no usa no se le reclama al host.
  - Esquema: además de lo que fija el diseño, `governance.window_approver` (quién autoriza una ventana:
    el operador de la instalación) separado de `governance.approver` (quién aprueba lo destructivo),
    `governance.stage` y `governance.availability` (informativos), `instrument.baseline_seconds` y
    `mirror.unmirrored` (los montajes que el espejo no cubre, con su motivo, para la guardia G1).
- **Lo que corrigió la primera sombra sobre una instalación real** (frente L2, en solo lectura):
  - **El presupuesto de salida de `az` (#369).** El centinela BEGIN/fin detectaba el recorte por la cabeza,
    pero con eso ningún verbo de salida > 4 KB se podía medir por `az-run-command`. Se resolvió en el
    TRANSPORTE y no en cada verbo: la alternativa —resumir en el host para caber— obligaba a diseñar cada
    verbo contra el recorte y seguía rompiéndose con el primer contrato más grande. La salida que no cabe
    en `AZ_INLINE` (3.072 B) se vuelca en el host (mktemp, borrado al bajar el último trozo; los huérfanos
    de más de 60 min los barre la corrida siguiente) y se baja en trozos de `AZ_CHUNK` (2.304 B, 3.072 en
    base64), cada uno con su par BEGIN/centinela, cotejando bytes y sha256. Techo: `AZ_MAX_CHUNKS` = 24.
    El `az` falso de la suite recorta ahora como el real (los últimos 4.096 B) en todos sus modos.
  - **Las exclusiones sin archivo (#371)** se listan siempre, y `check` las advierte.
  - **La memoria de los anillos (#372)**: de las dos salidas que el issue ofrecía, una clave del esquema
    (`rings.memory`) o exigir `mem_limit` en el compose, se eligió la segunda. `ring.args` existe para
    DERIVARSE del compose vivo; una clave en la declaración sería una segunda fuente de la misma verdad,
    que puede divergir del compose sin que nada lo vea. `check` lo advierte (no lo bloquea: ninguna
    lectura depende de ello) y el acto que sí depende —`ring-args`— se niega; el CLI lo coteja antes de
    correr el generador porque el de las imágenes anteriores cae a 1g en silencio.
  - **`build:` no es tag móvil (#370).**
- **Limitación conocida — el poller no mide retención** (#367). `instruments/poller.sh` consulta con
  `wget -T 2` y registra por muestra solo `OK | MAL | SINMEDIR`, sin latencia; la cuenta de `poller
  count/stop` suma `SINMEDIR` a «fuera de predicado». Un request que la sala de espera del borde retiene
  más de 2 s (retención máxima medida en producción: 2.011 ms; el instrumento de referencia del lab usa
  10 s por eso) sale `SINMEDIR`. En el banco, 3 de 12 actos dieron 1 `SINMEDIR` ~1,4 s tras empezar el
  acto, también con el plugin de `4d7fe95`. La hipótesis (es retención, no corte) **no está medida**; el
  refutador es el mismo acto con un segundo poller a 10 s en paralelo. Mientras tanto: la fila del
  corte dice «sin medir» para esas muestras, no «corte», y **ninguna instalación retira su instrumento
  de medición de corte a favor de este poller hasta que mida retención**.
- **Dos defectos que el arnés encontró al construirse**, y por qué quedan escritos: un `case` dentro de
  `$( … )` que `dash` no parsea — y el CLI lo leía como «/contrato no respondió» (hoy la suite pasa
  `dash -n` sobre cada script generado); y la trampa `TERM` del poller, que limpiaba sin terminar el
  proceso (un `poller stop` no lo paraba).

### ¿Qué se midió de la instalación, y cómo?

Con Claude Code 2.1.284, el 2026-09-29 (V9 del diseño):

- **El marketplace instala el TAG, no `main` — medido contra GitHub.** Un repo de prueba efímero con el
  plugin en un tag (`SENTINEL=TAG`) y otro contenido en `main` (`SENTINEL=MAIN`), marketplace `git-subdir`
  con `ref` al tag: `marketplace add <owner>/<repo> --sparse .claude-plugin plugins` + `install` dejan en
  la caché `SENTINEL=TAG`, y `installed_plugins.json` registra el commit del tag. El clon del
  marketplace con `--sparse` trae `.claude-plugin/`, `plugins/` y los archivos de la raíz, y **no** los
  demás directorios.
- **`--sparse` solo vale para fuentes git o GitHub**: `marketplace add <directorio>` lo rechaza. Para
  probar un checkout local se agrega el directorio sin `--sparse`.
- **`${CLAUDE_PLUGIN_ROOT}` llega sustituido con el plugin INSTALADO** (no solo con `--plugin-dir`): la
  skill `vergis:setup` recibió `node <home>/.claude/plugins/cache/vergis/vergis/<versión>/bin/vergis-ops.mjs
  check`, y esa línea corrió (`--help`, exit 0).
- **`bin/` del plugin entra al `PATH` del Bash de la sesión**: `command -v vergis-ops.mjs` lo encuentra.
  Las skills igual invocan `node ${CLAUDE_PLUGIN_ROOT}/bin/vergis-ops.mjs`: no dependen del shebang ni de
  que el `node` del `PATH` sea ≥ 22.
- **El filtro `v[0-9]*` de GitHub Actions**, medido en el mismo repo de prueba: el push del tag `v0.0.1`
  disparó el workflow; el de `vergis--v0.0.0`, no.

## Historia heredada (de la skill del primer adoptante)

**Límites medidos el 2026-08-18 sobre el CHANGELOG dentro de la imagen**, que `vergis:rollout` conserva
como historia: (a) las imágenes publicadas hasta `0.20.0` inclusive **no** traen el CHANGELOG ni los
labels de documentación — para un salto que las involucre, el changelog se lee del repo en el tag, no de
la imagen; (b) en ese momento la única imagen con el label de documentación era `:main`, y apuntaba a
`blob/main/CHANGELOG.md`, una rama móvil: inspeccionar una imagen vieja habría llevado al changelog de
hoy. El workflow de build ancla hoy ese label al ref exacto que se construye.

• *Generado con Wingworking*
