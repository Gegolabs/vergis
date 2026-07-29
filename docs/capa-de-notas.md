# La capa de notas — impresiones, anotaciones y comentarios

> **Documentación canónica del Producto.** Define cómo Mira/Vergis guarda **lo que una persona dice
> sobre lo que ve** — para humanos que lo operan y para **agentes** que usan este Botlet.
> Comportamiento genérico, independiente de instancia. Complementa
> [`gobierno-permisos.md`](gobierno-permisos.md).

## 1 · ¿Qué problema resuelve?

Un Producto de Información responde una pregunta con datos. Pero el trabajo no termina ahí: alguien
mira una fila y sabe algo que el dato no dice. «Este folio ya lo revisó Contabilidad». «Esta cifra
está mal, falta la nota de crédito». «Ojo con este proveedor». Ese conocimiento es tan valioso como
el dato, y hasta ahora no tenía dónde vivir.

La capa de notas le da lugar, con una distinción que gobierna todo lo demás: **hay dos cosas
distintas que la gente quiere decir**, y confundirlas produce un sistema que no sirve para ninguna.

## 2 · Las dos especies

| | **Anotación** | **Comentario** |
|--|--|--|
| ¿Sobre qué? | Sobre **lo que vi**: una impresión congelada | Sobre **un registro**: la empleada 4021 |
| ¿Cuánto dura? | Lo que dure la impresión (retención configurable) | Permanente, mientras exista el registro |
| ¿Quién la ve? | Yo, y quien reciba la impresión compartida | Cualquiera que vea ese registro, **en cualquier PI** |
| ¿Cuándo se autoriza? | Al **imprimir** (el congelado nace ya filtrado por RLS) | Al **escribir** (se verifica contra el dato vivo) |
| Caso típico | «En la vista de la semana 24, este total no cuadra» | «Contabilidad: OK» pegado al folio |

La consecuencia práctica de la fila «¿quién la ve?»: un comentario sobre la empleada 4021 es **el
mismo** se llegue desde el PI de Personas o desde el de Remuneraciones. La conversación sigue al
registro, no a la pantalla donde se abrió.

## 3 · La impresión

Una **impresión** es lo que viste, congelado tal como lo viste: las filas, la forma, el recorte
(página y parámetros de navegación), la fecha del dato (`watermark`), la versión del spec y quién la
tomó. No es un enlace a una vista: es un documento. Abrirla mañana muestra lo de ayer, que es
exactamente lo que hace que anotarla signifique algo.

Nace de dos maneras:

- **«Imprimir»** — un acto deliberado desde la bandeja del PI.
- **Materialización perezosa** — la primera anotación sobre una vista hace nacer su impresión sola.
  Nadie tiene que entender el concepto para usarlo: anota, y lo anotado queda con su contexto.

**Identidad del sustrato.** Anotar tres filas de la misma vista no produce tres impresiones. Dos
anotaciones comparten impresión si coinciden la vista, el recorte, el watermark y el spec, y si
ocurren dentro de la misma **sesión de trabajo** (12 h desde la última actividad). Vista nueva,
watermark nuevo o sesión nueva ⇒ impresión nueva.

Se ve **read-only y sin drills**: navegar desde una impresión a una vista viva llevaría a dato de
hoy dentro del marco de un dato de ayer.

## 4 · El comentario y la llave de negocio

Para clavar un comentario en un registro hace falta saber **qué registro es**. Eso lo declara el
spec, en el dataset:

```yaml
data:
  empleados:
    capability: execute-sql-dwh
    params: { sql: "select rut, nombre, sueldo from dbo.dim_empleado" }
    anchor:
      entity: dbo.dim_empleado   # la entidad gobernada — es lo que unifica el comentario ENTRE PIs
      key: [rut]                 # columnas del dataset que identifican una fila
      display: nombre            # (opcional) columna legible para nombrar el registro
```

`anchor` es **descriptivo, jamás autorizador**: dice qué es una fila, no quién puede verla. El spec
sigue siendo authz-blind.

**Sin `anchor` no hay gesto.** Un dataset que no declaró llave no ofrece comentar, y el endpoint
responde 404: la capacidad no existe ahí. Es deliberado — un comentario anclado a una llave
inventada queda colgando en silencio, que es peor que no poder comentar.

### El gate se verifica contra el dato

Al escribir un comentario, el servidor **re-ejecuta la recuperación del dataset bajo la identidad
del autor** y exige que la fila con esa llave esté en el resultado. Si no está: 403.

Esto no es un detalle de implementación, es la decisión. Verificar contra un token firmado sería
verificar contra lo que el servidor dijo *antes*; una autorización revocada seguiría escribiendo con
tokens de páginas viejas. Verificar contra el dato pregunta lo que corresponde: *¿esta persona ve
esta fila, ahora?* La lectura del hilo es igual de estricta.

En la tabla, un registro comentado lleva un **marcador** discreto en la esquina de la celda; al
hacer clic se abre el hilo. Solo viajan al navegador las llaves que **tienen** comentarios, y solo
de filas que la RLS ya autorizó: el render es escaso y no delata la existencia de filas no servidas.

## 5 · Compartir

Compartir una impresión es un **acto gobernado**: solo el dueño, con registro de quién y cuándo, y
revocable. El receptor ve exactamente lo que el emisor vio — modelo documento, no modelo enlace.

La revocación es **hacia adelante**: el receptor pierde el acceso, pero las notas que ya escribió
persisten. El trabajo humano no se borra por un cambio de permiso.

El registro de compartición **es** la fuente de «Compartidas conmigo»: el control y la funcionalidad
son la misma pieza, así que no pueden desincronizarse.

## 6 · «Mis impresiones»

Superficie de plataforma, accesible desde el menú del avatar. Dos zonas: **mías** y **compartidas
conmigo** (con quién la envió y cuándo). Filtros por PI, fecha y presencia de notas.

Está en el menú a propósito: una capacidad que no se ve, no existe.

Los comentarios **no** viven aquí — viven pegados a sus registros, que es donde se buscan.

## 7 · Lo que el motor nunca hace

**El motor jamás lee una nota.** Ninguna query, filtro, KPI, cruce ni orden depende del store de
notas. El enriquecimiento de comentarios corre *después* de componer, sobre el resultado ya cerrado,
y si falla el PI se sirve idéntico y sin marcadores. Las notas decoran lo que el dato dijo; no
participan en decirlo.

Corolario operativo: **las notas no viajan en el export CSV**. Es dato del PI, no la conversación
sobre él.

## 8 · Referencias que ya no resuelven

Un registro puede desaparecer o cambiar de llave. Cuando una referencia no resuelve, la nota se
**marca**, jamás se borra: alguien escribió eso por una razón, y perder la razón es peor que
mostrarla junto a un aviso.

## 9 · Configuración

| Setting (`/admin/plataforma` → Notas) | Default | Estado |
|--|--|--|
| `notas_retencion_impresiones` | `P12M` | **Se aplica**: purga al arranque y cada 24 h |
| `notas_max_schedules_usuario` | `10` | Declarado; se aplica con los envíos programados |
| `notas_anti_cementerio` | `on` | Declarado; se aplica con los envíos programados |

La retención se mide desde la **última actividad**: anotar una impresión vieja la mantiene viva.
Al vencer, se borra con sus notas y comparticiones, y lo purgado se loguea.

La retención se valida con el mismo parser que la consume (duraciones ISO-8601: `P6M`, `P12M`,
`P2Y`, `P1W1D`), no con un regex propio.

| Variable de entorno | Qué hace |
|--|--|
| `VERGIS_NOTES_DB` | Archivo SQLite de la capa de notas. Default: `<VERGIS_OUT>/notas.sqlite` |
| `VERGIS_CSRF_SECRET` | Secreto HMAC de los tokens CSRF de las superficies de gestión. Sin él se genera uno por arranque (los formularios abiertos no sobreviven un restart ni se comparten entre réplicas) |

**Envs retirados.** `VERGIS_ANNOTATION_SECRET`, `VERGIS_ANNOTATIONS_DB` y `VERGIS_ANNOTATIONS_URL`
se ignoran y emiten un aviso al arranque (nunca se imprime su valor).

El store abre **no-fatal**: si falla, la capa queda deshabilitada con log y el nodo sigue sirviendo
sus PIs. Una nota no vale una caída.

## 10 · Mapa de rutas

| Ruta | Qué hace |
|--|--|
| `POST /<slug>/imprimir` | Congela la vista actual — «Imprimir» deliberado |
| `POST /<slug>/notas` | Anota; materializa la impresión perezosamente si hace falta |
| `POST /<slug>/comentarios` | Comenta un registro (gate al escribir, contra el dato) |
| `GET /<slug>/comentarios` | El hilo de comentarios de una llave |
| `GET /impresiones` | Mías + compartidas conmigo |
| `GET /impresiones/<id>` | La impresión congelada, read-only, con su panel de anotaciones |
| `POST /impresiones/<id>/notas` | Anota o responde sobre una impresión |
| `POST /impresiones/<id>/compartir` · `/revocar` · `/borrar` | Actos del dueño |

## 11 · Contrato para agentes

- **No inventes el `anchor`.** Si el especificador no declaró llave de negocio en un dataset, el
  gesto de comentar no se ofrece ahí. Declararla es una decisión del especificador sobre su spec.
- **`anchor` no es autorización.** Nunca escribas reglas de acceso en el DSL; `entity` y `key`
  describen identidad de negocio y nada más.
- **No leas notas desde el motor.** Si una funcionalidad «necesita» que una query cruce el store de
  notas, la funcionalidad está mal planteada.
- **No borres una nota huérfana.** Márcala; el contenido humano se conserva.
- **La llave canónica es una sola.** Store, servidor y runtime construyen la misma cadena
  (columnas ordenadas, valores coercionados a texto). Si tocas una implementación, toca las tres.
- **La voz existe en el modelo, no en la función.** `contenido_tipo` y `audio_ref` están en el
  esquema; escribir una nota de voz responde 501 hasta que la captura exista.

---

• *Generado con [Wingworking](https://wingworking.org)*
