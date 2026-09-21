# Plan · El nodo sirve el contenido estático de la instancia (`VERGIS_STATIC`)

| Campo | Valor |
|--|--|
| Objetivo | Una instancia declara **colecciones de archivos estáticos** y el **nodo las sirve** bajo su propia autorización. Con eso desaparecen el contenedor file-server aparte, los bloques por colección en el borde y el `forward_auth` duplicado: publicar contenido deja de tocar el borde. |
| Origen | **Criterio de excelencia** aplicado por pedido de César (2026-09-21) sobre el incidente del portal de ayuda. Antecedente en el propio Producto: [#304](https://github.com/Gegolabs/vergis/issues/304) — *«La salida (sitio estático + contenedor `caddy` con `forward_auth`) existe solo porque el nodo no lo sirve»*, y la decisión de César del 2026-09-07 de que es capacidad genérica. |
| Issue | [#319](https://github.com/Gegolabs/vergis/issues/319) — abierto 2026-09-21 con este contrato |
| Estado | **Diseño listo para ejecutar.** Fase 1 (Producto) es un PR; Fase 2 (instancia A.R.B.O.L.) retira el andamio y exige **una ventana del borde**. |
| Versión | Fase 1 entra en «Sin publicar» → corte **0.31.0** (capacidad ⇒ sube la Y). Catálogo: **`CAP-195`**. |

## ¿Por qué existe este plan? (el caso medido que lo funda)

El 2026-09-21 se publicó el portal de ayuda de la instancia GH (`/ayuda/`) como HTML estático servido por un contenedor `caddy` aparte, con un bloque nuevo en el Caddyfile del borde. **Dio 404 al usuario.** Causa medida: el `Caddyfile` se monta como **bind de archivo** y el despliegue lo reemplazó con `mv`, que cambia el inodo; el contenedor siguió sirviendo el archivo anterior y `caddy reload` releyó el viejo sin avisar. Reparación: recrear el borde, con ventana aprobada y **61 ms** de corte medido.

La lección **no** es «montar por directorio». Es que **publicar una página no debería tocar el borde**. Hoy cada colección cuesta: un montaje en el compose, un bloque con su `forward_auth` copiado, una familia en la sonda de paridad, y el riesgo de que el borde quede sirviendo algo que nadie declaró.

## El contrato (decisiones tomadas; no se re-abren)

1. **`VERGIS_STATIC`** apunta a un YAML de instancia, mismo patrón que `VERGIS_MENU` (CAP-190):

   ```yaml
   static:
     - path: ayuda          # prefijo público: /ayuda/
       dir: /static/ayuda   # directorio DENTRO del contenedor (bind de la instancia)
       label: Portal de ayuda   # opcional, para el log y el contrato
     - path: datadoc
       dir: /static/datadoc
   ```

2. **Autorización: la misma que el catálogo** — cualquier identidad autenticada que el gate ya dejó entrar. Es exactamente lo que hoy da el `forward_auth` del borde, así que no cambia quién ve qué. **Autorización por grupo queda fuera** de este alcance y se declara como extensión futura en el doc (no se implementa a medias).
3. **`path` es un prefijo reservado y validado al cargar.** Se rechaza (con aviso, omitiendo esa entrada) si: está vacío, no matchea `^[a-z0-9][a-z0-9-]*$`, choca con una ruta del nodo (`healthz`, `contrato`, `admin`, `oauth2`, `config`…) o con el **slug de un Let servido**. La colisión con un Let es la peligrosa: se decide en favor del Let —el dato gobernado manda— y la colección se omite nombrando el choque.
4. **Servir es de solo lectura y sin sorpresas:** solo `GET`/`HEAD`; la ruta pedida se resuelve contra la raíz declarada y **se verifica que el resultado siga dentro** (rechaza `..` y symlinks que escapen) ⇒ 403; directorio ⇒ `index.html` si existe, si no 404; `Content-Type` por extensión con **lista blanca** (`.html .css .js .json .svg .png .jpg .jpeg .gif .webp .woff2 .txt .pdf .ico`), lo demás `application/octet-stream` y nunca se adivina; `X-Content-Type-Options: nosniff`.
5. **Los archivos se leen por request** (sin caché en memoria): actualizar el contenido es copiar el archivo, y esa es justamente la propiedad que se busca. Cabeceras: `cache-control: no-cache` para `.html`, e `immutable` **no** se usa (no hay fingerprinting).
6. **Hot-reload del conjunto de colecciones**: `VERGIS_STATIC` entra en `RELOADABLE_SLICES` como hizo `VERGIS_MENU` en CAP-194 — misma tabla, mismo watch, mismo `validate-before-swap`, y una recarga inválida **conserva lo vigente** sin tumbar el nodo.
7. **El contrato del nodo (`/contrato`) declara las colecciones** (path, dir, si el directorio existe y es legible). Un `dir` declarado que no existe o no se puede leer **no impide arrancar**: se omite con aviso nombrado, igual que una entrada de menú inválida. El auto-chequeo de despliegue lo reporta.
8. **El arranque lo declara en su línea de config**, como el menú: `static N colección(es)`.

## Fase 1 — Producto (un PR)

| # | Dónde | Qué |
|--|--|--|
| 1 | `server/static-config.ts` (nuevo, espejo de `menu-config.ts`) | `parseStaticConfig` con las validaciones del punto 3 y los avisos por entrada omitida. |
| 2 | `server/instance-config.ts` | `RELOADABLE_SLICES.static`; `staticCollections` + `staticWarnings` en `InstanceConfig`; conteo en `summary`. |
| 3 | `server/static-serve.ts` (nuevo) | El handler: resolución segura de ruta, MIME por lista blanca, `index.html`, 404/403. **Puro y testeable sin servidor**: recibe `(colecciones, url)` y devuelve `{status, headers, file}` o el fallo. |
| 4 | `server/routes.ts` | Despacho del prefijo **después** de `/healthz`, `/contrato`, `/admin` y la config por PI, y **antes** del despacho por slug de Let. Solo `GET`/`HEAD`. |
| 5 | `server/serve-rls.ts` | Carga, línea de arranque, avisos, bloque en `reloadInstanceSlices` con `splice` sobre el arreglo vivo (**mismo motivo que CAP-194**: verificar si algún consumidor captura la referencia), y `MENU`-style `contract.watch`. |
| 6 | `docs/capacidades.md` | `CAP-195`. |
| 7 | `docs/arquitectura-multi-reporte.md` | Sección con el contrato, la regla de colisión con Lets y la extensión futura (autorización por grupo). |
| 8 | `CHANGELOG.md` «Sin publicar» | Qué trae · **por qué** (el incidente medido) · qué exige (nada) · qué NO hace (no genera contenido —eso es #304—, no autoriza por grupo, no cachea). |
| 9 | `INDEX.md` | Fila `017`. |

**Tests** (`tests/static-serve.test.ts` + `tests/static-config.test.ts`), cada uno debe fallar contra `main`:

1. Parser: entrada válida · `path` con mayúsculas/`/`/vacío ⇒ omitida con aviso · choque con ruta del nodo ⇒ omitida · choque con slug de Let ⇒ omitida nombrando el Let.
2. Servir: `index.html` de la raíz · archivo anidado · MIME correcto por extensión · extensión desconocida ⇒ `octet-stream` · `nosniff` presente.
3. **Seguridad**: `../../etc/passwd`, `%2e%2e%2f`, symlink que escapa ⇒ **403**, y el control positivo de que un symlink *interno* sí se sirve.
4. Router: el prefijo no intercepta `/healthz` ni `/admin`; un Let con el mismo slug gana; `POST` a una colección ⇒ 405.
5. Recarga: agregar/quitar una colección en caliente se refleja; YAML roto conserva lo vigente y avisa.
6. Contrato: `/contrato` lista las colecciones y marca la que apunta a un directorio inexistente.

**Gates**: `typecheck` · `test` · `capacidades:cotejo` · `build`. Stash-check obligatorio.

## Fase 2 — Instancia A.R.B.O.L. (retira el andamio)

Orden pensado para que **nada quede sin servir en el intervalo**:

1. Cortar y promover la versión del Producto con `CAP-195` (promoción por anillos, sin corte).
2. Montar en el anillo los tres directorios ya existentes (`/opt/mira/{datadoc,guias,ayuda}` → `/static/*`) y declarar `VERGIS_STATIC` con las tres colecciones. **Esto es `ring.args`**, así que entra con el anillo del paso 1: se prepara antes.
3. **Verificar con identidad forjada** que el nodo sirve las tres colecciones — *antes* de tocar el borde.
4. **Ventana (17 bis)**: retirar del Caddyfile los tres bloques (`/datadoc`, `/guias`, `/ayuda`) y el servicio `datadoc` del compose, y recrear el borde. Es **la última ventana por este motivo**. ⚠️ Escribir el Caddyfile **preservando el inodo** (`cat nuevo > Caddyfile`), nunca `mv` — y verificar `md5sum` del host **contra el del contenedor** antes de recargar.
5. Verificar con el **discriminador de destino** (`/oauth2/start?rd=…` vs `login.microsoftonline.com`) que las tres rutas ahora las sirve el nodo, y el smoke `--all`.
6. Retirar de `scripts/paridad-vm.sh` las familias `datadoc`, `guias` y `ayuda`, y reemplazarlas por una sola que compare los directorios de estáticos.
7. Registrar el corte en `deploy/cortes-de-servicio.md` y actualizar `RESOURCES.md` (la ficha del portal y la del datadoc pasan a decir que las sirve el nodo).

## Qué NO hacer

- **No** implementar el generador del datadoc (#304): este plan sirve contenido, no lo genera. Son alcances separables y #304 queda abierto.
- **No** autorización por grupo (se declara como extensión, no se construye a medias).
- **No** cachear en memoria ni fingerprinting.
- **No** tocar el borde fuera de la Fase 2 paso 4, ni `mv` sobre el Caddyfile nunca.
- **No** mergear ni taggear sin CI verde confirmado.

## Riesgos

| Riesgo | Mitigación |
|--|--|
| Un prefijo de colección tapa un Let | El Let gana por construcción, y la colección se omite con aviso (test 4) |
| Traversal de ruta | Resolución + verificación de contención, con test de ataque y control positivo (test 3) |
| El intervalo entre el paso 3 y el 4 con ambos caminos vivos | Es deliberado: se verifica el nuevo **antes** de retirar el viejo |
| La ventana del paso 4 | Aprobada por César; corte esperado del orden de los 61 ms medidos hoy |

---

• *Generado con [Wingworking](https://wingworking.org)*
