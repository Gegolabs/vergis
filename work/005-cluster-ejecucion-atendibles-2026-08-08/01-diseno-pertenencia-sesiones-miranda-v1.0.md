# 005·01 · Diseño — pertenencia de sesiones de Miranda (guard dueño-o-admin en las 5 rutas)

**Horizonte: implementable ya — es la única brecha de seguridad viva en `main`.**
**Origen:** hallazgo de PENDINGS 2026-08-07 (2 rutas), **ampliado por re-revisión Fable 2026-08-08 a 5 rutas** (ver ficha corregida en `PENDINGS.md`). Insumos: diseño `004/06` (D3, solo preview) y `004/02` (invariante de autorización de tools).

## ¿Qué se construye?

Que toda ruta de Miranda que recibe un `sessionId` verifique que quien llega es **el dueño de la sesión o un admin** antes de mostrar o actuar. Hoy el único gate es el scope global `miranda` (`server/miranda.ts:163-166`): cualquier identidad con scope puede leer, escribir, avanzar y **publicar** sesiones ajenas conociendo el id.

## Estado actual verificado (HEAD `be55600`, anclas re-medidas 2026-08-08)

Las cinco rutas sin check de pertenencia, con su daño:

| Ruta | Handler | Qué permite a un no-dueño con scope |
|---|---|---|
| `POST /miranda/api/s/:id/publish` | `handlePublish` (`miranda.ts:221,267`) | **Publicar el draft ajeno como PI servido.** `publishSpec` no verifica autor (grep de `createdBy\|owner\|autor` sobre `packages/miranda/src/publish.ts`: vacío); solo gates de estado |
| `GET /miranda/s/:id` | `sessionPage` (`miranda.ts:320` — **ignora su parámetro `_email`**) | Leer transcript completo, intent, QC y draft |
| `POST /miranda/api/s/:id/message` | `handleMessage` (`miranda.ts:236`) | Postear turnos a la sesión ajena (gasta su presupuesto de tokens) |
| `POST /miranda/api/s/:id/validate-intent` | inline (`miranda.ts:203-215`) | Avanzar `borrador→validado` de la sesión ajena |
| `GET /miranda/preview/:id` | `handlePreview` (`miranda.ts:286`) | Ver el draft ajeno (renderiza con la RLS del requester — el dato no fuga; la estructura sí) |

Agravantes y datos de contrato:

- **La lista SÍ filtra por dueño** — `listPage` llama `listMirandaSessions(email)` (`miranda.ts:332`), que filtra `WHERE created_by = ?` (`governance-store.ts:1069-1073`). La UI se ve privada; la URL directa la salta. Ilusión de privacidad, no privacidad.
- **`createdBy` ya se persiste y viene normalizado**: `createSession` guarda `normEmail(createdBy) || null` (`governance-store.ts`, INSERT de `miranda_session`); la ruta `/miranda/api/new` siempre lo pasa (`miranda.ts:183`). El `email` del request ya llega en minúsculas (`miranda.ts:162`: `.toLowerCase()`).
- **`MirandaSession.createdBy` es opcional** (`governance-store.ts:188`) — pueden existir filas con `created_by NULL` (sesiones pre-persistencia del campo, o sembradas por otra vía).
- **`MirandaServerDeps` NO expone `isAdmin`** (`miranda.ts:37-65`): solo `hasScope` = admin ∨ miembro del grupo de scope (`serve-rls.ts:1484`) — **no distingue** admin de miembro, así que no sirve para el guard. El objeto `govForMiranda` con `.isAdmin` ya existe en el cableado (`serve-rls.ts:1484`).
- **Arnés de tests listo para extender**: `tests/miranda-handler.test.ts` construye el handler con `build(over: Partial<MirandaServerDeps>)` — `identityOf` y cualquier dep son overrideables por caso; `mkReq`/`mkRes` fabrican requests. La suite existente (scope gate, ciclo básico, validate-intent, preview, publish) es la regresión: debe seguir verde sin editar sus casos.
- **Invariante del diseño `004/02` (D3.3), intocable**: la autorización de tools se ata al **email del requester del mensaje** (`buildToolRegistry(toolContext(sessionId, email))`, `miranda.ts:240`), no al dueño de la sesión — evita el confused-deputy (un no-admin corriendo tools con la autoridad del dueño admin). Este guard **gatea quién entra; no reasigna quién autoriza**.

## Decisiones selladas

### D1 — Un guard central `dueño-o-admin`, aplicado en las 5 rutas

Un solo helper dentro de `createMiranda` resuelve sesión + pertenencia; cada ruta lo llama antes de tocar nada:

- Sesión inexistente → **404** (conducta actual de `sessionPage`/`handlePreview`, se conserva y se extiende a las rutas que hoy no la tienen).
- Sesión existente y requester ≠ dueño y no-admin → **403** con página de error del estilo existente (`pg(...)`), mensaje: «Esta sesión pertenece a otra persona.» Sin filtrar el título ni el dueño.
- Dueño o admin → pasa.

**Racional del 403 (no 404):** los ids son UUIDv4 (`randomUUID`, `miranda.ts:182`) — la enumeración es impracticable, así que ocultar la existencia no compra seguridad real y sí compra confusión de diagnóstico. El error honesto es el patrón del producto (`403` del scope gate, `409` de publish).

### D2 — Sesión sin `createdBy` = solo-admin (fail-closed)

Una fila con `created_by NULL` no tiene dueño demostrable: la ve y la opera **solo un admin**. La alternativa descartada — tratarla como pública para el scope — restauraría exactamente el hueco que este diseño cierra, para el subconjunto de filas más viejo.

### D3 — `isAdmin` entra como dep nuevo de `MirandaServerDeps`

```ts
/** ¿La identidad es admin de la plataforma? (para el guard de pertenencia — el admin ve/opera toda sesión). */
isAdmin(email: string | undefined): Promise<boolean>
```

Cableado en `serve-rls.ts` junto a `hasScope` (misma fuente): `isAdmin: async (email) => govForMiranda.isAdmin(email)`. **No** se deriva de `hasScope` (no distingue) ni se mete `isAdmin` en `MirandaStore` (la interfaz del store es de persistencia, no de autorización; `AdminStore` ya la tiene aparte).

### D4 — El guard NO toca `publishSpec` ni la autorización de tools

- El gate de publish va **en el handler** (`handlePublish`), no en `packages/miranda/src/publish.ts`: la identidad vive en la frontera HTTP; `publishSpec` conserva su contrato puro de gates de estado (autochequeado + QC sin B/M). Meterle identidad engordaría el contrato del paquete para un check que solo la frontera puede responder.
- La construcción de tools queda **idéntica** (`buildToolRegistry(toolContext(sessionId, email))` con el email del requester) — invariante de `004/02`. Con el guard, el requester que llega a tools es dueño-o-admin; la autoridad sigue siendo la suya propia.

### D5 — Comparación de dueño normalizada en ambos lados

`normEmail(session.createdBy) === normEmail(email)` — semánticamente; en la práctica ambos ya llegan normalizados (verificado arriba), y el guard normaliza igual por si alguna vía futura no lo hace. Barato y elimina la clase de bug entera.

### D6 — Sin auditoría nueva en este frente (no-meta declarada)

Los 403 son visibles en logs HTTP y el frente se mantiene mínimo. La auditoría de accesos admin a sesiones ajenas y del render impersonado es territorio del frente F4 (`004/06` D4), que ya la diseña.

## Contratos

### El guard (dentro de `createMiranda`, junto a los handlers)

```ts
/** Resuelve la sesión y exige pertenencia (dueño o admin). Responde 404/403 él mismo y devuelve
 *  null si cortó; la ruta solo continúa con una sesión autorizada en la mano. */
async function requireSession(
  sessionId: string, email: string, res: ServerResponse,
): Promise<MirandaSession | null>
```

Orden interno: `getMirandaSession` → `null` ⇒ 404 · `createdBy` presente y `≠ email` (normalizados) ⇒ `await deps.isAdmin(email)` o 403 · `createdBy` ausente ⇒ solo admin (D2).

### Aplicación por ruta (las 5, tabla de cambios)

| Ruta | Cambio exacto |
|---|---|
| `GET /miranda/s/:id` | `sessionPage` deja de ignorar `_email`: `tryHandle` llama `requireSession` antes; `sessionPage` recibe la sesión ya resuelta (se le quita el fetch duplicado y el parámetro muerto) |
| `POST …/:id/message` | `requireSession` antes de `handleMessage`; con corte, **no** se persiste ningún mensaje |
| `POST …/:id/validate-intent` | `requireSession` reemplaza el `getMirandaSession` inline; con corte, el estado no cambia |
| `POST …/:id/publish` | `requireSession` antes de `handlePublish`; con corte, no se escribe spec ni cambia estado |
| `GET /miranda/preview/:id` | `requireSession` antes de `handlePreview` (la respuesta 404-sin-draft actual queda para el caso dueño-sin-draft) |

El CSRF queda **antes** del guard donde ya está (las POST leen el form primero — orden actual se conserva: form → csrf → guard).

## Plan de construcción (un solo hito)

**Territorio:** `server/miranda.ts` · `server/serve-rls.ts` (solo el objeto de deps del bloque Miranda, ~línea 1484: una línea nueva `isAdmin`) · `tests/miranda-ownership.test.ts` (**nuevo**; no se editan los tests existentes).

**Tareas:** dep `isAdmin` en interfaz y cableado → helper `requireSession` → aplicarlo en las 5 rutas → tests.

**Tests mínimos (los que refutarían el guard si estuviera mal — Norma 7).** Arnés: `build()` de `miranda-handler.test.ts` como plantilla (copiar el patrón al archivo nuevo, no importarlo), con dos identidades (`ana@x.com` dueña, `eva@x.com` con scope) y `isAdmin` overrideable:

1. **Las 5 rutas × no-dueño con scope ⇒ 403** y cero efectos: mensajes no persistidos, estado intacto, `writeSpec` jamás invocado (spy), preview no renderizado.
2. **Dueño ⇒ conducta actual** en las 5 (además la suite existente de `miranda-handler.test.ts` verde sin tocar = regresión).
3. **Admin no-dueño ⇒ 200** en las 5 (`isAdmin: async () => true`).
4. **Sesión con `createdBy` NULL** (sembrada directo por el store con `createdBy` omitido): no-admin ⇒ 403 aunque sea «suya» de facto; admin ⇒ 200 (D2).
5. **Sesión inexistente ⇒ 404** en las 5.
6. **Case-insensitive:** dueña `Ana@X.com` en el insert vs requester `ana@x.com` ⇒ pasa (D5).

**Hecho cuando** (sin pipes que enmascaren exit codes):

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx vitest run tests/miranda-ownership.test.ts
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run typecheck && npm test && npm run build
```

**Juez:** los gates de arriba + revisión del orquestador contra este documento.

## Reglas duras (intocables)

- `packages/miranda/src/publish.ts` — no se edita (D4).
- `packages/capabilities/src/governance-store.ts` — no se edita (todo lo necesario ya existe).
- La construcción de tools (`miranda.ts:240`) y el scope gate (`:163-166`) — no cambian de semántica.
- Los tests existentes — no se editan; si uno se pone rojo, **eso es un hallazgo que se reporta**, no se «arregla» el test.

## Riesgos y no-metas

- **Riesgo — sesiones legadas con `created_by NULL` quedan solo-admin:** puede sorprender a un usuario viejo. Aceptado: son el caso raro, el admin las rescata, y la alternativa restaura el hueco (D2). Se menciona en el cuerpo del PR.
- **No-meta — compartir sesiones** (co-autoría, transferencia de dueño): exige modelo propio; si una instancia lo pide, es otro diseño.
- **No-meta — auditar los accesos admin** (D6 → frente F4).
- **No-meta — rate-limit / anti-abuso del scope:** fuera del alcance; el guard cierra la autorización, no el abuso del autorizado.

---
• 🤖 Claude (Fable) · diseño del frente 005·01 pertenencia · cluster 005
