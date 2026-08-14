# NEXT — Vergis

PROD corre **0.15.0** y está sano. Suite en **2081 tests**, typecheck y build verdes, CI de `main`
verde, árbol limpio y pusheado.

El **frente de autorización quedó cerrado en código** el 2026-08-13: #163 (control por columna, nueve
hitos), #159 (administración del mapa identidad→claims) y #165 (el claim como conjunto + diagnóstico
de la negación). Diseño, estado por issue y los nueve hitos: `work/010-cluster-authz-2026-08-13/`.

**Nada de eso se corrió contra un motor vivo.** Lo verificado es el SQL emitido y sus emuladores
contra el oráculo. Ése es exactamente el próximo paso.

## Próximo paso

**Una sesión de QA que mida lo que decide si la capacidad de #163 sirve — y que de paso destranca
#164.** Son el mismo viaje: encender `vm-vergis-qa` contra `ws-arbol-qa`, medir, apagar.

**Las cuatro preguntas, en orden de consecuencia:**

1. **¿El Service Principal de serving tiene `UNMASK`?** Es la que manda. Si **no** lo tiene, la rama
   «en claro» de la vista de máscara lee la columna base y recibe igual el default del DDM: **ni el
   sujeto con el claim ve el valor**, y la capacidad queda degradada a «esta columna no se sirve a
   nadie» — segura, pero es la herramienta gruesa de la que #163 se queja.
   **Control obligatorio, en la misma sesión:** una consulta a la tabla **sin** vista. Sin él, un
   negativo no distingue «no tiene el permiso» de «la vista no se aplicó».
2. **¿Fabric acepta el DDL de la vista de máscara y del `ADD MASKED`** sobre una tabla que ya tiene
   vista-contrato `SCHEMABINDING`? La instancia las usa, así que la interacción no es hipotética.
3. **#164 — ¿acepta Fabric un `ADD FILTER PREDICATE` cuya función NO recibe ninguna columna** de la
   tabla? Y si no, ¿acepta un parámetro alimentado por constante? **Registrar el error exacto**:
   «sintaxis inválida» y «no soportado en este SKU» llevan a caminos distintos.
   **Control obligatorio:** la forma **actual** (función con columna) tiene que pasar en el mismo
   terreno y la misma sesión, o un fallo no distingue «Fabric no lo admite» de «el terreno estaba
   mal».
4. El **costo de enforcement por columna**, de paso.

**Contexto para arrancar en frío:** el runbook de la VM está en la skill `mira-ops`; el `RESOURCES.md`
autoritativo y el compose viven en el repo del **lab** de A.R.B.O.L. (`clientes/ratio/hijuelas/`), no
acá. Encender el QA **cuesta plata**: es acto de César, no del agente.

**Si la medición dijera que el SP tiene `UNMASK` y aun así la vista no discrimina, #163 se reabre** —
así quedó escrito en su comentario de cierre.

## Lo que espera a César (no lo mueve nadie más)

Sin cambios respecto de la vista de `/ww:work`: la ventana de terreno vivo (que incluye lo de
arriba), los dos actos de QA —`VERGIS_CSRF_SECRET` y los permisos del SP sobre dos items del motor—,
sellar sus cinco archivos de `dotclaude`, el ojo humano al header del theme `default`, y **publicar
`CONTRIBUTING.md`** (renombrar el `.draft.md` *es* el acto de publicación; la ventana del dual
licensing se cierra con el primer PR externo sin acuerdo).

## Lo que espera al reloj

**PR #175** (digest de `caddy:2`): `test` ✓ `review` ✓, solo cuelga `renovate/stability-days`. Cuando
el cooldown de 14 días lo libere, mergea directo. **No se salta.**

**Sin verificar todavía**: que la regla de `renovate.json` gane sobre el preset `docker:pinDigests`.
La señal es que Renovate **no** vuelva a abrir `renovate/ghcr.io-gegolabs-vergis-latest`.

## Terreno ya recorrido — no reintentar

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

<!-- /ww:finish · 2026-08-13 · HEAD d9cdc06 -->
