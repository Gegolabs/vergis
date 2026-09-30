---
description: Validar el spec DSL de un Producto de Información del Botlet Mira en el punto de validación del proto-Botlet, con tres veredictos —acepta, rechaza o no pude medir—, antes de especializarlo EN la instalación; no lo escribe (mira:compile, mira:specify) ni lo publica (mira:specialize). Hoy, mientras el nodo no exponga el punto de validación (#388), valida en local —esquema del DSL de la versión que corre la instalación, render local contra el dato, marcas con su corrida discriminante y los database_ref que la instalación declara— y sella el sha aceptado en un archivo local junto a la declaración, diciéndolo. Usar antes de especializar un spec, o cuando se pida «valida el spec de PI-N», «¿este spec está listo?».
argument-hint: "<spec.yaml> [--installation <id>]"
---

# mira:validate — el punto de validación del proto-Botlet

Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`). **Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí · 3 a 7 **no hubo medición completa**; un 3–7 **no es un verde** (tabla completa en `vergis:verify`).

## ¿Qué veredictos da?

| Veredicto | Cuándo |
|--|--|
| **acepta** | Todas las comprobaciones de abajo midieron y ninguna tiene hallazgo |
| **rechaza** | Alguna comprobación midió y encontró un defecto: se nombra cuál y dónde |
| **no pude medir** | Alguna comprobación no se pudo correr o quedó a medias. **No es un verde**: `mira:specialize` no publica sin «acepta» |

## ¿Qué comprueba hoy?

El punto de validación del canon lo provee el proto-Botlet en el nodo; el nodo aún no lo expone (#388). Mientras tanto, esta skill valida **en local** y lo dice en su veredicto: «validado en local; el punto de validación del nodo aún no existe (#388)».

1. **El esquema del DSL de la versión que corre la instalación**: `schema/mira-spec.schema.json` del repo del Producto **en el tag** de esa versión (`vergis-ops recon` dice cuál corre). Un esquema de otra versión no vale: el contrato cambia entre versiones.
2. **Las fuentes que el spec nombra**: cada `database_ref` del spec tiene que estar declarado en las conexiones de la instalación. Uno no declarado **rechaza**; esta skill no lo crea (eso es `vergis:connect`). El Botlet es dueño de saber qué fuente necesita, no del acceso.
3. **El render local contra el dato**: el `vergis run <spec.yaml> --connections <perfiles>` del Producto en ese mismo tag. Un error de render **rechaza**; sin acceso al dato, **no pude medir**.
4. **Las marcas de dato**, donde el spec dibuja un gráfico: `vergis-ops marks calibrar` (dos documentos de la misma forma con cardinalidades conocidas y **distintas**) y `vergis-ops marks contar --esperado <n>`. Sin calibración vigente, `contar` sale 2: eso es «no pude medir», no un número. Una calibración ciega (el mismo número para las dos cardinalidades) sale 1.

## ¿Dónde queda el veredicto?

Hasta que el nodo registre el veredicto (#388), se **sella en un archivo local junto a la declaración**: `mira-veredictos.jsonl`, en el mismo directorio que `vergis-ops.json`, commiteado. Una línea JSON por veredicto:

```json
{"sha256":"<sha256 del spec>","spec":"<ruta del espejo>","veredicto":"acepta|rechaza|no pude medir","version":"<versión del Producto que corre>","fecha":"<ISO 8601>","mediciones":["esquema: …","database_ref: …","render: …","marcas: …"],"por":"<quién validó>"}
```

El sha es el del archivo **tal como se va a publicar**: un cambio de un byte invalida el veredicto. La skill dice que selló en local, no que el Botler registró.

## ¿Qué no hace esta skill?

- No escribe ni corrige el spec: un rechazo vuelve a quien lo escribió (`mira:compile` o `mira:specify`).
- No publica (→ **mira:specialize**). No crea Conectores (→ **vergis:connect**).

• *Generado con Wingworking*
