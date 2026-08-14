# NEXT — Vergis

**0.16.1 publicada** (2026-08-14). Suite en **2101 tests**, typecheck y build verdes, CI de `main`
verde, árbol limpio y pusheado.

**La instancia de A.R.B.O.L. corre 0.15.0, y eso NO es pendiente nuestro.** Acá se es el Producto: se
publica la versión con su changelog y su aviso; qué versión corre una instancia y cuándo entra lo
decide quien la opera. Si el operador pregunta, la respuesta es que tome **0.16.1** directamente — un
solo despliegue en vez de dos. Ver `CLAUDE.md` §«La frontera» y `DECISIONS.md` D-28.

## Lo primero al retomar: tres issues implementables, sin ventana ni permiso de nadie

Nacieron el 2026-08-14 de casos reales de la instancia, y **ninguno necesita motor vivo**. Los tres
traen sus sitios de código localizados por César en el cuerpo del issue:

- **#182** — un admin sembrado **no se puede revocar**: la siembra es `INSERT … ON CONFLICT DO UPDATE`
  sin `DELETE` ni tombstone, y quitarlo por la UI choca con `AdminLockout` (409). Caso real: una
  cuenta técnica usada por una persona, con gestión de todos los dominios y acceso a Miranda, y la
  atribución de cada acto inservible. Precedencia runtime-sobre-semilla, como ya se hizo en #107.
- **#183** — `stewards:` acepta solo correos. El único camino de grupo→steward
  (`VERGIS_DEFAULT_STEWARD_GROUPS`) es **todo o nada**: 6 personas quedaron steward de los 7 dominios
  por necesitar gestionar la ingesta de uno.
- **#185** — el gesto de comentar da **403** cuando el alcance viene de un `default` resuelto
  server-side: el CFG publica `nav.ctx` en vez del ctx efectivo.

## El frente estructural: #186 — terreno Fabric propio

**Decidido por César el 2026-08-14: el Producto tiene su propio terreno, completamente desconectado
del cliente, con datos sintéticos.**

Es la partida que explica a las demás. Siete pendientes de `PENDINGS.md` más #163 y #164 existen solo
porque **no hay dónde medir lo que toca Fabric** — el único banco es el QA del cliente. La
consecuencia ya está publicada: **#163 salió en 0.16.0 con su mecanismo central sin medir.**

Lo descartado, que es lo que se va a volver a proponer: apoyarse en la plataforma de Grupo Hijuelas
para copiar sus datos. Un terreno que copia datos del cliente **deja de ser propio**, acopla el banco
a su esquema y no quita la dependencia. El arnés mide **formas**, no datos.

**El costo dejó de ser el argumento** (verificado 2026-08-14): una capacidad Fabric se **pausa** y
pausada no factura cómputo; F2 pay-as-you-go va del orden de **US$0,36/h** — una sesión de medición
cuesta cerca de un dólar. **Trial NO**: 60 días y al vencer se lleva los items no-PowerBI.

## La ventana de terreno vivo (hoy, del cliente; mañana, propia)

Sigue pendiente y es la que decide si la capacidad de #163 sirve. Encender `vm-vergis-qa` —la VM de
pruebas, **desasignada por defecto**, `az vm start -g rg-arbol-qw04 -n vm-vergis-qa`, ~1 min— contra
`ws-arbol-qa` —el workspace Fabric de QA, snapshot de datos reales de Árbol, capacidad Trial—, medir,
apagar.

**Las cuatro preguntas, en orden de consecuencia:**

1. **¿El Service Principal de serving tiene `UNMASK`?** Manda. Si **no** lo tiene, la rama «en claro»
   de la vista de máscara lee la columna base y recibe igual el default del DDM: **ni el sujeto con el
   claim ve el valor**, y la capacidad queda degradada a «esta columna no se sirve a nadie».
   **Control obligatorio, misma sesión:** una consulta a la tabla **sin** vista. Sin él, un negativo no
   distingue «no tiene el permiso» de «la vista no se aplicó».
2. **¿Fabric acepta el DDL de la vista de máscara y del `ADD MASKED`** sobre una tabla que ya tiene
   vista-contrato `SCHEMABINDING`? La instancia las usa: no es hipotético.
3. **#164 — ¿acepta un `ADD FILTER PREDICATE` cuya función NO recibe ninguna columna?** Y si no, ¿con
   un parámetro alimentado por constante? **Registrar el error exacto**: «sintaxis inválida» y «no
   soportado en este SKU» llevan a caminos distintos. **Control obligatorio:** la forma **actual**
   (función con columna) tiene que pasar en el mismo terreno y la misma sesión.
4. El **costo de enforcement por columna**, de paso.

**Sobre el gasto, corregido el 2026-08-14:** la versión anterior de este archivo decía «encender el QA
cuesta plata» a secas, y eso lo hacía sonar más pesado de lo que es. El gate **no es el tamaño de la
factura** —es modesto— sino que **el gasto es decisión de César cualquiera sea su tamaño**, y que esa
infraestructura vive en el tenant del cliente.

**Si la medición dijera que el SP tiene `UNMASK` y aun así la vista no discrimina, #163 se reabre** —
así quedó escrito en su comentario de cierre.

**Contexto para arrancar en frío:** el runbook está en la skill `mira-ops` —que se ejecuta **con el
sombrero de operador**, desde el repo del lab, no desde acá—; el `RESOURCES.md` autoritativo y el
compose viven en `clientes/ratio/hijuelas/arbol/lab/`.

## Normas que cambiaron esta sesión — no re-litigarlas

Las cuatro se decidieron el 2026-08-14 y están escritas donde se cargan solas. Si algo de esto
«parece» distinto en el `git log`, gana la norma:

| Norma | Dónde vive |
|---|---|
| **Rama + PR siempre** (nunca commit directo de código en `main`); la historia del repo **no** la deroga | `CLAUDE.md` · skill `git-repo-management` |
| **La frontera Producto↔operador**: publicamos versión + changelog + aviso; el deploy es del operador | `CLAUDE.md` · `DECISIONS.md` D-28 · preámbulo del `CHANGELOG.md` |
| **El cierre del issue es nuestro** — el autor reabre si no correspondía. Jamás lo de un tercero, y el cierre no afirma más de lo medido | `CLAUDE.md` · skill `ww:repo` (Paso 6) |
| **El esquema admite Z** (corrección sin capacidad nueva) | `DECISIONS.md` D-29 · preámbulo del `CHANGELOG.md` |
| **El experimento lo corre quien publica**; la operación de un tercero corrobora, jamás mide por nosotros | Ley, **Norma 7** · corolario «quién corre el experimento» |

## Lo que espera a César (no lo mueve nadie más)

- **La ventana de terreno vivo** (arriba) y, detrás, **#186**.
- Los dos actos de QA: **`VERGIS_CSRF_SECRET`** y los **permisos del SP** sobre dos items del motor.
- El **ojo humano** al header del theme `default`.
- **Publicar `CONTRIBUTING.md`**: renombrar el `.draft.md` *es* el acto de publicación, y la ventana
  del dual licensing se cierra con el primer PR externo sin acuerdo.

## Lo que espera al reloj

**PR #175** (digest de `caddy:2`): `test` ✓ `review` ✓, solo cuelga `renovate/stability-days`. Cuando
el cooldown de 14 días lo libere, mergea directo. **No se salta.**

**Sin verificar todavía**: que la regla de `renovate.json` gane sobre el preset `docker:pinDigests`.
La señal es que Renovate **no** vuelva a abrir `renovate/ghcr.io-gegolabs-vergis-latest`.

## Registro que quedó falso y no se corrigió

Dos fichas de `PENDINGS.md` que el terreno ya desmintió. Son ediciones de registro, no trabajo:

- **«La proyección guardada del contrato NO es estable»** dice *«la causa NO está medida»*. **Ya no**:
  se midió y se corrigió en 0.16.1 (abajo). Marcarla resuelta.
- **«`dotclaude` con cambios sin sellar»** enumera dos residuos. **El árbol de `~/.claude` está
  limpio**: las sesiones dueñas sellaron lo suyo y `/label` se retiró en `59d22c0`.

## Terreno ya recorrido — no reintentar

- **Esperar el despliegue del cliente para medir algo nuestro.** Es lo que decía el pendiente de #139
  y estaba mal escrito: la medición era **local**. La causa resultó ser que la observación del boot
  corría **antes** de registrar los watches, y como `env.reloadableContent` se **deriva** de ellos, el
  contrato persistía `VERGIS_POLICIES` como `bootOnly` — «reiniciá» cuando ya no hacía falta, el error
  de costo asimétrico que #139 existe para matar. Arreglado en 0.16.1 sin depender del orden: una
  declaración tardía re-observa sola.
- **Subproceso para aislar el render Vega** — descartado con medición: el permission model de Node 22
  **no cubre la red** (bloquea fs y `child_process`; `net.connect` conecta). La E/S se cerró con gate
  declarativo + loader que niega. Si algún día hace falta, la red se cierra **en el contenedor**.
- **Migrar los specs del canon a `docs/`** — no se hace: el libro es **GNU FDL v1.3** y no mezcla con
  la AGPL de este repo. Se cita, no se copia (`docs/canon.md`).
- **Enmascarar en ClickHouse** — no hay dónde: ese back-end no controla la proyección. Declara la
  capacidad no soportada y no sirve el PI.
- **Reconocer la vista de máscara por el prefijo `vw_mask_`** — descartado: falsificable por
  cualquiera con `CREATE VIEW`. El reconocimiento exige corroboración en `sys`.
- **Worktrees para paralelizar subagentes en este repo** — no sirven tal cual: un worktree nuevo no
  trae `node_modules` y los gates no corren. El reparto que funcionó fue por **conjuntos de archivos
  disjuntos**, con los ejecutores sin tocar git y el orquestador integrando.

<!-- retome escrito a mano · 2026-08-14 12:46 -04 · HEAD b163aa7 · sesión: #178, 0.16.0/0.16.1, fix de #139, las cuatro normas y #186 -->
