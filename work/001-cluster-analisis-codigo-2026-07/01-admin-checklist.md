# Checklist manual · admin.ts (frente admin/multipart)

> Materializado incrementalmente en archivo (el safeguard de ciber corta la salida por chat). Cada punto: qué verificar · dónde · fix. Severidad entre [].

## Verificaciones cruzadas (requieren abrir @vergis/capabilities)

- [ ] **[ALTA] Traversal en el nombre del archivo subido.** `handleIntake` (admin.ts:377-400): `u.filename` llega del cliente (multipart) y va a `intake.put(slot.target, u.filename, bytes)`. Verificar: (a) ¿`validateUpload(slot, filename, size)` rechaza `../`, separadores de path y rutas absolutas, o solo valida el patrón del nombre? (b) ¿`intake.put` trata filename como hoja/basename o lo concatena a la ruta de OneLake? Fix: normalizar a basename en put() + rechazar separadores en validateUpload.

- [ ] **[MEDIA] Validación server-side de ids/emails.** Varios forms confían en atributos solo-cliente (`pattern=` :852; `type=email` :877,:902). Verificar validación en el store: `createGroup(id)` (:788), `addMember(gid,email)` (:817), `adminStore.add(email)` (:266). Si no validan server-side, un id fuera de `[a-z][a-z0-9_-]*` entra crudo al HTML de :840 (ver ítem de comilla simple).

## Directamente observable en admin.ts

- [ ] **[MEDIA] CSRF se comprueba DESPUÉS de bufferizar el cuerpo.** `handleIntake` lee hasta 60MB (:377) antes del `requireCsrf` (:378). Un POST sin CSRF válido igual fuerza a bufferear 60MB. Los POST urlencoded (:263,:276,:333) tienen el mismo orden pero cuerpo chico. Fix: límite de pre-parse menor, o verificar origin/referer antes de leer.

- [ ] **[MEDIA] `index_title` es la superficie de escritura de un XSS que aterriza en catalog.** `/admin/settings` (:288-297) guarda `index_title`; acá se re-muestra escapado (:624), PERO los frentes 01/03 reportaron que `catalog.ts` lo interpola SIN escapar en el índice `/`. El fix vive en catalog.ts; anotar que la ENTRADA del valor es esta superficie (admin → todos los consumidores).

- [ ] **[BAJA] `href` sin escapar en buildSidebar.** :438 escapa el label pero no el href (`<a href="${href}">`). Hrefs armados con `d.id`/`e.id` (config, patrón acotado) → riesgo bajo, pero escapar por defensa en profundidad y consistencia.

- [ ] **[BAJA · mantenibilidad] Regex de ruta de dominio duplicada.** :165 (`dmActive`) y :199 (`di`) parsean la misma familia de rutas con dos regex distintas → riesgo de divergencia silenciosa. Unificar en una.

## Verificado OK (no reportar como hallazgo)

- Gates de autz consistentes: :153 (admin O steward de algún dominio), :206 (canMng por dominio), :251-305 (isAdmin en plataforma), :319-320 (entidad sin dominio → solo admin). Accesos denegados auditados (:154,:207,:322).
- Slot de intake acotado al dominio (:372: `s.id===slotId && s.domain===domain.id`) — sin acceso cross-dominio.
- Atomicidad del lote de subida: valida TODOS antes de aterrizar ninguno (:386-393).
- Publish-on-write no-fatal y auditado en ambos caminos (:338-345).
- Casi todo el HTML pasa por escapeHtml; escrituras asentadas en el log append-only.

## Ítem principal (aislado)

- [ ] **[ALTA] Cobertura de la comilla simple en handlers inline.** Varios `onsubmit`/`onclick` colocan un valor pasado por `escapeHtml` DENTRO de un string JS delimitado por comillas simples: `entityPage` :922-923 (`confirm('...${pkv}...')`, donde el valor es una PK de data maestra — texto arbitrario que edita el steward vía `coerceRow`, sin restricción de caracteres), `groupsPage` :840, `rolesPage` :890. `escapeHtml` resuelve la capa HTML-atributo (`"`→`&quot;`); hay que **verificar si también cubre la comilla simple**. Si no, un valor con `'` termina el string JS del handler. Mayor exposición: :922-923 (la PK no está acotada por patrón); :840/:890 dependen de la validación server-side del punto anterior. Fix: (a) que `escapeHtml` escape también `'` y `/`; o (b) reemplazar el `confirm` inline por `data-*` + listener delegado; o (c) un escaper específico de string-JS para lo que entre en handlers inline. Cross-ref: los frentes serve-rls (01) y render (03) lo detectaron de forma independiente.
