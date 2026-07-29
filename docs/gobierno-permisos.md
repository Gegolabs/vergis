# Gobierno, Estado y Permisos — cómo funciona Mira

> **Documentación canónica del Producto.** Define el modelo de gobierno de Mira/Vergis — para humanos
> que lo operan y para **agentes** que usan este Botlet. Comportamiento **genérico**, independiente de
> instancia. Complementa [`data-maestra-y-publicacion.md`](data-maestra-y-publicacion.md) y
> [`frescura-oferta-demanda.md`](frescura-oferta-demanda.md).

## 1 · Modelo de tres estados

Todo lo que el sistema persiste se ordena por **naturaleza** en tres clases, y cada una vive donde su
naturaleza manda:

| Estado | Qué es | Dónde vive | Quién lo lee |
|--------|--------|------------|--------------|
| **Datos + data maestra** | hechos, dimensiones, catálogos | el **data engine** (Fabric, ClickHouse, …) | el **motor de query** del PI |
| **Definición del PI** (spec) | el "qué": estructura, queries, vistas | **archivos de instancia**, versionados, **authz-blind** | el renderer (Mira) |
| **Estado de gobierno** | el "quién/cuándo/cuánto": admins, ACL/ownership de PI, oferta/demanda, **autoría de data maestra**, auditoría | **store del runtime** (`GovernanceStore`), agnóstico del motor | el Botler/PEP, en cada request |

**Por qué el gobierno NO vive en el data engine ni en los specs:** (a) ningún PI lo cruza por join — lo
lee el runtime para autorizar; (b) la ACL se chequea **por request** → necesita un store OLTP de baja
latencia, no un motor analítico; (c) **portabilidad**: atarlo a un motor acoplaría la autorización al
data engine, lo contrario a la agnosticidad de motor; (d) radio de explosión: el dato más sensible,
fuera del warehouse que tocan muchos consumidores.

## 2 · El `GovernanceStore`

Un store **único** del estado de gobierno, **detrás de un seam** (interfaz), backend **SQLite en un
volumen persistente** (Postgres es un swap de una impl. sin tocar el resto). Consolida en un db:
admins, grupos de Mira, ACL/ownership de PI, demanda por PI, registro de fuentes y observabilidad de
ingestión.

Se nutre de **dos fuentes**: **semilla declarativa** en config de instancia (env/yaml versionado:
`VERGIS_ADMIN_SEED`, grupos, fuentes) + **estado vivo mutable** editado in-app. Toda mutación se
**audita** en el log append-only hash-encadenado.

> **Persistencia:** `VERGIS_OUT` debe apuntar a un **volumen persistente**; si no, el estado vivo
> (admins agregados, ACLs, auditoría) vuelve a la semilla al reiniciar el contenedor.

## 3 · Dos capas de autorización, ortogonales

El sistema exige **AND** de dos autorizaciones independientes:

1. **Acceso al artefacto** (este doc): ¿puede esta identidad **abrir/configurar** este PI? — por rol +
   visibilidad.
2. **RLS de datos** (Custos): dentro del PI, ¿qué **filas** ve? — data-anchored, push-down nativo.

> **Regla bedrock — sin bypass nunca.** Ser dueño/colaborador da acceso **al artefacto y su config**,
> **jamás eleva** el acceso a datos por encima del grant propio. "Config compartida full; datos siempre
> por RLS." Un PI **público** lo abre cualquiera autenticado, pero **la RLS sigue filtrando filas** —
> público es del artefacto, no del dato.

## 4 · Permisos de PI

### Roles (anidados)

**Visor ⊂ Colaborador ⊂ Dueño.**

| Acción | Visor | Colaborador | Dueño |
|--------|:--:|:--:|:--:|
| Abrir el PI y ver salidas (datos por **su propia RLS**) | ✓ | ✓ | ✓ |
| Ver la config completa (incl. lista de compartido) | ✓ | ✓ | ✓ |
| Editar contenido / **la demanda** de frescura | – | ✓ | ✓ |
| Configurar **visibilidad** (público/privado) | – | – | ✓ |
| Modificar la **lista de compartido** | – | – | ✓ |
| **Otorgar/transferir ownership** | – | – | ✓ |

- **Colaborador = mismos privilegios de gestión que el dueño**, salvo las tres palancas de gobierno.
  (En la práctica, los colaboradores son quienes "hacen la pega" del PI.)
- **Multi-dueño:** el creador es dueño y no lo pierde al nombrar a otro. **Anti-lockout:** no se puede
  quitar al último dueño.

### Visibilidad

- **Privado:** solo dueño + principals de la lista de compartido **abren** el PI.
- **Público:** cualquiera autenticado lo abre — **pero la RLS sigue filtrando filas** (no es bypass).

### Grupos — gestionados por Mira, NO grupos AAD

La **identidad/autenticación** (quién eres, tu correo) viene del **gate** (oauth2-proxy/AAD). Pero los
**grupos y el compartir** se gestionan **in-app, en Mira** — *no* se delega al IdP. Racional: nadie va a
pedirle al **CISO** que habilite el reporte X a los usuarios K y Q; lo gestiona el dueño del PI. Un PI
se comparte con **grupos de Mira** (listas de correos, sembradas de config, editables en Administración)
y/o correos individuales.

### Identidad de desarrollo — `VERGIS_DEV_IDENTITY` (solo dev, fail-safe)

En un despliegue de **desarrollo sin gate** (sin oauth2-proxy delante) ninguna request trae los headers
`x-forwarded-*`, así que la identidad es vacía y toda superficie con scope responde 403 — imposible de
manejar desde el navegador local. `VERGIS_DEV_IDENTITY` inyecta una identidad fija para **manejar Mira y
los PIs desde el browser** sin forjar headers por curl. Formato: `email` o `email:grupo1,grupo2` (los
grupos pueblan el claim `groups`, como lo haría `x-forwarded-groups` en producción).

**Es imposible de activar donde hay gate real** — el requisito de seguridad #1:

| Condición | Comportamiento |
|--|--|
| Env **ausente** | Idéntico a hoy: sin identidad de dev, 403 preservado aguas abajo. |
| Env seteado **∧ SIN** gate real | Se inyecta a las requests **sin** header de gate. Una request **con** header de gate → el header MANDA (permite probar 403/otras identidades por curl). Log de arranque: `⚠ DEV IDENTITY ACTIVA (<email>) — NO USAR EN PRODUCCIÓN`. |
| Env seteado **∧ CON** gate real | **Se ignora** (nunca inyecta). Señal de gate real: `VERGIS_GATE_SECRET` presente (el secreto que comparte oauth2-proxy). Log: `VERGIS_DEV_IDENTITY ignorado: hay gate real`. |

La decisión de activación es pura y testeada (`decideDevIdentity` en `server/config.ts`); la presencia
de `VERGIS_GATE_SECRET` gana **siempre**. Como defensa en profundidad, con `VERGIS_GATE_SECRET` definido
el gate A10 además rechaza (403) toda request sin `x-gate-token` antes de resolver identidad alguna.

### Bandera `--fresh` — store de gobierno limpio (solo el arnés de dev)

El store SQLite de gobierno persiste entre corridas y en desarrollo arrastra sesiones de prueba de
Miranda. `server/serve-rls.ts` acepta `--fresh`: borra el store (`VERGIS_GOVERNANCE_DB`, o
`$VERGIS_OUT/governance.sqlite`) antes de abrirlo, de modo que el arranque lo recrea vacío. **Sin la
bandera, el comportamiento es el de hoy** (el store se conserva — `--keep` implícito, aceptado y sin
efecto).

**Borrar un store de producción es imposible por construcción**: el borrado exige exactamente la misma
señal de «esto es dev» que gobierna `VERGIS_DEV_IDENTITY`.

| Condición | Comportamiento |
|--|--|
| Sin `--fresh` | El store no se toca. |
| `--fresh` ∧ **CON** gate real (`VERGIS_GATE_SECRET`) | **Se rehúsa.** Log: `--fresh IGNORADO: hay gate real…`. |
| `--fresh` ∧ **sin** identidad de dev activa (`VERGIS_DEV_IDENTITY`) | **Se rehúsa.** Log: `--fresh IGNORADO: no hay identidad de dev activa…`. |
| `--fresh` ∧ dev-identity activa ∧ sin gate real | Borra el store y lo recrea. Log: `⚠ --fresh (DEV): store de gobierno BORRADO…`. |

La decisión es pura y testeada (`decideFreshStore` en `server/config.ts`). Ambas negativas son
fail-safe: ante duda, se conserva el store.

### Bootstrap del ownership

El **dueño inicial** de un PI se siembra de config de instancia (hoy: el dueño del ticket de gestión
externo; a futuro, la creación nativa en Mira hace dueño al creador). El dueño **no va en el spec** (el
spec es authz-blind). Un PI sin dueño-semilla queda **default-deny** (solo admins lo gestionan hasta
asignarlo) — nunca "huérfano abierto".

## 5 · Rol admin de plataforma

Distinto del ownership de un PI: el **admin** opera el ambiente de Administración (data maestra, grupos,
fuentes). Se siembra de `VERGIS_ADMIN_SEED` (rompe el bootstrap) y se gestiona in-app (sección Usuarios y
Roles). Es autz de **acción**, no de fila. El admin es **override** de gestión sobre cualquier PI (para
poder asignar dueños), pero su acceso a **datos** sigue gobernado por RLS.

## 6 · Aplicación de la RLS (cómo se gobierna una tabla servida)

El **gate fail-closed**: un PI **no se sirve** a menos que **cada tabla que toca** tenga su artefacto de
autorización nativo. En push-down (Fabric) eso es una **`SECURITY POLICY`** habilitada; sin artefacto,
una tabla devolvería todas sus filas → fuga. "Sin artefacto" = bug, no "público".

- **Tabla gobernada por RLS:** `SECURITY POLICY` con predicado-filtro por la clave de gobierno
  (data-anchored).
- **Tabla pública gobernada** (`grant: all`): artefacto **allow-all** — función `RETURNS TABLE ... SELECT
  1` sin `WHERE`, `STATE=ON`. La fila siempre pasa, pero la tabla **queda declarada** (el gate la ve).
  Patrón en `deploy/fabric-pushdown/secpol-*.sql`, aplicado por `scripts/apply-*-rls.mjs`.

> **El gate verifica `sys.security_policies` por conexión (`database_ref`).** Una tabla servida por un PI
> debe tener su policy **en el endpoint que la conexión consulta**. Si el PI lee de varias DBs, cada una
> necesita su artefacto y, si es otra DB, su propia conexión registrada. (Verificar la topología real —
> qué store/motor lee cada PI — antes de tocar; es dato de instancia, no asumible.)

## 7 · Para agentes — el contrato

1. **Tres estados, tres lugares.** Datos→engine · spec→archivos authz-blind · gobierno→`GovernanceStore`.
   No metas gobierno en el spec ni en el data engine.
2. **AND de dos autorizaciones, sin bypass.** Acceso-al-artefacto Y RLS-de-filas. Jamás abras una vía que
   eleve datos por colaboración/ownership. "Público" no abre datos: la RLS sigue.
3. **Grupos en Mira, no en AAD.** Para compartir, usa grupos de Mira / correos; no asumas que la
   membresía vive en el IdP.
4. **Default-deny.** PI sin gobierno declarado → no se sirve (solo admins). Tabla sin policy → no se
   sirve. La ausencia de autorización **es** falta de autorización.
5. **Verifica topología antes de desplegar.** Hoy un PI puede leer un lakehouse o un **warehouse**, en un
   workspace propio; el shortcut/cross-db es Fabric-only. Confirma contra la config real (`VERGIS_CONNECTIONS`)
   dónde lee cada PI antes de aplicar policies o reconvertir specs.

## 8 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| `GovernanceStore` (admins + grupos + ACL/ownership + demanda + fuentes) | ✅ construido |
| `pi-authz` (roles, `effectiveRole` componiendo visibilidad+grants) | ✅ |
| Gate de artefacto en el server (flag `VERGIS_PI_ACL`, bootstrap lazy) | ✅ (lógica unit-tested) |
| UI Administración (data maestra, roles, grupos) + config por-PI | ✅ |
| Aplicación de RLS allow-all (secpol + apply-*-rls) | ✅ patrón vivo |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/038`. Diseño detallado allí; esta es
> la spec canónica genérica.
