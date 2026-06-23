# Data Maestra y Publicación — capacidad de Mira

> **Documentación canónica del Producto.** Define *cómo funciona* la gestión de data maestra en
> Mira/Vergis — para humanos que la operan y para **agentes** que usan este Botlet. Es comportamiento
> **genérico** del Producto, independiente de cualquier instancia (cliente). Las decisiones de
> arquitectura que la sustentan están en la sección §8.

## 1 · Qué es

**Data maestra** = catálogos de referencia **sin fuente externa**, mantenidos a mano: listas
intercompañía, mapeos, catálogos de entidades, overrides. No vienen de un sistema operacional; los
**autora una persona** en el ambiente de Administración de Mira. Ejemplos: "empresas relacionadas",
"catálogo de empresas del grupo".

El problema que resuelve: sin esta capacidad, esos catálogos terminan como CSVs horneados en pipelines
que nadie posee, drifteando en silencio. Mira los eleva a **dato gobernado de primera clase**: una
sola autoría editable, auditada, distribuida determinísticamente a quien la consume.

## 2 · Tres roles de una entidad maestra

| Rol | Qué es | Dónde vive | Quién escribe | Quién lee |
|-----|--------|------------|---------------|-----------|
| **Autoría** | el *golden record* editable (fuente única) | el **store de Mira** (un warehouse/lakehouse propio de la plataforma) | el **Admin**, in-app | el mecanismo de publicación |
| **Proyección** | copia **read-only** gobernada | **cada store consumidor** (donde un PI lee) | **solo** el mecanismo de replicación | los PIs, por join local |
| **Consumo** | el join del PI contra la proyección | en la query del PI | — | el consumidor final (con su RLS) |

**Invariante:** la autoría es **única**. Las proyecciones son **derivadas**; nunca se editan a mano
(si alguien lo hace, el próximo publish lo pisa). Editar = solo en Administración, solo la autoría.

## 3 · Publicación universal (no shortcut de Fabric)

La proyección se distribuye **publicando una copia gobernada read-only** en el store de cada
consumidor. Es el idioma del medallón: igual que un Silver materializa su upstream, el consumidor
recibe la maestra como **una tabla gobernada más**.

**Por qué publicación y no un join en vivo cross-store (p. ej. shortcut OneLake + cross-db de Fabric):**
porque ese truco es **específico de Fabric** y no generaliza. Un consumidor en ClickHouse (motor B),
DuckDB o cualquier otro motor **no puede** federar contra un lakehouse Fabric. El **único** mecanismo
uniforme para *cualquier* consumidor, presente o futuro, es publicar una proyección en su propio store.
La publicación, además, mantiene el spec del PI **portable** (referencia un nombre local de 2 partes,
idéntico en todo motor) y el write-path **limpio** (el Admin siempre escribe la autoría en Mira).

> El join en vivo (federación) queda como **optimización opcional** donde el consumidor es un lakehouse
> Fabric co-locable y una entidad concreta exige frescura en vivo — **nunca como cimiento**.

## 4 · Convención de nombres (estándar de Producto)

| Rol | Nombre | Ejemplo |
|-----|--------|---------|
| **Autoría** | `md_<entidad>` | `md_empresas_relacionadas` |
| **Proyección** | `md_<entidad>__replica` | `md_empresas_relacionadas__replica` |

- El sufijo **`__replica`** (doble guión bajo + `replica`, sin tilde — token bilingüe, válido como
  identificador SQL) marca la **proveniencia**: es una réplica RO de un primario autoritativo. Dice
  *de dónde viene* **e** implica *no la escribas*.
- **Refuerzo por permisos** (la cerradura real, el nombre es la señal): el SP **publicador** tiene
  `INSERT/UPDATE/DELETE` sobre `*__replica`; los SP **consumidores**, solo `SELECT`.
- **Descripción** de la tabla con puntero a la fuente: `source = mira:md_<entidad>`.
- **Los PIs referencian siempre `md_<entidad>__replica`** (2 partes, local) → spec portable entre motores.

## 5 · Frescura — gobernada por oferta/demanda

Una proyección tiene **drift** (queda vieja entre publicaciones). Eso **no es un defecto sin gobierno**:
es exactamente lo que el modelo **oferta/demanda** administra (ver `freshness.ts`):

- **Oferta** de la entidad maestra = su **cadencia de publicación**.
- **Demanda** de cada PI que la consume = su frescura requerida; debe ser **≥** la oferta.
- **Publish-on-write**: ante una edición en Administración, el runtime escribe la autoría **y** dispara
  la publicación a los consumidores afectados → inmediatez sin federación. Para data maestra
  (slow-changing) esto basta y sobra.

## 6 · Gobierno — composición con Custos (RLS)

La proyección es un dato servido como cualquier otro: el **gate fail-closed** exige que tenga su
artefacto de autorización (SECURITY POLICY nativa donde el motor lo soporte, o equivalente). Para data
maestra de referencia, el patrón normal es **allow-all gobernado** (`grant: all`): pública para la
instancia, pero **la RLS del PI sigue filtrando filas del fact** — la proyección no abre datos, solo
provee el catálogo del join. La autorización de *artefacto* (quién abre el PI) y la *RLS de filas*
(Custos) componen como siempre; la data maestra no las altera.

## 7 · Para agentes — el contrato

Un agente que opera o razona sobre este Botlet debe respetar estas **invariantes**:

1. **Autoría única.** El dato maestro se edita **solo** en Administración (la autoría en el store de
   Mira). Nunca escribas una entidad maestra en otro lado.
2. **`*__replica` es intocable a mano.** Cualquier `md_<entidad>__replica` es una proyección
   read-only. Si necesita cambiar, se cambia la **autoría** y se publica — jamás la réplica directa.
3. **Los PIs leen la réplica.** Un spec consume `md_<entidad>__replica` por join local. Si reescribes
   un spec, referencia la réplica, no la autoría ni un nombre cross-store.
4. **Publicar, no federar.** Para exponer una maestra a un consumidor nuevo, **publicas una proyección**
   en su store (cualquier motor). No asumas shortcuts/cross-db: son Fabric-only y no generalizan.
5. **Frescura = oferta/demanda.** La cadencia de publicación es la *oferta*; ningún PI puede declarar
   una *demanda* más fina que la oferta de la maestra que consume.
6. **Verifica la topología antes de actuar.** Dónde lee cada PI (qué store/motor) es dato de
   instancia, no asumible. Confírmalo contra la config real antes de publicar o reconvertir un spec.

## 8 · Decisión de arquitectura (resumen)

- **Estado de gobierno** (admins, ACL de PI, oferta/demanda, **autoría de data maestra**) vive en el
  store del runtime, agnóstico del motor — no en el data engine ni en los specs (modelo de tres estados).
- **Publicación universal** elegida sobre **federación en vivo** (shortcut/cross-db): la federación es
  Fabric-específica y obliga a mantener *dos* mecanismos (federación + publicación) porque los
  consumidores no-Fabric necesitan publicación igual. La publicación, **necesaria de todos modos**, es
  el cimiento; la federación es opt-in. El "join en vivo, cero copia" es un ideal alcanzable solo para
  consumidores co-locables; lo que de verdad importa del modelo *pull* —autoría única + derivación
  determinística— lo cumple la publicación al pie.

## 9 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| Store de autoría + CRUD in-app (Administración) | ✅ construido (`MasterDataStore`, `server/admin.ts`) |
| Contrato declarativo de entidad | ✅ (`master-data.ts`) |
| Modelo oferta/demanda + derivación de cadencia | ✅ (`freshness.ts`) |
| **Mecanismo de publicación** (proyección `__replica` a consumidores) | 🔧 diseñado, **por construir** |
| **Publish-on-write** | 🔧 diseñado, por construir |
| Convención `__replica` + grants RO | 🔧 estándar fijado, por aplicar en el publicador |

> Instancia de referencia (beta): Grupo Hijuelas — ver `arbol-lab/work/037-039`. GH es **contra qué se
> prueba**, no el molde: esta capacidad es genérica.
