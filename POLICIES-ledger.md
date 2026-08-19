# POLICIES-ledger — el contador de lo autorizado

> **Qué es.** El registro de **lo gastado** bajo las políticas de [`POLICIES.md`](POLICIES.md). Una
> fila por acto, con el monto **medido** —no el estimado—, para qué fue y contra qué política corre.
>
> **Quién lo escribe.** El agente. Es la contraparte de `POLICIES.md`, que solo escribe César: la
> separación en dos archivos existe para que se vea de un vistazo qué **declaró** él y qué **anotó**
> el agente.
>
> **Por qué existe.** Un presupuesto sin contador es un permiso ilimitado con cara de límite: **no
> medir no es gastar cero.** Si un asiento no se pudo escribir, el acto se reporta igual y se dice
> que el asiento falta.

## POL-01 · Recursos externos con costo — US$50/mes, US$10 por acto

**Mes en curso: 2026-08.** Pote US$50 · **gastado US$0,08** · disponible **US$49,92**.
El pote repone el día 1 y no acumula.

| Fecha | Acto | Recurso | Medida | Monto | Asentado por |
|--|--|--|--|--|--|
| 2026-08-18 | Ventana de medición de #197 — verificar contra el SKU la vista de máscara que **emite el compilador** tras el rediseño a la forma C2 | Capacidad Fabric **F2** `vergisfablab` (tenant ultraBASE) | ~4 min encendida (dos tramos: 18:46–18:47 y 18:47:16–18:48:20), US$0,36/h | **US$0,02** | Simón Alero |
| 2026-08-18 | Ventana de medición de #164 — el allow-all **emitido** y el `ALTER` que antes se rechazaba. Dos tramos porque el primero midió mal por un defecto del arnés (`admin.close()` antes de P8) y el instrumento lo reportó como fallo en vez de darlo por verde | Capacidad Fabric **F2** `vergisfablab` | 1m47s + 1m51s = ~4 min encendida, US$0,36/h | **US$0,02** | Simón Alero |
| 2026-08-19 | Ventana para responder **P5 (#163)** — qué ve el service principal de serving con el DDM aplicado, ya con `FAB_SP_TOKEN` disponible. **Cuatro tramos, y tres de ellos no midieron**: el útil (`fab:proof` completo, P5 respondida), dos abortados por defectos del script de sonda (top-level `await` con salida CJS; `mssql` no resuelve fuera del árbol del repo) y uno de diagnóstico cuyo **control positivo falló** — sin el prelude de `SESSION_CONTEXT` la row policy deniega todo. Se asienta el total, no solo el tramo que sirvió | Capacidad Fabric **F2** `vergisfablab` | ~7 min encendida sumando los cuatro tramos, US$0,36/h | **US$0,04** | Simón Alero |

### Cómo se mide este recurso

La capacidad F2 factura **por hora encendida** (US$0,36/h) y está **pausada por defecto**. El monto
de cada fila es el tiempo real entre `fab:resume` y `fab:pause`, no la duración de la sesión de
trabajo. La pausa va en un `trap EXIT/INT/TERM`: se apaga aunque el script reviente o lo maten —
acordarse no es un mecanismo.

---

• *Generado con Wingworking*
