# Frescura — Oferta / Demanda, Observabilidad, Reconciliación

> **Documentación canónica del Producto.** Cómo Mira/Vergis gobierna *cada cuánto se actualiza el dato* —
> para humanos y para **agentes**. Genérico, independiente de instancia. Implementación de referencia:
> `packages/capabilities/src/freshness.ts`.

## 1 · Dos conceptos DISTINTOS (a propósito)

| Concepto | Qué es | Quién lo declara | Dónde vive |
|----------|--------|------------------|------------|
| **Oferta** | cada cuánto se actualiza una **fuente** (o se publica una data maestra) | quien **conecta** la fuente | registro de fuentes (`GovernanceStore`) |
| **Demanda** | cada cuánto el **negocio** necesita el dato fresco en un PI | **colaboradores** del PI (incl. dueños) | gobierno del PI |

Ambos son **duraciones ISO-8601** (`PT1H`, `P1D`, `P1W`). **No se unifican** — el valor de nombrarlos
distinto es poder expresar y razonar la **brecha** entre lo que el negocio pide y lo que la fuente da.

## 2 · Techo de la demanda

> Un PI **no puede exigir más fresco que su fuente más lenta.** Formalmente: `demanda(max_age) ≥
> máx(oferta)` de sus insumos. El caso "PI quiere `PT1H`, fuente da `P1D`" es justo lo que el techo
> **impide**: el máximo exigible es diario.

Los **insumos de un PI se derivan del spec** (las tablas que toca, ya parseables) cruzados con un
registro **tabla → fuente**. El techo se **calcula**, no se declara — sin drift. Editar una demanda que
viola el techo se **rechaza** con el máximo exigible.

## 3 · Cadencia requerida — por entidad (demanda) y por proceso (schedule)

> `cadencia_requerida(entidad) = mín(demanda de los PIs que consumen esa entidad)`, **con piso en la
> oferta** de su fuente. Y `cadencia_requerida(proceso) = mín` sobre las entidades que produce — porque
> el **proceso es la unidad de ejecución**: corre entero, no por entidad.

**Entidad = unidad de demanda; proceso = unidad de schedule.** El negocio demanda **entidades** (tablas
silver que un PI consume); el motor agenda **procesos**. La cadencia requerida de una entidad es la de
sus consumidores; la de un proceso es el mínimo (más exigente) sobre las entidades que produce.

Dos superficies, dos clases de gestión (ver [`gestion-de-dominio.md`](gestion-de-dominio.md)):

- **Fuentes** (Gestión de **Plataforma**) — el **registro de fuentes**: conexión, **oferta**, salud /
  último pull. Técnico, transversal. Es el insumo (bronze) de la matemática.
- **Frescura** (Gestión de **Dominio**, por dominio) — el análisis de brecha **por entidad**: oferta de
  su fuente · demanda de sus PIs · cadencia requerida · **insatisfacible** (demanda más fina que la
  oferta) · corridas (linaje) · schedule deseado/real · salud. Hace explícito "cada cuánto debe
  refrescarse cada entidad" — antes implícito y sin dueño.

La derivación pura vive en `freshness.ts`: `deriveIngestionMap` (por proceso, alimenta el reconciliador)
y la proyección por entidad (alimenta la vista de dominio).

## 4 · Ejecución — delegar, no construir scheduler propio

**Disparar ≠ observar** (ortogonales). La ejecución se **delega** al scheduler nativo del motor (p. ej.
los pipelines de Fabric, gratis). **Mira es la fuente de verdad de la cadencia** y la **empuja** al
schedule del motor por API — one-way, idempotente.

**Reconciliador (control loop):** el estado *deseado* (cadencia derivada en Mira) converge al *real* (el
schedule del motor) con **debounce** + reconcile periódico. El churn de demandas se amortigua antes de
tocar el motor (la cadencia es un **mín** sobre un set **discreto** clavado a la oferta → cambia rara
vez), así que reconfigurar es barato. **Tener scheduler propio no se justifica:** mudaría el mismo churn
y agregaría toda la fiabilidad de ejecución que el motor ya hace. Tres capas: **ejecución** (motor) ·
**decisión de cadencia** (Mira, agnóstica) · **disparo** (schedule del motor, o Mira llamando *run-now*).

## 5 · Observabilidad de ingestión (mínimo no-negociable)

El **resultado de la ejecución vive en el motor** pase lo que pase → Mira **lo lee** (historial de
corridas vía API del motor; en Fabric, *job instances / run history*), guarda una **proyección** (para
la UI + para no re-notificar) y **alerta** ante fallo. Detecta **dos** clases de problema —más completo
que el motor solo, que no conoce la demanda de negocio:

1. **Corrida fallida** → estado `Failed` del historial.
2. **Corrida que faltó / tarde** → *antigüedad de la última corrida exitosa* > *cadencia requerida*.

Por eso delegar el disparo y quedarse con la observabilidad da un panorama **más** completo que un
scheduler propio.

## 6 · Lazo con la publicación de data maestra

La **publicación** de una data maestra (proyección `__replica`, ver
[`data-maestra-y-publicacion.md`](data-maestra-y-publicacion.md)) es, a efectos de frescura, **una fuente
más**: su **oferta** = la cadencia de publicación. Un PI que consume `md_<entidad>__replica` tiene esa
oferta como techo de su demanda. **Publish-on-write** (publicar al editar en Administración) lleva esa
oferta al límite (inmediato) para data maestra. La misma maquinaria gobierna dato operacional y data
maestra.

## 7 · Para agentes — el contrato

1. **Oferta ≠ demanda.** Nunca los confundas ni los unifiques. Oferta = de la fuente/publicación;
   demanda = del PI.
2. **Respeta el techo.** Ninguna demanda puede ser más fina que `máx(oferta)` de los insumos del PI.
3. **Deriva, no declares.** Insumos del PI = del spec + registro tabla→fuente. Cadencia requerida =
   `mín(demanda)` piso `oferta`.
4. **Delega la ejecución.** No construyas scheduler; empuja la cadencia al scheduler del motor
   (reconciliador idempotente). Observa leyendo el run-history del motor.
5. **Alerta sobre fallidas Y faltantes.** "No falló" no es "corrió a tiempo".

## 8 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| Matemática oferta/demanda (techo, cadencia requerida, derivación del mapa) | ✅ `freshness.ts` (unit-tested) |
| Registro de fuentes (oferta, tabla→fuente, proceso→tablas) | ✅ `GovernanceStore` |
| Validación de techo en la edición de demanda | ✅ |
| Mapa de fuentes en Administración | ✅ |
| Observabilidad — **lógica** (clasificar fallidas/faltantes) | ✅ `ingestion-observability.ts` (unit-tested) |
| Observabilidad — cliente del motor (leer run-history Fabric) + vista por entidad | ✅ `fabric-engine.ts` + Frescura por dominio (`admin.ts`) |
| Observabilidad — **proyección local** (corridas + schedule observados) | ✅ `ingestion_run` / `ingestion_process_state` en `GovernanceStore`; la vista lee la proyección y el motor nunca entra al request path — con el motor caído se sirve lo último conocido, marcado con su edad |
| **Lazo de frescura** (observar → alertar → reconciliar) | ✅ `server/freshness-loop.ts`, cada `VERGIS_FRESHNESS_POLL_MS` (default 5 min; `0` lo apaga). Las alertas Slack se gatean con `VERGIS_FRESHNESS_SLACK_WEBHOOK`; la observación y el reconcile corren igual |
| Observabilidad — **alerta autónoma** (push a Slack ante fallida/faltante) | ✅ fase 2 del lazo; dedup por transición (`freshnessAlerts`/`diffAlertState`), estado persistido en `platform_setting`. Con el motor caído clasifica sobre lo proyectado: un motor sin respuesta no es un proceso atrasado |
| Reconciliador — **lógica** (deseado→real, plan set/noop) | ✅ `ingestion-observability.ts` (unit-tested) |
| Reconciliador — push del schedule al motor (API) | ✅ `fabric-engine.ts` (`createFabricScheduler`) + «aplicar cadencia» (`admin.ts`) |
| Reconciliador — **periódico con debounce** | ✅ fase 3 del lazo (`VERGIS_RECONCILE_AUTO=off` la apaga). No re-empuja el mismo deseado al mismo proceso dentro de `VERGIS_RECONCILE_DEBOUNCE_MS` (default 6 h) — el motor redondea el schedule a minutos y un deseado no múltiplo de 60 no converge nunca; un deseado que cambia se empuja de inmediato. Tras cada push se re-observa el schedule y se registra lo leído |
| Engine_ref del proceso (proceso↔item Fabric) + dominio de la fuente (tag) | ✅ `governance-store.ts` (migración idempotente) |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/038`.
