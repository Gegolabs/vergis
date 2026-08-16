# RESOURCES — Vergis

> Inventario operacional de accesos y recursos externos de esta instancia del proyecto (Ley de
> Wingworking, Norma 4). Declara el mapeo **herramienta → cuenta exacta**, para no pagar el costo de
> redescubrir la cuenta correcta en cada interacción.
>
> **Acá no van secretos.** Identificadores y rutas sí; contraseñas, client secrets y tokens viven
> fuera del repo y se dice **dónde**.

## Cuentas externas

| Servicio | Cuenta | Notas |
|---|---|---|
| **Azure / Entra — terreno propio** | `cesar.obach@ultrabase.onmicrosoft.com` | Tenant **ultraBASE** `41eb660f-56d9-407a-93e0-c1e5eb7be21c`, suscripción `ultrabase` `b9ce0759-1cf3-4be9-af83-149c926fd584`. Es **la nuestra**: acá vive el terreno Fabric |
| **Azure — tenant del cliente** | `arboltec@grupohijuelas.com` | Grupo Hijuelas, tenant `8c1604ef-…`. **Del operador, no nuestro.** Se lee, no se opera desde este repo (`CLAUDE.md` §«La frontera») |
| **GitHub** | `cobach` / cuenta `claude` para publicar | Issues y PRs del repo público |

> ⚠ **La trampa que muerde:** el default del `az` CLI en la máquina de César apunta al tenant **del
> cliente**. Todo comando contra el terreno propio lleva `--subscription $VERGIS_FAB_SUB` explícito.
> `az ad …` **no acepta `--subscription`**: para Entra se pide token de Graph con
> `az account get-access-token --subscription $VERGIS_FAB_SUB --resource https://graph.microsoft.com`
> y se llama la API directo, en vez de cambiar el default global por debajo.

## Terreno Fabric propio (issue #186)

Desconectado del cliente, datos sintéticos, **capacidad pausada por defecto**. Runbook y criterios en
[`scripts/README-fabric-lab.md`](scripts/README-fabric-lab.md).

| Recurso | Valor |
|---|---|
| Resource group | `rg-vergis-fabric-lab` (West US 2) |
| Capacidad | `vergisfablab` — SKU **F2**, ~US$0,36/h **encendida**, ~US$0,18 por CU-hora (medido contra el retail price API, 2026-08-16) |
| Workspace | `vergis-fabric-lab` · `6ac511a9-cb51-423a-93bf-1f669d03fd0e` |
| Warehouse | `vergislab` · `4e1a4b39-bf4e-4c2e-8d8c-e92dbe7b0714` |
| Endpoint SQL | `b5towqozkz5ebe7ayhs6w67cdq-vei4k2srzm5efe57d5tj2a75by.datawarehouse.fabric.microsoft.com` |
| Collation | `Latin1_General_100_BIN2_UTF8` — Fabric Warehouse no soporta `NVARCHAR` |
| SP de serving (laboratorio) | `vergis-lab-serving-sp` · appId `9faa3c3c-27ca-44e5-ad18-8ce65e9e1b11` · rol **Viewer** en el workspace. **El rol decide si tiene `UNMASK`** — medido: `Member` ve el valor real, `Viewer` ve la máscara |

**Cómo se pausa y se prende** — y no es opcional:

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
npm run fab:resume   # empieza a facturar
npm run fab:pause    # deja de facturar cómputo
npm run fab:state    # Paused | Active
```

**El secreto del SP no está en el repo.** Es un secreto de laboratorio, en tenant propio y sobre
datos sintéticos, pero igual vive fuera: se regenera con
`POST /applications/{objectId}/addPassword` de Graph cuando haga falta, y no se commitea nunca.

### Recursos preexistentes en el tenant ultraBASE — no son del Producto

Encontrados el 2026-08-16 al levantar el terreno; **no los toca este repo**, y se declaran porque
consumen presupuesto o licencia:

| Recurso | Estado |
|---|---|
| Capacidad `Trial-20260525T022032Z-…` (FTL64, Chile Central) | Active — iniciada el 2026-05-25 |
| Capacidad `Premium Per User - Reserved` (PP3, Chile Central) | Active |
| Workspaces `arbol-lab-smoke-test`, `arbol-lab-qw04` | sobre la capacidad Trial |

## Terreno T-SQL local (sin cuenta, sin costo)

SQL Server 2022 en Docker: `npm run lab:up` / `lab:proof` / `lab:down`. No exige credenciales de
nadie. Ver [`scripts/README-tsql-lab.md`](scripts/README-tsql-lab.md).

---

• *Generado con Wingworking*
