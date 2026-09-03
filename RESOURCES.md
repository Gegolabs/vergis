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
>
> ⚠ **Y `--tenant` NO es sustituto de `--subscription`** — medido el 2026-08-26:
> `az account get-access-token --tenant 41eb660f-… ` **falla** con
> `AADSTS50020: … does not exist in tenant 'ultraBASE'`, porque la cuenta activa es la del cliente y
> no existe en el tenant propio. La misma petición **con `--subscription $VERGIS_FAB_SUB` funciona**
> (token de datos obtenido, ventana de Fabric corrida). La suscripción sí está en la lista de la
> cuenta activa; el tenant no. Alcanzar el **plano de Fabric** (no ARM) sí exige un login propio:
> `az login --tenant 41eb660f-56d9-407a-93e0-c1e5eb7be21c --scope "https://api.fabric.microsoft.com/.default"`.
>
> ⚠ **`az resource list` NO ve una capacidad Trial ni una licencia PPU** — no son recursos ARM, viven
> en el plano de Fabric. Su vacío significa **«no pude medir»**, jamás «no existen»: el instrumento
> que decide es `GET https://api.fabric.microsoft.com/v1/capacities`, y ése exige el login de arriba.
> Medido el 2026-08-26 al re-derivar la ficha de las dos capacidades preexistentes.

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
| SP de serving (laboratorio) | `vergis-lab-serving-sp` · appId `9faa3c3c-27ca-44e5-ad18-8ce65e9e1b11` · objectId `38a06a01-8f44-4418-8174-9eae0ad7190b` · rol **`Viewer`** en el workspace — **medido en vivo el 2026-08-19** (`GET /v1/workspaces/{id}/roleAssignments`), no leído de este archivo. **El rol decide `UNMASK`** (`Member` sí, `Viewer` no) — pero **el cambio de rol no propaga simétricamente**: ver la nota de abajo antes de medir |

> ⚠️ **`UNMASK` y el rol del workspace — medido, y con una asimetría que importa.**
>
> **`Viewer` NO tiene `UNMASK`; `Member` sí.** Medido el 2026-08-19 con conexión nueva y token nuevo,
> control positivo en verde y sin tocar una sola sentencia DDL. Coincide con lo registrado el
> 2026-08-16.
>
> **Pero el cambio de rol no propaga simétricamente, y eso es lo que hay que saber antes de creerle
> a cualquier medición de `UNMASK`:**
>
> | Acto | Propagación medida |
> |---|---|
> | **Conceder** (`Viewer` → `Member`) | **≤11 s** a una conexión nueva con token nuevo |
> | **Revocar** (`Member` → `Viewer`) | **>300 s** — y **ni una conexión nueva ni un token nuevo la destraban** |
> | **Cualquiera de los dos, sobre una conexión YA ABIERTA** | **nunca** dentro de la ventana medida (60 s de sondeo) |
>
> **La conexión viva es una frontera dura: la autorización se fija al conectar.** Un pool que sostiene
> conexiones conserva el privilegio del momento en que las abrió.
>
> **La trampa que esto arma, y que ya cobró una víctima el mismo 2026-08-19:** una corrida midió el SP
> en `Viewer` leyendo **en claro** y se publicó como veredicto. Era **residuo de la revocación no
> propagada** de tres días antes. Cuánto dura esa staleness y qué la termina **no está medido** —solo
> su cota inferior, >5 min—; entre la lectura contaminada y la limpia pasaron ~4 h y una pausa de
> capacidad, y cuál de las dos la cortó se desconoce.
>
> **Regla operativa que sale de esto:** una medición de `UNMASK` solo vale si el rol **no cambió
> recientemente**, o si se hizo sobre un principal que nunca tuvo el rol superior. Un rol recién
> bajado miente a favor del privilegio.
>
> **Instrumentos que NO sirven para esto** (medido el 2026-08-19, para que nadie los reintente):
> `fn_my_permissions(NULL,'DATABASE')` devuelve `[]` incluso para permisos que el principal
> evidentemente tiene, y `DATABASE_PRINCIPAL_ID()` **no está soportado** en Fabric. Un `[]` ahí
> significa *«no pude medir»*, no *«no tiene `UNMASK`»*. Y una consulta cruda sin el prelude de
> `SESSION_CONTEXT` **no mide nada**: la row policy deniega todas las filas y el control positivo
> sale vacío.

**Cómo se pausa y se prende** — y no es opcional:

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584
npm run fab:resume   # empieza a facturar
npm run fab:pause    # deja de facturar cómputo
npm run fab:state    # Paused | Active
```

**El secreto del SP no está en el repo, pero ya no falta.** Es un secreto de laboratorio, en tenant
propio y sobre datos sintéticos; vive en **`local/fabric-lab-sp.env`** (modo `600`, y `local/` está
en `.gitignore`), junto al `FAB_SP_ROLE` que el arnés exige declarar. Se carga con
`source local/fabric-lab-sp.env` antes de la ventana.

La app tiene **dos** credenciales vivas: `lab-186` (hasta 2028-08-16, cuyo **valor se perdió** — solo
se muestra al crearlo) y **`lab-186-b`** (hasta 2028-08-19), emitida el 2026-08-19 por mandato
explícito de César en sesión. Se emite con `az ad app credential reset --append`; **el `--append` no
es opcional**: sin él el comando **borra** las credenciales existentes en vez de agregar una. Y
`az ad` **no acepta `--subscription`** —hereda el tenant de la cuenta activa—, así que antes va
`az account set --subscription b9ce0759-…` y después se devuelve el default. No se commitea nunca.

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
<!-- alma · recursos · compilada_de 7e105cb22b58 · 2026-09-03T22:32:14Z · items 0 -->
