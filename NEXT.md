# NEXT — sin frente activo

> **El deploy de 0.15.0 a PROD se completó el 2026-08-11 22:21.** Este kit cumplió su función y se
> vacía a propósito: un kit de retome que describe trabajo ya hecho es peor que no tener kit —
> manda a ejecutar algo que ya ocurrió. El registro del deploy vive donde corresponde:
> `PENDINGS-done.md` (este repo) y `BITACORA.md` del lab (commit `778dd55`).

## Estado al cierre

| | |
|---|---|
| PROD (`vm-vergis`) | **0.15.0** · 8/8 PIs en 200 · `healthz ok:true phase:serving` |
| QA (`vm-vergis-qa`) | `deallocated` |
| Repo | `main` = `v0.15.0`, CI verde, 0 PRs abiertos |

## Lo primero que conviene mirar al retomar

1. **El deploy siguiente convierte una conjetura en hecho.** PROD ya sembró el journal del contrato
   (`delta.reason: "primer-registro"`, `boots: 1`). El **próximo** despliegue es el primero que
   puede exhibir un delta real — es el experimento que valida #139·N2 de punta a punta. Antes de
   correrlo, leer la partida abierta sobre la **inestabilidad de la proyección guardada**
   (`PENDINGS.md`): decide si el delta que salga es confiable.
2. **Dos issues nuevos sin tocar**: **#161** (la plataforma observa sus propias cargas) y **#162**
   (el fallo de una carga llega al usuario con la causa + contrato `_logs/`). Bajaron del lab.
3. **Un hand-off de un minuto sigue abierto**: el secret `RENOVATE_TOKEN`. Sin él, el cooldown de
   supply chain del ADR-001 **no está activo** y el workflow lo dice en rojo cada lunes.
4. **`CONTRIBUTING.draft.md` espera revisión legal.** Renombrarlo a `CONTRIBUTING.md` **es** el acto
   de publicación: desde ese momento la cláusula obliga a terceros.

## Para el próximo que abra una ventana de mantenimiento

El corte medido el 2026-08-11 fue de **10.511 ms**, contra los **7.391 ms** que cita la regla 17 bis
del lab. Dimensionar una ventana con la cifra de la ley se queda corto en ~3 s. **La causa del delta
no está medida** — no asumir que es «porque cambia la imagen»; eso es la hipótesis cómoda, no un
mecanismo demostrado. Y no medir nunca el corte por la duración del comando: `up -d` devolvió en
1.434 ms, que se equivoca por factor 7,3.

---

• *Generado con Wingworking*
