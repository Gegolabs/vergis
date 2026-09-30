---
description: Verificar la política de acceso al dato vigente EN una instalación de Vergis —quién ve qué, por identidad, con presentes y ausentes (fail-closed), y el drift entre lo declarado, el nodo y la fuente—, sin cambiar nada; no aplica (custos:enforce) y no verifica la plataforma (vergis:verify) ni cómo se ve un PI (mira:status). Sin comprobaciones de RLS declaradas dice «RLS no verificada», nunca «RLS bien». Usar después de hacer valer una política, y cuando se pregunte «¿quién ve qué?», «¿X ve el dato de Y?», «¿la RLS está bien?», «¿la política vigente es la declarada?».
argument-hint: "[--installation <id>] [--identity <id>]"
---

# custos:verify — ¿quién ve qué, y puedo demostrarlo?

Usa el CLI `vergis-ops` y la declaración `vergis-ops.json` del plugin `vergis` (ver `vergis:setup`). **Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí · 3 a 7 **no hubo medición completa**; un 3–7 **no es un verde**, y un «verificado» con uno de ellos es falso (tabla completa en `vergis:verify`).

## 1 · RLS por identidad

```sh
vergis-ops smoke --rls
```

Cada comprobación de `rls_checks` de la declaración exige sus `present` y la **ausencia** de sus `absent`: la comprobación **fail-closed**. Un `present` solo demuestra que alguien ve algo; el `absent` demuestra que quien no debe, no ve. **Sin `rls_checks` declaradas, el reporte dice «RLS no verificada» — nunca «RLS bien».** Declararlas es de `vergis:setup` (identidades de sondeo, jamás personas reales sin su acuerdo).

Una ruta suelta con una identidad: `vergis-ops smoke <slug>[?page=<id>] --needle "<texto>" --identity <id>`.

## 2 · Drift entre lo declarado, el nodo y la fuente

| Tramo | Cómo se mide | Hoy |
|--|--|--|
| Declarado ↔ nodo | `vergis-ops parity --family <familia de políticas>` (y la de grupos, identidad y dueños) · `vergis-ops contract wait <archivo>` | Se mide |
| Nodo ↔ fuente | El inventario vivo de la RLS de la fuente contra lo declarado | **No medido**: el Producto aún no lo tiene (#390). El reporte dice «drift en la fuente: no medido» |

## ¿Qué ve la sonda, y qué no?

La sonda entra **por detrás del borde** y **forja** la identidad de sondeo: mide el tramo del nodo —gobierno, RLS, dato— y **no** el login real del borde. Un verde es compatible con un SSO roto, y un cambio de grupos se ve en la sonda antes que en la sesión de la persona (la cookie del borde de referencia dura días). Detalle en `vergis:verify` §«¿Qué ve la sonda, y qué no?».

## ¿Qué no hace?

**No repara.** Un drift o una fuga se reportan con su exit y se deciden aparte: la política con su dueño, y el acto con `custos:enforce` y el gate de su clase.

• *Generado con Wingworking*
