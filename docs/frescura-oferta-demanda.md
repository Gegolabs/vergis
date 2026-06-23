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

## 3 · Cadencia requerida de un proceso de ingestión

> `cadencia_requerida(proceso) = mín(demanda de los PIs que dependen de sus tablas de salida)`, **con
> piso en la oferta** de su fuente (no se corre más seguido de lo que la fuente se actualiza).

El **mapa de fuentes** (área de Administración) muestra, por proceso: oferta · cadencia requerida
derivada · PIs dependientes · marca de **insatisfacible** (alguna demanda exige más fresco que la
oferta). Es el análisis de brecha que hace explícito "cada cuánto debe correr cada proceso" — antes
implícito y sin dueño.

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
| **Observabilidad** (leer run-history del motor + log + alertas) | 🔧 diseñado, por construir |
| **Reconciliador** (empujar schedule al motor por API) | 🔧 diseñado, por construir |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/038`.
