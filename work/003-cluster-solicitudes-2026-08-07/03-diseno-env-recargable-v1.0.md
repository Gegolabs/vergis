# 003·C · Diseño — aislar el reinicio del cambio de configuración — issue #138 pieza 2

**Estado: diseño para revisión de César. No se implementa en esta sesión** — cambia el contrato de despliegue de las instancias (qué va en env vs en archivo) y eso lo decide el humano.

## El replanteo que ordena el problema

En Docker **el env de un contenedor es inmutable**: cambiar una variable siempre implica recrear el proceso. Por tanto «que el cambio de env no exija reiniciar» no tiene solución literal — la solución real es **mover de env a archivo vigilado todo lo que merezca cambiar en caliente**, y que lo irreductiblemente de arranque quede declarado (eso último ya lo publica el contrato de #139, frente A).

## Inventario verificado (`server/serve-rls.ts:1622-1644`, `server/instance-config.ts`)

**Con vía recargable hoy** (watch + validate-before-swap): specs (`VERGIS_SPECS_DIR`/`VERGIS_SPECS`) · políticas (`VERGIS_POLICIES`) · conexiones (`VERGIS_CONNECTIONS` si es archivo) · dominios (`VERGIS_DOMAINS`) · slots de ingesta (`VERGIS_INTAKE`).

**Contenido en archivo pero SIN watch** (hoy exige restart; se carga una vez en `loadInstanceConfig`):

| Env | Contenido | ¿Recargable? | Riesgo/semántica |
|---|---|---|---|
| `VERGIS_NOTIFY` | destinos de aviso | **Sí, fácil** — swap de lista; el lazo de frescura los lee por tick | El issue lo nombra explícitamente («destinos de aviso») |
| `VERGIS_PI_OWNERS` | dueño por PI | **Sí, fácil** — swap de mapa | La siembra de rol owner en el store: decidir si re-siembra o solo aplica a PIs nuevos |
| `VERGIS_SOURCES` | registro de fuentes | **Sí, medio** — ya existe la semántica de merge con gestión in-app (`managed_at`/tombstones, #101/#105): la recarga re-corre esa proyección | Reusar el camino existente, no inventar otro |
| `VERGIS_GROUPS` | grupos semilla | **Con cuidado** — la siembra convive con la membresía gestionada in-app | Decidir la precedencia semilla-vs-gestionado antes de recargar |
| `VERGIS_IDENTITY_MAP` | mapeo de identidad | **Con cuidado** — afecta autorización viva | Validate-before-swap estricto; fail-closed |
| `VERGIS_MASTER_DATA` | entidades de data maestra | **Probablemente NO** — arrastra esquema/DDL y superficies de admin cableadas | Declararlo de arranque en el contrato, con motivo |
| `VERGIS_DATASETS` (CH) | datasets del nodo | **NO por ahora** — `BOUND`/inyecciones del canal se fijan al arranque (work/045) | Ya es caveat del contrato |

**Escalares hoy en env que merecerían archivo vigilado** (propuesta: un `VERGIS_TUNABLES` opcional, YAML chico, watch + swap): `VERGIS_INDEX_TITLE` · `VERGIS_DATA_CACHE_TTL_MS` · `VERGIS_REFRESH_MS` (con re-arme del timer) · `VERGIS_INTERACTIVE_MAX_ROWS` · flags por PI que aparezcan. Env queda como fallback si el archivo no lo define (precedencia: archivo > env — **a confirmar por César**).

**Irreductiblemente de arranque** (y así lo declarará el contrato): `VERGIS_ENGINE` · `PORT`/`HOST` · `VERGIS_GATE_SECRET`/`VERGIS_GATE_CLAIMS` · `VERGIS_CSRF_SECRET` · las RUTAS mismas de todos los archivos · `MIRANDA_*` (API key y wiring) · `VERGIS_PDF_SERVICE_URL` · `VERGIS_OUT`.

## Propuesta de implementación (cuando se apruebe)

1. **Fase 1 (bajo riesgo, alto valor):** watch sobre `VERGIS_NOTIFY` + `VERGIS_PI_OWNERS` + `VERGIS_SOURCES` dentro de `reloadDomainGovernance` (mismo patrón `reloadLiveList`/validate-before-swap por archivo). El contrato (#139) los reclasifica solo con registrar el watch — cero mantenimiento.
2. **Fase 2:** `VERGIS_TUNABLES` (escalares) con precedencia declarada.
3. **Fase 3 (si duele):** `VERGIS_GROUPS`/`VERGIS_IDENTITY_MAP` con su semántica de convivencia resuelta por escrito antes de codificar.

## Decisiones que le tocan a César

- ¿Precedencia archivo > env en tunables, o archivo-only con deprecación del env?
- ¿La recarga de `VERGIS_PI_OWNERS`/`VERGIS_GROUPS` re-siembra (pisa lo gestionado in-app) o solo aplica a entidades nuevas? (La doctrina de `managed_at` de #101 sugiere: lo gestionado in-app gana.)
- ¿Fase 1 sola ya satisface la pieza 2 del issue, o se quiere el paquete completo?

---
• 🤖 Claude (Fable) · diseño del frente C · cluster 003 · pendiente de revisión
