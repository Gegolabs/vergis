---
description: Especificar conversando el spec de un Producto de Información del Botlet Mira con Miranda, el agente de especificación que corre en el nodo de la instalación, hasta un resumen de intención que la persona aprueba, y mantener las rúbricas de Miranda EN la instalación; no compila documentos (mira:compile), no valida (mira:validate) ni especializa (mira:specialize: specify propone, specialize publica). Precondición: Miranda encendida en el nodo; si no, lo dice y no simula. Usar cuando se pida «quiero un PI que muestre…», «especifiquemos un indicador», «ajusta la rúbrica de Miranda».
argument-hint: "[<intención en lenguaje natural> | rúbricas] [--installation <id>]"
---

# mira:specify — especificar conversando, con Miranda

**Miranda especifica; esta skill no la reemplaza.** Miranda es el agente de especificación de Mira en el nodo: conoce el DSL y el catálogo de datos, sondea el dato por el riel con RLS, y conversa con la persona **con su identidad**. Esta skill verifica que Miranda esté disponible, lleva a la persona hasta ella, y recoge el resultado para el resto del ciclo. Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`).

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí · 3 a 7 **no hubo medición completa**; un 3–7 **no es un verde** (tabla completa en `vergis:verify`).

## Precondición · ¿Miranda está encendida en el nodo?

Miranda se enciende en la instalación con `MIRANDA_ENABLED`. Con la variable apagada, el nodo no monta la ruta y `/miranda` cae al 404 normal (`server/routes.ts`, `server/miranda.ts`). Encendida pero con la configuración incompleta —falta `ANTHROPIC_API_KEY`, o `MIRANDA_API_BASE_URL` no es una URL absoluta—, el nodo sigue sirviendo, `/miranda` responde **503** con la razón, y `/contrato` la declara en `miranda.disabledReason` (`server/config.ts`).

```sh
vergis-ops smoke miranda --identity <identidad de sondeo con el scope miranda>
```

| Resultado | Qué significa | Qué se hace |
|--|--|--|
| exit 0 (200) | Miranda responde | seguir |
| exit 1 con **404** | Miranda está **apagada**: `MIRANDA_ENABLED` no está encendido | decirlo así: **«Miranda no está encendida en esta instalación»**, y detenerse. Encenderla es un cambio de arranque: `vergis:rollout` si exige anillo nuevo, o `vergis:setup` §`boot` |
| exit 1 con **503** | Miranda está **pedida pero degradada**: falta configuración | decirlo así: **«Miranda está pedida pero degradada»**, con la razón que declara `disabledReason` en `/contrato`, y detenerse. Lo que falta es **configuración** del nodo (la key o la URL base), no una versión ni un anillo |
| cualquier otro resultado (403: la identidad no tiene el scope `miranda`; 2 a 7) | No se pudo comprobar | **«No pude verificar que Miranda esté encendida»**, y detenerse |

No se simula: **si Miranda no está, esta skill no especifica por su cuenta.**

## La conversación

1. La persona conversa con Miranda en `<la URL de la instalación>/miranda`, con su propia identidad (el login real del borde, no la sonda).
2. **Una decisión raíz por turno.** Miranda propone; la persona decide.
3. **La persona nunca toca el YAML:** aprueba un **resumen de intención**, y de ese resumen sale el spec DSL.
4. **Miranda especifica, no construye datos.** Si la intención pide un dato que el catálogo no tiene, lo dice y abre el pedido; no lo inventa ni lo aproxima.
5. El resultado —resumen aprobado y spec— pasa a **`mira:validate`**. Nada se publica desde aquí: publicar es `mira:specialize`.

| Paso | Clase del acto |
|--|--|
| Conversar y aprobar | `read`: no cambia la instalación |
| Publicar el spec | no es de esta skill (`mira:specialize`, `content`) |

## Las rúbricas de Miranda

Las rúbricas con que Miranda juzga lo que especifica son contenido de la instalación, y se mantienen aquí:

1. `vergis-ops contract classify <rúbrica del espejo>` → tiene que decir `content`; si dice otra cosa, no es este flujo (`vergis:setup`).
2. **Espejo primero**, commiteado. Si la instalación declara `governance.pretest`, correrlo y pasar su evidencia con `--pretest "<qué corriste y qué dio>"`: el CLI la exige y sin ella sale 2.
3. `vergis-ops publish <rúbrica> [--pretest "…"]` — respalda, escribe en sitio, verifica el sha y **espera a que el nodo la tome**. Sin esa confirmación (2 o 5) no está publicada: `vergis-ops contract wait <rúbrica>`.
4. `vergis-ops parity --family <familia de rúbricas>` hasta 0. El rollback que `publish` imprimió y la entrada en `governance.acts_log` quedan en el reporte (ver `vergis:setup`).

## ¿Qué no hace esta skill?

- No escribe specs con el conocimiento propio del agente: los escribe Miranda.
- No compila documentos (→ **mira:compile**), no valida (→ **mira:validate**), no publica specs (→ **mira:specialize**).

• *Generado con Wingworking*
