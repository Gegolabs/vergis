---
description: Hacer valer EN la instalación de Vergis la política de acceso al dato, en sus dos puntos — (a) en el nodo, publicando las políticas, los grupos, el mapa de identidad, los dominios, las fuentes y los dueños de PI, que el nodo toma en caliente, y (b) en la fuente, aplicando el DDL de RLS aceptado con respaldo y reversa; no decide la política (es del dueño del gobierno del dato), no la compila (custos:compile) ni la valida (custos:validate), y no cambia la versión DE Vergis (vergis:rollout). Clasifica cada acto contra el contrato vivo del nodo y aplica el gate de la instalación; en la fuente, hoy responde «no pude aplicar» (#390). Usar cuando se pida «aplica la policy», «da acceso a…», «saca a X del grupo», «X pasa a ser dueño de…», «actualiza el mapa de identidad».
argument-hint: "<archivo del espejo | DDL aceptado> [--installation <id>]"
---

# custos:enforce — hacer valer la política, en el nodo y en la fuente

**Sombrero de operador:** el CLI `vergis-ops` busca `vergis-ops.json` subiendo desde el directorio de trabajo y sin él **se niega** (ver `vergis:setup`). Con más de una instalación declarada, todo verbo lleva `--installation <id>`. **Crear o cambiar una política es decisión del dueño del gobierno del dato**: esta skill hace valer lo que él decidió, y si el pedido no trae esa decisión, la pide.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## ¿Qué se hace valer, y dónde?

| Punto | Qué | Cómo lo toma | Clase del acto |
|--|--|--|--|
| **(a) En el nodo** | Políticas de acceso al dato · grupos (quién pertenece a qué grupo) · mapa de identidad a área · dominios · fuentes · dueños de PI | El nodo los recarga en caliente | `content` |
| **(b) En la fuente** | El DDL de RLS que `custos:validate` aceptó | Un acto sobre la fuente de datos, con respaldo | Acto sobre la fuente; **destructivo si retira predicados** |

El nombre de cada familia lo pone la instalación en `mirror.families`; lo que decide la skill es qué contiene. El riesgo lo gobierna la clase del acto, no el nombre de la skill: lo que corta pide ventana y lo destructivo pide aprobación (modelo completo en `vergis:setup` §«¿Qué clase de acto es?»).

## Paso 0 · ¿Desde dónde parto?

```sh
vergis-ops check
vergis-ops recon
```

Un drift previo se reporta antes de seguir (detalle en `vergis:setup` §«Paso 0»).

## (a) En el nodo

1. `vergis-ops contract classify <archivo del espejo>` → tiene que decir `content`. Si dice otra cosa, **no es este flujo**: se reporta y se deriva a `vergis:setup`.
2. **Espejo primero:** el archivo está en el repo del operador, commiteado.
3. `vergis-ops publish <archivo>` — aplica el gate, respalda, escribe en sitio, verifica el sha y **espera a que el nodo lo tome**. El nodo valida antes de reemplazar: un archivo malformado no se toma, la política vigente sigue viva, y `publish` sale **1**. Sin la confirmación del nodo (2 o 5), no está aplicado: `vergis-ops contract wait <archivo>`.
4. `vergis-ops parity --family <familia>` hasta 0, y **custos:verify**.
5. El rollback que `publish` imprimió y la entrada en `governance.acts_log` quedan en el reporte.

**Un cambio de grupos o de identidad no llega al login real enseguida:** en el borde de referencia (oauth2-proxy) se ve recién con un login fresco, porque la cookie de sesión dura días. La sonda de `custos:verify` forja la identidad por detrás del borde y lo ve de inmediato; la persona, no.

## (b) En la fuente

Aplicar el DDL en la fuente exige, cuando exista: un veredicto **«acepta»** de `custos:validate` sobre ese mismo DDL, el respaldo de las políticas vigentes de la fuente, la reversa escrita antes de aplicar, y el gate de la clase (aprobación si retira predicados). Hoy el Producto no tiene esa herramienta (#390). Hasta que exista, esta skill responde, con estas palabras:

> **«No pude aplicar en la fuente.»** Aplicar el DDL de RLS aún no está en el Producto (#390). La política quedó vigente en el nodo (si se hizo (a)); en la fuente, no.

No se simula: no se aplica DDL a mano desde esta skill. Si la instalación declara `extensions.data`, la skill que nombra es la que hoy atiende la fuente, **fuera del Producto**, y se dice así.

## ¿Qué no hace esta skill?

- No decide políticas. No compila (→ **custos:compile**) ni valida (→ **custos:validate**).
- No publica contenido que no sea de gobierno del dato (→ **vergis:publish**), ni conexiones (→ **vergis:connect**), ni specs (→ **mira:specialize**).
- No repara un drift de paso: lo reporta.

• *Generado con Wingworking*
