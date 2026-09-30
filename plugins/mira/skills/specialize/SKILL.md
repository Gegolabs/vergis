---
description: Especializar EN la instalación de Vergis el Botlet de un Producto de Información de Mira —instanciarlo o evolucionarlo— publicando un spec que mira:validate aceptó; no especifica (mira:specify), no valida (mira:validate) y no cambia la versión DE Vergis (vergis:rollout). Se niega a publicar un sha sin veredicto «acepta». Clasifica el acto contra el contrato vivo del nodo, publica con respaldo y confirma que el nodo lo tomó. Usar cuando se pida «sube el spec de PI-N», «publica el PI», «actualiza el spec».
argument-hint: "<spec.yaml> [--installation <id>]"
---

# mira:specialize — instanciar o evolucionar el Botlet de un PI

**Sombrero de operador:** el CLI `vergis-ops` busca `vergis-ops.json` subiendo desde el directorio de trabajo y sin él **se niega** (ver `vergis:setup`). Con más de una instalación declarada, todo verbo lleva `--installation <id>`.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## Precondición · ¿Este sha fue aceptado?

`specialize` publica **solo** un spec cuyo sha256 tiene un veredicto **«acepta»** de `mira:validate`. Hoy ese veredicto vive en `mira-veredictos.jsonl`, junto a `vergis-ops.json` (#388: el nodo aún no lo registra):

```sh
shasum -a 256 <spec.yaml>        # el sha del archivo tal como se va a publicar
```

Si no hay una línea con ese sha y `"veredicto":"acepta"`, la skill **se niega**, con estas palabras: **«No publico: este sha no tiene veredicto "acepta" (mira:validate).»** Un «rechaza» o un «no pude medir» no alcanzan, y un veredicto de otro sha tampoco.

## Paso 0 · ¿Desde dónde parto?

```sh
vergis-ops check
vergis-ops recon
```

Un drift previo se reporta antes de seguir (detalle en `vergis:setup` §«Paso 0»).

## Publicar

1. `vergis-ops contract classify <spec.yaml>` → tiene que decir **`content`**: el nodo recarga los specs en caliente, según su contrato **vivo**. Si dice otra cosa, **no es este flujo**. El gate lo declara la instalación; una clase sin gate pide aprobación, y nunca se escribe una evidencia que no existe (modelo completo en `vergis:setup`).
2. **Espejo primero:** el spec está en el repo del operador, commiteado, con el sha aceptado.
3. `vergis-ops publish <spec.yaml> --pretest "<el veredicto de mira:validate: sha, fecha, mediciones>"` — si la instalación declara `governance.pretest`, esa es su evidencia. Respalda, escribe en sitio, verifica el sha y **espera a que el nodo lo tome**. Si el nodo no lo toma sale **1** (revisa `/contrato`, `reloads.last`); sin confirmación (2 o 5) no está publicado: `vergis-ops contract wait <spec.yaml>`.
4. `vergis-ops smoke` — **todos** los Lets, no solo el tocado.
5. `vergis-ops parity --family <familia de specs>` hasta 0, y **mira:status** para ver el PI por identidad.
6. El rollback que `publish` imprimió y la entrada en `governance.acts_log` quedan en el reporte (ver `vergis:setup`).

## ¿Qué no hace esta skill?

- No especifica ni valida: publica lo aceptado.
- No publica contenido de la instalación (→ **vergis:publish**), políticas (→ **custos:enforce**) ni rúbricas (→ **mira:specify**).
- No cambia la versión de Vergis (→ **vergis:rollout**).

• *Generado con Wingworking*
