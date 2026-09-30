---
description: Publicar EN la instalación de Vergis el contenido que el nodo recarga en caliente —navegación y menú, casillas de carga, data maestra, guías, ayuda y, mientras el nodo no lo genere, el datadoc—; no cambia la versión DE Vergis (vergis:rollout), no toca servicios ni compose (vergis:setup), Conectores (vergis:connect), políticas, identidad y dueños (custos:enforce) ni specs (mira:specialize). Con el sombrero de operador — recon, CLASIFICAR el acto contra el contrato vivo del nodo, aplicar el gate que la instalación declara, publicar con respaldo, escritura en sitio, verificación de sha y confirmación de que el nodo lo tomó, con el rollback escrito, y dejar el registro. Usar cuando se pida «actualiza la guía», «agrega el ítem al menú», «publica la data maestra», «sube la ayuda», «cambia las casillas de carga», «publica el datadoc», o cualquier archivo de contenido del espejo que el nodo recarga.
argument-hint: "<archivo del espejo> [--installation <id>]"
---

# vergis:publish — publicar contenido en la instalación

**Sombrero de operador:** el CLI busca `vergis-ops.json` subiendo desde el directorio de trabajo y sin él **se niega**; en el repo del Producto se publica y se avisa, no se opera (detalle en `vergis:setup`). Con más de una instalación declarada, todo verbo lleva `--installation <id>`.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## ¿Qué contenido es de esta skill, y cuál no?

El nombre de cada familia lo pone la instalación en `mirror.families`; lo que decide la skill es **qué contiene**:

| Contenido | Skill |
|--|--|
| Navegación y menú, casillas de carga (intake), data maestra | **aquí** |
| Guías y ayuda a usuarios | **aquí** |
| Datadoc (catálogo del esquema de datos) | **aquí, transitorio** (ver abajo) |
| Compose, borde, relays, proxies, terreno de anillos | `vergis:setup` |
| Perfiles de conexión (`VERGIS_CONNECTIONS`) | `vergis:connect` |
| Políticas de acceso, grupos, dominios, fuentes, dueños de PI, mapa de identidad | `custos:enforce` |
| Specs de los PIs | `mira:specialize` |
| Rúbricas de Miranda | `mira:specify` |

**El datadoc es transitorio aquí.** El Producto lo genera en el nodo desde la 0.33.0 (`CAP-197`: mide las conexiones, cruza con los specs, dibuja y publica el sitio con calendario, y lo redibuja sin conteos cuando cambia el gobierno). Una instalación que no lo tiene encendido lo genera por su cuenta y lo publica con esta skill. Encendido el del nodo, la familia sale de los plugins: nadie lo publica, lo produce la plataforma. **Encenderlo no es de esta skill:** es un cambio de arranque (`VERGIS_DATADOC`, `VERGIS_WRITERS` y el montaje de su archivo), o sea `vergis:rollout` con `ring-args`.

## Paso 0 · ¿Desde dónde parto?

```sh
vergis-ops check
vergis-ops recon      # check + health + contrato + anillos + paridad, sin tocar nada
```

Un drift previo (paridad en 1) se reporta antes de seguir; un punto de partida no sano (health en 1) es un incidente, no una publicación. Detalle en `vergis:setup` §«Paso 0».

## Paso 1 · ¿Qué clase de acto es?

```sh
vergis-ops contract classify <archivo del espejo>   # la clase, por qué, y el gate que le toca
```

Tiene que decir **`content`**: lo que el nodo recarga en caliente, según un `watch` del contrato **vivo** — jamás según una tabla de memoria. Si dice otra cosa (`boot`, `service`, `service-interrupting`), **no es este flujo**: es `vergis:setup` o `vergis:rollout`. El gate lo declara la instalación (`governance.gates`); una clase sin gate pide aprobación, y nunca se escribe una evidencia que no existe. El modelo completo de clases y gates está en `vergis:setup` §«¿Qué clase de acto es?».

## Paso 2 · Publicar

1. **Espejo primero:** el archivo está en el repo del operador, commiteado, y la fuente es él, no el host.
2. Si la instalación declara `governance.pretest`, correrlo y tener su evidencia.
3. `vergis-ops publish <archivo> [--pretest "<qué corriste y qué dio>"]` — clasifica, aplica el gate, **respalda** (`<ruta>.bak-<ts>`), escribe **en sitio** (conserva inodo, dueño y modo: un montaje de archivo sigue el inodo), **verifica el sha** en el host y **espera a que el nodo lo tome** (`pending=false` con el sha local). **No dice «publicado» sin esa confirmación**: si el nodo no lo toma sale **1** (revisa `/contrato`, `reloads.last`, antes de reintentar); si no pudo preguntarle (el contrato no respondió) sale **2**, y si el anillo no devolvió el estado del artefacto, **5** — en esos dos el archivo está en el host y la publicación **no está confirmada**: `vergis-ops contract wait <archivo>` antes de seguir.
4. `vergis-ops smoke` — **todos** los Lets, no solo el que usa el contenido (un cambio rompe colateralmente).
5. `vergis-ops parity --family <familia>` hasta 0.
6. El rollback que `publish` imprimió queda en tu reporte.

## ¿Dónde queda el registro?

Una entrada en `governance.acts_log` con qué se publicó, la clase, el gate y su evidencia, las mediciones con su exit y el rollback. Si la instalación no declara dónde, la salida del CLI es el registro y se pega en el reporte (detalle en `vergis:setup`).

## ¿Qué no hace esta skill?

- No cambia la versión de Vergis (→ **vergis:rollout**). No toca servicios (→ **vergis:setup**). No verifica por su cuenta (→ **vergis:verify**).
- No publica specs, políticas ni conexiones: cada uno tiene su skill (tabla de arriba), porque cada uno tiene su dueño y su validación.
- No decide gates: los lee. No repara un drift de paso: lo reporta.

• *Generado con Wingworking*
