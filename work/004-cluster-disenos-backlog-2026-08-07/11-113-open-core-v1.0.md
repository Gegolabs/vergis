# 11 · #113 Open-core — el corte entre núcleo abierto y lo que no lo es · v1.0

**Frente:** #113 (épica de roadmap, ítem «Open-core — definir el corte entre núcleo abierto y lo que no lo es»)
**Horizonte:** largo plazo — arquitectura decidida + primer hito ejecutable (regla 5 del plan del cluster)
**Naturaleza:** diseño de PRODUCTO tanto como de código. Toda decisión de negocio fue sometida y resuelta el 2026-08-08: D1–D5 aprobadas por César; D6 (marca) diferida — queda en `TODO.md`.
**Aviso de competencia:** este documento razona sobre licencias de software. Su autor es diseñador, no abogado; cada afirmación jurídica lleva marcada dónde termina la certeza. Nada aquí es asesoría legal — antes de firmar un contrato comercial o aceptar el primer PR externo, la estructura elegida pasa por un abogado.

---

## 1 · Estado actual verificado

Todo lo siguiente se verificó leyendo el repo y GitHub el 2026-08-07.

### 1.1 El repo ya es público y todo él es AGPL

- El repo `Gegolabs/vergis` es **PUBLIC** y GitHub le detecta licencia AGPL-3.0 (`gh repo view Gegolabs/vergis --json visibility,licenseInfo` → `"visibility":"PUBLIC"`, `"key":"agpl-3.0"`).
- `LICENSE:1-2` es el texto íntegro de la GNU AGPL v3. `package.json:20` declara `"license": "AGPL-3.0-or-later"`.
- **No existe ninguna licencia por paquete**: `find packages -iname "LICENSE*"` no devuelve nada, y ningún `packages/*/package.json` tiene campo `license` (verificado leyendo los seis manifiestos). La única declaración de licencia del repo vive en la raíz.
- No existe `CONTRIBUTING.md` ni `NOTICE` (verificado con `ls`).
- **Todo el historial es de un solo autor**: `git shortlog -sne HEAD` → 236 commits, todos de César Obach (dos identidades del mismo email). **Cero contributors externos** — la titularidad del copyright está íntegra en este momento. Este dato es la ventana abierta sobre la que pivota media propuesta (§D5).

### 1.2 El corte declarado hoy

`README.md:60-62` («Edition and license»):

> Core **AGPL-3.0-or-later**, functionally complete on single-node. The Enterprise edition (HA / Kubernetes / carrier-grade) is commercial. The canon's normative specs (Botler contract, Mira spec, DSL, naming) ship with AgencyDomains; their migration to this repo's `docs/` is pending.

Tres hechos sobre esa declaración:

1. **La edición Enterprise no existe como código**: `grep -rni "enterprise"` solo encuentra el README y una mención en `docs/adr-001-lenguaje-y-supply-chain.md:37` («percepción de solidez — factor real en ventas enterprise»). El corte de hoy es una declaración de intención, no una frontera implementada.
2. **La promesa anti-crippleware ya está hecha**: «functionally complete on single-node» es un compromiso público. Cualquier corte que se diseñe hereda esa restricción o la rompe a la vista de todos.
3. **Los specs normativos del canon viven fuera** (AgencyDomains) con migración pendiente — la frontera del estándar (contrato Botler, spec de Mira, DSL, naming) hoy no está en este repo.

### 1.3 El layout: seis paquetes + un server

Workspaces `packages/*` (`package.json:10-12`):

| Pieza | Qué es | Dependencias externas (manifiesto verificado) |
|---|---|---|
| `@vergis/botler` | Runtime Layer 3 genérico: gate, log encadenado, result-cache (`packages/botler/src/`) | **cero** |
| `@vergis/policy` | Kernel RLS «Custos»: IR, binder, codegen ClickHouse/Fabric (`packages/policy/src/`) | **cero** (solo `@vergis/botler`) |
| `@vergis/mira` | Proto-Botlet de información: DSL, parse+validate, pipeline (`packages/mira/src/`) | ajv, ajv-formats, yaml |
| `@vergis/capabilities` | Conectores y render: `execute-sql-dwh/ch`, Fabric/ClickHouse, Vega, governance-store, intake, notas, master-data (`packages/capabilities/src/`) | mssql, tedious, vega, vega-lite, sql.js |
| `@vergis/miranda` | Agente que autora specs: elicitación → DSL → QC① → publicación (`packages/miranda/src/`, `docs/miranda.md`) | yaml (+ workspaces) |
| `@vergis/cli` | `vergis run <spec>` | solo workspaces |

Más `server/` (~9.100 líneas en `server/*.ts`, `wc -l`): serving RLS multi-PI, consola admin, config por PI, capa de notas, Miranda handler, contrato operativo (`server/routes.ts:1-40` enumera el dispatch completo).

`docs/adr-001-lenguaje-y-supply-chain.md:81` sella por contrato que `botler` y `policy` permanecen en **cero dependencias externas**, y `adr-001:79` contempla el port del kernel a Go «cuando exista un driver de negocio concreto: **Custos como producto standalone**, embedding en otro runtime, o distribución como librería/WASM».

### 1.4 El artefacto de release es UN bundle

- `npm run build` (`package.json:17`) compila `server/serve-rls.ts` con esbuild a **un solo archivo** `dist/serve-rls.mjs`; la imagen final corre `node dist/serve-rls.mjs` (`Dockerfile:40-41`).
- El bundle incluye **todos** los paquetes: `server/serve-rls.ts:60-147` importa `@vergis/cli`, `@vergis/botler`, `@vergis/mira`, `@vergis/miranda`, `@vergis/capabilities` y `@vergis/policy`. Miranda viaja en la imagen aunque su flag `MIRANDA_ENABLED` esté apagado por default (`docs/miranda.md:10`, `server/routes.ts:29-31`).
- CI publica la imagen multi-arch a `ghcr.io/gegolabs/vergis` en cada push a main y en tags (`.github/workflows/build.yml:54-67`), con SBOM y provenance.
- **Los paquetes `@vergis/*` NO están publicados en npm**: `npm view @vergis/botler` → 404 (verificado). El único artefacto distribuido es la imagen.
- Detalle: el stage final del `Dockerfile:26-30` copia los manifiestos de cinco paquetes y omite `packages/miranda/package.json`; funciona porque el bundle no resuelve nada en runtime, pero es una asimetría a corregir de paso en el hito H1 (o al menos a documentar).

### 1.5 La frontera Producto/instancia ya hace medio trabajo

`README.md:27,31`: la imagen es **genérica e instance-agnóstica** — specs, policies, datasets, credenciales y conexiones se inyectan desde afuera (`VERGIS_SPECS`, `VERGIS_POLICIES`, `VERGIS_CONNECTIONS`, `VERGIS_DATASETS`); «never baked into the image or the product repo». Todo lo específico del cliente (la instancia GH, sus specs, su operación) **ya vive fuera del repo público**. Y no hay multi-tenancy: el modelo es una imagen por instancia; «multi-reporte» es N Information Products dentro de UNA instancia (`docs/arquitectura-multi-reporte.md` — cero menciones de «tenant», grep verificado).

### 1.6 El argumento de venta es la auditabilidad

`docs/miranda.md:24-31` («¿Por qué es seguro por construcción?») y `adr-001:27-29`: la tesis del producto es que la seguridad no depende de confiar en el proceso — RLS nativo en el motor, spec authz-blind, gate y log encadenado, kernel con oráculo y 2.100 iteraciones de property testing diferencial. Ese argumento **se puede inspeccionar porque el código está abierto**. Es un dato de diseño, no decoración: cerrar las piezas que sostienen la tesis la convertiría en «confía en nosotros».

---

## 2 · Decisiones selladas

### D1 · El criterio del corte: dos tests positivos y uno negativo `[aprobada por César · 2026-08-08]`

**Propuesta.** Una pieza es **núcleo abierto** si pasa cualquiera de los dos tests positivos; es **comercializable** solo si además no cae en el test negativo:

1. **Test de confianza** — ¿es una pieza cuya corrección tiene que poder auditar un revisor de seguridad para creerle al producto? (gate, log encadenado, kernel RLS, riel de serving con RLS, el QC de Miranda). Si sí → **abierta, sin excepción**. Cerrarla contradice la tesis «seguro por construcción» (§1.6) — sería vender un producto de gobierno de datos pidiendo fe.
2. **Test de adopción** — ¿la necesita un desarrollador para correr el producto entero, single-node, end-to-end, con datos reales? (runtime, DSL, conectores, CLI, server, ejemplos, schema). Si sí → **abierta**. Es la promesa «functionally complete on single-node» ya publicada (`README.md:62`); romperla es el modo de falla crippleware.
3. **Test del comprador** (negativo) — ¿el que paga por esta pieza es una organización operando a escala — no el desarrollador que evalúa? (HA/K8s, flota de instancias, control plane multi-instancia, SLAs, herramientas de soporte). Solo lo que pasa este test y **ninguno** de los dos anteriores es candidato a comercial.

**Marcos aplicados y sus fallas, con honestidad:**

- **Open-core por comprador** (el criterio de GitLab: lo que usa el contribuidor individual es libre; lo que compra un director/CFO es pago). Es el test 3. Su falla conocida: la línea **deriva** con la presión comercial — GitLab movió features entre tiers repetidas veces, y el caso «SSO detrás del paywall» (el *SSO tax*) es el ejemplo canónico de cómo el criterio degenera en cobrar por seguridad básica. Mitigación propuesta: los tests 1 y 2 son **vetos** que el test 3 no puede pasar por encima, y quedan escritos en un ADR (H1) para que la derivación futura tenga que derogar un documento, no solo ceder a una tentación.
- **AGPL como foso + dual licensing** (MySQL, MongoDB pre-SSPL, Grafana, MinIO): todo abierto bajo copyleft fuerte; se monetiza la licencia comercial para quien no quiere/puede cumplir la AGPL, más el servicio operado. Su falla: exige **titularidad íntegra del copyright** para siempre (o CLA), y no detiene a un hyperscaler dispuesto a cumplir la licencia. Es sin embargo el marco que mejor calza con el estado actual (§1.1: repo ya público, un solo autor) — se adopta como base en D4/D5.
- **Crippleware** (la crítica clásica de Perens al open-core): la edición abierta deliberadamente incompleta como demo. Se rechaza explícitamente: el test 2 lo veta y la promesa pública ya lo veta.

**La observación estructural que ordena todo:** por la doctrina Producto/instancia (§1.5), lo que Vergis monetiza **hoy** no son features retenidas sino **la operación de instancias** — specs, policies, credenciales y despliegue viven fuera del repo por diseño. El corte open-core no necesita inventarse una frontera: la frontera ya existe, y la propuesta es reconocerla — *el Producto entero abierto; el negocio es operarlo (hoy) y el control plane de flota (mañana)*.

**Alternativa descartada:** criterio único «lo que crea adopción es abierto, lo que monetiza es cerrado». Descartada porque es circular (todo monetiza en potencia) y sin los vetos 1-2 degenera en crippleware al primer trimestre malo.

### D2 · El mapa pieza a pieza `[aprobada por César · 2026-08-08]`

| Pieza (ancla) | Veredicto | Test que decide | Racional de la frontera |
|---|---|---|---|
| `packages/botler` | **Abierta** | 1 y 2 | El gate y el log encadenado son la mitad del argumento de auditabilidad; cero deps por contrato (`adr-001:81`). Es además el contrato que un Botlet de terceros implementaría — cerrado, no hay ecosistema. |
| `packages/policy` (Custos) | **Abierta** | 1 | El kernel RLS es EL objeto de auditoría del producto. Su valor comercial futuro (standalone, `adr-001:79`) no está en cerrarlo sino en su control plane y soporte — un motor de policies cerrado compite contra los RLS nativos de cada motor sin el único diferenciador creíble: que se puede leer. **Sub-decisión diferida**: si llega el driver de embedding/WASM, la licencia del kernel se re-evalúa (¿Apache-2.0 para maximizar embedding vs AGPL como foso? — ver §Destranque E4). |
| `packages/mira` (DSL + pipeline) | **Abierta** | 2 | El DSL es la jugada de estándar: un DSL cerrado jamás se vuelve estándar. Los specs normativos del canon (pendientes de migrar, `README.md:62`) siguen la misma suerte. |
| `packages/capabilities` (conectores + render) | **Abierta** | 2 | Los conectores (Fabric, ClickHouse) son la vía de entrada a cada motor — retenerlos es el modo crippleware. *Honestidad:* los conectores son una palanca clásica de monetización (modelo Airbyte/Fivetran); se descarta porque el catálogo es chico (2 motores) y porque el conector es exactamente lo que un evaluador prueba primero. |
| `packages/cli` | **Abierta** | 2 | Trivial; es la puerta de entrada del developer. |
| `packages/miranda` | **Abierta** | 1 y 2 — ver D3 | Decisión con debate propio abajo. |
| `server/` (serving RLS, admin, notas, intake, config por PI) | **Abierta** | 1 y 2 | Es el «single-node functionally complete». La consola admin de instancia (`server/admin.ts` y compañía) administra UNA instancia — eso es parte del producto completo, no un tier. |
| `deploy/` (compose de referencia, pdf-sidecar) | **Abierta** | 2 | El camino de despliegue single-node es parte de la promesa. |
| `schema/`, `examples/`, `docs/`, `tests/` | **Abiertas** | 2 | La suite de aceptación abierta es parte del argumento de confianza (cualquiera corre los gates que el CI corre). |
| **HA / K8s / operator / carrier-grade** (no existe) | **Comercial** | 3 | Ya declarado en `README.md:62`. El comprador es una organización con SLA, nunca el evaluador. |
| **Control plane de flota / consola multi-instancia** (no existe) | **Comercial** | 3 | Administrar N instancias de N clientes es el negocio del operador (Gegolabs), no una necesidad del que corre la suya. No confundir con la consola admin de instancia (abierta, fila `server/`). |
| **Multi-tenancy en una instancia** (no existe, §1.5) | **Indecisa** | — | Hoy el modelo es imagen-por-instancia y no hay demanda verificada de multi-tenant. Decidirlo hoy sería fingir precisión; ver §Destranque E5. Sesgo declarado: si nace como mecanismo de eficiencia del hosting de Gegolabs → comercial (test 3); si nace como necesidad del self-hoster → abierta (test 2). |
| **Canales de salida email/Slack** (frente 08 de este cluster; #100/#102) | **Abierta** | 2 | Un producto de reportes que solo entrega por pantalla en su edición abierta es crippleware con otro nombre. Cerrar canales es la variante del SSO-tax. |
| **Servicio hosteado / instancias operadas** | **Comercial** (no es código) | 3 | Es el negocio actual de facto (§1.5). No requiere cerrar ni una línea. |

**Alternativa descartada (mapa):** cerrar `server/` dejando abiertos solo los paquetes (modelo «SDK abierto, producto cerrado»). Descartada: rompe el test 2 y la promesa publicada, y el server es donde vive el riel «no hay camino de servir sin RLS» (`README.md:31`) — exactamente lo que un auditor quiere leer.

### D3 · Miranda queda abierta `[aprobada por César · 2026-08-08]`

Miranda es la decisión de verdad contestable — es la feature «wow», la más cara de construir, y la que un competidor copiaría primero. Se sella **abierta**, por cuatro razones:

1. **Ya está publicada.** `packages/miranda` vive en el repo público bajo AGPL y viaja en la imagen (§1.4). Lo publicado bajo AGPL queda licenciado así **para esas versiones, irrevocablemente** — retirarla solo aplicaría hacia versiones futuras, con el fork como salida natural para cualquiera. El costo reputacional de un retiro (el patrón «rug pull») supera el valor retenido. *(Certeza: alta en lo estructural — la AGPL es irrevocable para lo distribuido —; la mecánica exacta de «cerrar versiones futuras» es terreno de abogado.)*
2. **Pasa el test 1**: la mitad del diseño de Miranda es su argumento de seguridad (spec authz-blind, gates en código, mismo riel RLS para preview — `docs/miranda.md:24-31`). Ese argumento vale porque se puede leer.
3. **Su costo marginal ya está gateado por naturaleza**: Miranda consume un LLM que cada instancia paga con sus propias credenciales (la doctrina de instancia, §1.5). El «costo de regalarla» es cercano a cero para Gegolabs.
4. **Es el imán de adopción**: es la pieza que hace demo.

**Alternativa descartada:** Miranda comercial (o «community limitada a N specs/mes»). Racional del descarte además de lo anterior: un límite de uso en código AGPL es removible por cualquiera (§D4, opción c), así que solo funcionaría cerrando el paquete — y eso choca con la razón 1. **Lo que sí queda libre para monetizar** sin tocar este sello: rúbricas/catálogos curados por Gegolabs, tuning por vertical y la operación de Miranda en instancias hosteadas — todo eso es contenido/servicio de instancia, no código del Producto.

### D4 · Mecánica del corte: monorepo público 100 % AGPL hoy; repo privado para lo comercial cuando exista `[aprobada por César · 2026-08-08]`

Las tres mecánicas, pesadas contra el CI/release real (§1.4):

| Opción | Qué es | Costo sobre CI/release actual | Veredicto |
|---|---|---|---|
| **(a) Monorepo multi-licencia** | Paquetes con licencias distintas en el mismo repo público (p. ej. `policy` Apache-2.0, resto AGPL) | Bajo en CI (el build no cambia), pero exige licencia-por-paquete, headers SPDX y disciplina en cada PR. Solo sirve para **mezclar licencias abiertas** — un repo público no puede contener código cerrado. El bundle único (`package.json:17`) no es problema legal mientras todo sea abierto (la obra combinada queda AGPL), pero sí borra la frontera en el artefacto. | **Diferida** — se activa solo si el kernel cambia de licencia (E4). |
| **(b) Repos separados** | `vergis` público AGPL íntegro + `vergis-enterprise` privado que consume lo público | **Cero costo hoy** (no existe nada comercial). Mañana: el repo privado consume la imagen `ghcr.io/gegolabs/vergis` (`FROM` o sidecar/control-plane que habla HTTP con ella) o los paquetes — lo segundo exigiría publicar `@vergis/*` en npm (hoy 404, §1.4) o dependencias por git. CI propio en el repo privado; el público no se toca. | **Elegida.** |
| **(c) Edición única con features gated** | Todo el código en el repo público; features comerciales tras license-key | Incompatible con AGPL de facto: el gate es código abierto y cualquiera lo quita legalmente. La variante real (GitLab: subdirectorio `ee/` con licencia propietaria en el repo visible) es fuente-visible-no-libre: confunde la historia de licencia, exige que CI excluya `ee/` de la imagen pública, y atrae la hostilidad que Vergis no necesita. | **Descartada.** |

**Regla arquitectónica que hace viable (b) sin abogados de por medio:** lo comercial futuro se construye como **programa separado que habla con Vergis por sus APIs/protocolos** (control plane que administra instancias vía HTTP, operator de K8s que orquesta la imagen), **no** como módulo linkeado dentro del proceso AGPL. La frontera «obra derivada» de la AGPL en linking es terreno famosa-mente no testeado en tribunales — *aquí termina mi certeza jurídica* —; la frontera proceso/red es la única que todo el mundo acepta como segura, y casualmente es la que la arquitectura de Vergis ya usa para todo (gate por headers, env de afuera, sidecar de PDF en `deploy/pdf-sidecar`). Nota: mientras Gegolabs sea titular único del copyright puede además relicenciarse a sí misma cualquier pieza y linkear lo que quiera — la regla del proceso separado es el diseño robusto para el día en que deje de serlo (D5).

**Consecuencia operativa hoy:** ninguna. El corte no exige mover un archivo, cambiar el CI ni partir el bundle. Lo único que exige es **escribirse** (H1) para que las piezas futuras nazcan del lado correcto.

### D5 · Compatibilidad con la licencia vigente — y la ventana que se cierra sola `[aprobada por César · 2026-08-08]`

**¿La AGPL-3.0-or-later es compatible con el corte propuesto?** Sí, y es la licencia correcta para él:

- **Contra el fork cerrado y el SaaS silencioso:** la cláusula de red (`LICENSE:540-551`, §13) obliga a quien **modifique** el programa y lo sirva por red a ofrecer el fuente de su versión a los usuarios remotos. Un tercero que hostee Vergis **modificado** debe abrir sus cambios. **Límite de certeza:** la lectura común es que servir Vergis **sin modificar** NO dispara obligaciones nuevas (§13 dice «if you modify the Program») — es decir, la AGPL no prohíbe legalmente un «Vergis-as-a-Service» de terceros sin cambios; lo vuelve poco atractivo (no pueden diferenciarse sin abrir sus diferencias). Esta lectura es la mayoritaria, no está testeada en tribunales, y soy diseñador, no abogado.
- **El disuasor comercial funciona a favor:** muchas organizaciones prohíben internamente código AGPL en su stack. Para un producto de adopción viral eso sería un problema; para Vergis es **el funnel**: la organización que no puede tocar AGPL es exactamente la que compra la licencia comercial o el servicio operado. El dual licensing es posible **solo mientras Gegolabs sea titular de todo el copyright** (§1.1: hoy lo es).
- **La ventana que se cierra sola:** el primer PR externo mergeado sin acuerdo de contribución introduce copyright ajeno y **clausura el dual licensing para siempre** sobre ese código (renegociar con cada contributor pasado es en la práctica imposible — es la trampa en la que cayó más de un proyecto que quiso relicenciar tarde). Por eso el hito H1 instala el mecanismo **antes** de que exista el primer PR, cuando instalarlo es gratis y no ofende a nadie.
  - **Mecanismo propuesto:** `CONTRIBUTING.md` con **DCO (sign-off) + cláusula de licencia de contribución** que otorga a Gegolabs derecho de relicenciar lo contribuido (un CLA ligero inline, no un formulario aparte — fricción mínima, ventana preservada). **Alternativa descartada:** DCO solo — preserva la limpieza del inbound pero NO habilita relicenciar; la descartamos justamente porque cierra la ventana que queremos mantener abierta. *(La redacción exacta de la cláusula es trabajo de abogado — aquí se sella la existencia del mecanismo, no su texto.)*
- **Qué NO se propone:** cambiar de licencia (SSPL, BSL, fair-source). La AGPL ya está publicada, el foso que da es suficiente para el tamaño actual del riesgo (cero competidores hosteando Vergis), y cada uno de esos cambios cobra un precio reputacional que hoy no compra nada. Ver §Destranque E3 para el evento que reabriría la pregunta.

### D6 · Identidad de marca como segundo foso `[diferida por César · 2026-08-08 — la decidirá después; registrada en TODO.md]`

La licencia protege el código; **la marca protege el nombre**, y en open-core el nombre es lo único que un fork no se puede llevar (Grafana puede forkearse; llamarse Grafana, no). Propuesta mínima: decidir conscientemente (César) si registrar «Vergis» (y eventualmente «Custos», «Miranda» como sub-marcas) como marca — el registro temprano es barato y su ausencia es irreversible si otro lo hace primero. No se diseña aquí una política de trademark; solo se sella que **la pregunta es parte del corte open-core** y queda en la mesa de César. *(Conjetura declarada: no verifiqué el estado registral de «Vergis» en ningún registro de marcas.)*

---

## 3 · Arquitectura y contratos

### 3.1 El contrato de edición (lo que H1 escribe en piedra)

Un documento canónico `docs/adr-002-open-core.md` — el ADR es el formato correcto: es una decisión con contexto, no un manual — con este contenido normativo:

1. **Los tres tests de D1**, con los tests 1-2 declarados como vetos que el test 3 no puede pasar por encima.
2. **El mapa de D2** (tabla abierto/comercial/indeciso) como registro vivo: toda pieza nueva del roadmap se clasifica **en su documento de diseño**, citando el test que decide — la clasificación tardía es la puerta del crippleware.
3. **La regla del proceso separado** (D4): código comercial jamás linkea dentro del proceso AGPL; consume APIs.
4. **La promesa anti-crippleware** «functionally complete on single-node» elevada de frase del README a cláusula del ADR.

### 3.2 Higiene de licencia del repo público

- `"license": "AGPL-3.0-or-later"` en los seis `packages/*/package.json` (hoy ausente, §1.1) — importa porque son paquetes con `name` propio y el día que se publiquen a npm (E2) el campo es obligatorio; ponerlo hoy cuesta seis líneas.
- `CONTRIBUTING.md` con el mecanismo de D5 (DCO + cláusula de relicencia) y el puntero al ADR-002.
- README «Edition and license» reescrito para reflejar el corte sellado (hoy dice solo HA/K8s; el corte de D2 es más preciso: agrega control plane de flota y el servicio operado, y declara los vetos).
- Corregir/documentar la asimetría del Dockerfile con `packages/miranda` (§1.4).

### 3.3 Shapes de las fronteras futuras (solo contratos, sin fingir precisión)

- **Control plane de flota (comercial):** programa aparte, repo privado; administra instancias Vergis por las superficies que ya existen — la imagen pública `ghcr.io/gegolabs/vergis`, sus env vars de instancia (`VERGIS_*`), el gate por headers y los endpoints admin. Si al construirlo faltan superficies (p. ej. un endpoint de salud/versión más rico, un contrato de configuración remota), **la superficie se agrega al lado abierto** — porque también le sirve al self-hoster (test 2) — y la orquestación queda del lado comercial. Esa es la regla de reparto para cada duda futura: *superficie abierta, orquestación comercial*.
- **HA/K8s (comercial):** operator/charts en el repo privado, consumiendo la imagen pública sin parcharla. Si HA exigiera cambios dentro del server (p. ej. estado compartido), esos cambios van al lado abierto — un server que solo escala con parches privados rompería el test 1 de auditabilidad del riel.
- **Custos standalone (indeciso, E4):** el paquete ya tiene la forma para extraerse (cero deps, oráculo, property tests — `adr-001:79`); la decisión pendiente es de licencia, no de código.

---

## 4 · Plan de construcción

Un solo hito implementable hoy; todo lo demás de este frente está atado a eventos (§5). Elaborado para un Opus en frío.

### H1 · Sellar la edición abierta

**Territorio:** `docs/adr-002-open-core.md` (nuevo) · `CONTRIBUTING.md` (nuevo) · `README.md` §«Edition and license» · `packages/{botler,capabilities,cli,mira,miranda,policy}/package.json` · `Dockerfile` (línea de manifiestos, §1.4).

**Trabajo:**
1. Escribir `docs/adr-002-open-core.md` con el contenido normativo de §3.1 (los tests, el mapa, la regla del proceso separado, la cláusula anti-crippleware). Estado «Propuesto» hasta el OK de César; «Aceptado» después.
2. Escribir `CONTRIBUTING.md`: DCO con `Signed-off-by` + cláusula de licencia de contribución (D5) marcada `<!-- redacción sujeta a revisión legal -->` + cómo correr los gates (`npm ci && npm run typecheck && npm test`).
3. Agregar `"license": "AGPL-3.0-or-later"` a los seis manifiestos de `packages/`.
4. Reescribir `README.md:60-62` según el corte sellado (D2), enlazando el ADR-002.
5. Agregar `COPY packages/miranda/package.json packages/miranda/package.json` a los dos stages del `Dockerfile` (líneas 10-14 y 26-30) — o, si `npm ci` del stage final fallara por el workspace sin código, documentar la omisión con un comentario en el Dockerfile explicando por qué miranda viaja solo en el bundle. Decidir por el resultado del build, no por preferencia.

**Hecho cuando (verificable por comando):**
- `node -e 'const fs=require("fs");for(const p of fs.readdirSync("packages")){const j=JSON.parse(fs.readFileSync("packages/"+p+"/package.json"));if(j.license!=="AGPL-3.0-or-later")throw p}'` sale 0.
- `test -f docs/adr-002-open-core.md && test -f CONTRIBUTING.md` sale 0.
- `grep -q "adr-002" README.md` sale 0.
- `docker build .` sale 0 (la variante del punto 5 que haya quedado).

**Juez:** los gates del CI (`build.yml:28-32`: `npm ci`, audit, typecheck, test, build) en verde, más el build de imagen. **Gate humano previo:** este hito NO se implementa hasta que César apruebe D1-D6 — todo el hito es la cristalización de esas decisiones.

---

## 5 · Destranque

Este frente es de largo plazo por diseño: casi todo su contenido se activa por eventos, no por calendario. Cada evento con su decisión asociada:

| # | Evento | Decisión que destranca | Qué re-verificar al llegar |
|---|---|---|---|
| **E1** | **Primer PR externo no trivial** | El mecanismo D5 tiene que existir ANTES del merge — este evento no destranca H1: lo **vence**. Si llega antes de H1, H1 se ejecuta de emergencia primero. | Que el texto legal de la cláusula haya pasado por abogado. |
| **E2** | **Primer cliente/partner que quiere self-host o embed** | Oferta dual-license concreta y pricing (César); probablemente publicar `@vergis/*` a npm (hoy 404). | Titularidad del copyright aún íntegra; el mapa D2 contra el repo real (habrá crecido). |
| **E3** | **Primer tercero hosteando Vergis como servicio** | Reabrir la pregunta de licencia (¿AGPL basta? ¿SSPL/BSL?) — hoy sería resolver un problema que no existe. | Cuánto copyright externo entró desde H1 (determina si relicenciar sigue siendo posible). |
| **E4** | **Driver de negocio para Custos standalone/embedding** (el de `adr-001:79`, mismo evento que dispara el port a Go) | Licencia del kernel: ¿Apache-2.0 para maximizar embedding o AGPL como foso? + mecánica (a) de D4 (monorepo multi-licencia) o extracción a repo propio. | Que `policy` siga en cero deps (`adr-001:81`); el acoplamiento real `policy`→`botler` (`packages/policy/package.json`). |
| **E5** | **Demanda real de multi-tenancy** (de un self-hoster o del hosting propio) | La fila «indecisa» del mapa D2, con el sesgo ya declarado (según de qué lado nace la demanda). | La doctrina imagen-por-instancia (§1.5) — si para entonces cambió, el sesgo se recalcula. |
| **E6** | **Primera pieza comercial con código** (control plane, operator) | Crear `vergis-enterprise` privado con su CI (mecánica b de D4). | La regla «superficie abierta, orquestación comercial» (§3.3) contra la pieza concreta. |

**Sensible a envejecer mientras tanto:** el mapa D2 está anclado al layout de hoy (seis paquetes + server); cada frente nuevo del backlog que agregue una pieza debe clasificarla en su diseño (§3.1.2). Las anclas de línea (`README.md:60-62`, `Dockerfile:26-30`, `package.json:17`) se desplazan con la vida normal del repo — al destrabar cualquier evento, re-verificarlas antes de citarlas.

---

## 6 · Riesgos y no-metas

### Riesgos

1. **Derivación del criterio (el riesgo #1 de todo open-core).** La presión comercial futura empujará features hacia el lado cerrado caso a caso. Mitigación: los vetos de D1 escritos en ADR (derogarlos exige un acto documentado), y la clasificación en el diseño de cada pieza, no después.
2. **La ventana de copyright se cierra sin ceremonia.** Un PR externo pequeño y bienintencionado, mergeado un viernes, y el dual licensing queda comprometido. Mitigación: E1 declarado como *vencimiento* de H1, no como su disparador.
3. **Frontera «obra derivada» de la AGPL no testeada.** Si alguna pieza comercial futura se linkea al proceso en vez de hablar por red, el riesgo legal es real y no cuantificable por mí. Mitigación: regla del proceso separado (D4) como norma arquitectónica, no como guía.
4. **AGPL como freno de adopción del lado abierto.** Organizaciones con política anti-AGPL no evaluarán ni la parte gratis. Se acepta a sabiendas: es el mismo mecanismo que crea el funnel comercial (D5). Si la adopción abierta se volviera el cuello de botella del negocio, eso es una variante de E3 (reabrir licencia) — no un motivo para decidir distinto hoy.
5. **Certeza jurídica limitada de este documento.** Las lecturas de la AGPL §13, la irrevocabilidad y la mecánica de dual licensing son las mayoritarias en la industria, verificadas contra el texto de la licencia (`LICENSE:540-551`) pero **no contra jurisprudencia ni con un abogado**. Toda decisión que firme un contrato pasa por revisión legal — está dicho en el encabezado y se repite aquí porque es el riesgo que más barato es olvidar.

### No-metas

- **No** se decide precio, packaging ni tiers comerciales (César, con E2 en la mano).
- **No** se redactan textos legales (CLA/cláusulas) — se sella su existencia y su momento, no su letra.
- **No** se cambia la licencia vigente ni se propone cambiarla.
- **No** se parte el repo, ni el bundle, ni el CI — el corte de hoy es documental por diseño (D4: costo cero sobre el release actual).
- **No** se cierra nada ya publicado: lo distribuido bajo AGPL queda AGPL.

---
• 🤖 Claude (Fable) · diseño del frente #113 open-core · cluster 004
