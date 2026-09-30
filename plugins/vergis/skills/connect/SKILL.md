---
description: Declarar EN la instalación de Vergis un Conector (Capa 4) —el perfil de conexión que un spec nombra por `database_ref`— con sus credenciales solo por referencia; no crea tipos de Conector (eso es código del Producto: lo publica el mantenedor en una versión, fuera de los plugins) y no cambia la versión DE Vergis (vergis:rollout). Lee del nodo si las conexiones se recargan en caliente (archivo) o exigen arranque (inline), publica el archivo de conexiones con respaldo y confirma que el nodo lo tomó, y declara lo que no puede medir. Usar cuando se pida «conecta el warehouse nuevo», «agrega la fuente X», «cambia el perfil de conexión», «rota la credencial del conector», o un spec nombre un `database_ref` que la instalación no declara.
argument-hint: "<database_ref> [--installation <id>]"
---

# vergis:connect — declarar un Conector en la instalación

**Sombrero de operador:** el CLI busca `vergis-ops.json` subiendo desde el directorio de trabajo y sin él **se niega**; en el repo del Producto se publica y se avisa, no se opera (detalle en `vergis:setup`). Con más de una instalación declarada, todo verbo lleva `--installation <id>`.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## ¿Qué es un Conector, y de quién es cada parte?

El Conector es saber acceder a un sistema fuente (Capa 4 · Acceso). La instalación lo declara como un **perfil** dentro de `VERGIS_CONNECTIONS`, un objeto `{ database_ref: perfil }`; un spec lo nombra por su `database_ref` y el nodo lo resuelve al perfil.

| Pieza | Dueño |
|--|--|
| El tipo de Conector (el código que sabe hablar con esa fuente) | El Producto: llega en una versión publicada por el mantenedor |
| El perfil: tipo, endpoint, credencial | La instalación: **esta skill** |
| Saber qué `database_ref` necesita un PI | El Botlet: `mira:validate` rechaza un `database_ref` que la instalación no declara, pero no lo crea |

Declarar localidad y disponibilidad offline de cada Conector es buena práctica: se escribe junto al perfil, en el repo del operador.

## Paso 0 · ¿Desde dónde parto?

```sh
vergis-ops check
vergis-ops recon
```

Detalle en `vergis:setup` §«Paso 0».

## Paso 1 · ¿Cómo declara la instalación sus conexiones?

```sh
vergis-ops contract env VERGIS_CONNECTIONS          # ¿qué exige cambiarla?
vergis-ops contract classify <archivo de conexiones> # si es archivo: su clase y su gate
```

| La instalación declara `VERGIS_CONNECTIONS`… | Clase | Camino |
|--|--|--|
| como **ruta a un archivo** | `content`: el nodo lo recarga en caliente | Paso 2 |
| **inline** (el JSON en la variable) | `boot` | No se publica: cambiar la variable es un cambio de arranque. Si exige anillo nuevo, `vergis:rollout` (`ring-args` + promoción); si no, `vergis:setup` §`boot`, con ventana |

**Migrar de inline a archivo** habilita la recarga en caliente y saca los perfiles del entorno legible del contenedor (un env se lee en `/proc` y en `docker inspect`). Es un acto `boot`, una sola vez, con ventana: no lo hace esta skill por su cuenta; lo recomienda y lo deriva a `vergis:rollout` o `vergis:setup`.

**Caveat que declara el nodo:** un pool SQL ya abierto conserva las credenciales previas hasta reciclarse. Un perfil cambiado en caliente aplica a conexiones **futuras**; las vivas siguen con el anterior. Una rotación de credencial no está completa hasta que el pool se recicle, y eso se dice.

## Paso 2 · Las credenciales viajan solo por referencia

**Un secreto interpolado en un script remoto queda en el disco del host** (ocurrió en una instalación real el 2026-09-29). `vergis-ops publish` lleva el contenido del archivo, en base64, dentro del script que corre en el host, y el espejo lo versiona. Por eso esta skill **solo publica un archivo de conexiones que no contiene ningún valor secreto**:

| Modo de credencial del perfil | ¿Lleva un secreto en el archivo? | Qué hace la skill |
|--|--|--|
| `federated` (con `federatedTokenFile`: la ruta del token en el host) | No: lleva una referencia | Lo publica (paso 3) |
| `imds` (identidad administrada del host) | No | Lo publica (paso 3) |
| `secret` (con `clientSecret`) | **Sí** | **Queda fuera de los plugins** hasta que el perfil pueda referenciar su secreto en un almacén en vez de llevarlo (#394). La skill lo dice así: **«el perfil lleva un secreto en claro; los plugins no lo transportan ni lo declaran hasta #394»**, y se detiene |

Antes de publicar, **lee el archivo** y confirma que ningún perfil lleva `clientSecret` (ni en su sub-perfil `consola`). Si lo lleva, es la tercera fila.

## Paso 3 · Publicar

1. **Espejo primero:** el archivo está en el repo del operador, commiteado (sin secretos: paso 2).
2. Si la instalación declara `governance.pretest`, correrlo y tener su evidencia.
3. `vergis-ops publish <archivo de conexiones> [--pretest "<qué corriste y qué dio>"]` — clasifica, aplica el gate, respalda, escribe en sitio, verifica el sha y **espera a que el nodo lo tome**. El nodo valida la forma de cada credencial al cargar (fail-closed): un perfil con un campo faltante no se toma y la configuración vigente sigue viva, y `publish` sale **1**. Sin la confirmación del nodo (2 o 5) no está publicado: `vergis-ops contract wait <archivo>`.
4. El rollback que `publish` imprimió queda en tu reporte, con su entrada en `governance.acts_log` (detalle en `vergis:setup` §«¿Dónde queda el registro?»).

## Paso 4 · ¿El Conector alcanza su fuente?

```sh
vergis-ops contract wait <archivo de conexiones>   # el nodo cargó ESTE archivo (sha local == sha cargado)
```

Eso mide que el nodo **cargó** el perfil, no que **alcanza** la fuente. La prueba de alcance exige un control negativo —conecta y lee con la credencial correcta, **falla** con una inválida—, y el CLI todavía no tiene ese verbo (#391). Hasta que exista, esta skill responde, con estas palabras:

> **«No pude medir el alcance.»** El nodo tomó el perfil `<database_ref>`; que llegue a la fuente no está medido: falta la prueba de alcance con control negativo (#391).

Un «conectó» sin su falla esperada no mide nada: jamás se reporta «el Conector funciona» por un spec que casualmente renderizó.

## ¿Qué no hace esta skill?

- No crea tipos de Conector: es código del Producto, y llega en una versión que publica el mantenedor.
- No transporta secretos ni opera perfiles `secret` (paso 2; #394). No cambia la versión de Vergis (→ **vergis:rollout**).
- No escribe specs ni decide qué fuente necesita un PI (→ **mira**).
- No opera el almacén de datos ni su ingesta (fuera de los plugins; ver `vergis:setup` §«Datos y motor de datos»).

• *Generado con Wingworking*
