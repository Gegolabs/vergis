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

**Mes en curso: 2026-08.** Pote US$50 · **gastado US$0,24** · disponible **US$49,76**.
El pote repone el día 1 y no acumula.

| Fecha | Acto | Recurso | Medida | Monto | Asentado por |
|--|--|--|--|--|--|
| 2026-08-18 | Ventana de medición de #197 — verificar contra el SKU la vista de máscara que **emite el compilador** tras el rediseño a la forma C2 | Capacidad Fabric **F2** `vergisfablab` (tenant ultraBASE) | ~4 min encendida (dos tramos: 18:46–18:47 y 18:47:16–18:48:20), US$0,36/h | **US$0,02** | Simón Alero |
| 2026-08-18 | Ventana de medición de #164 — el allow-all **emitido** y el `ALTER` que antes se rechazaba. Dos tramos porque el primero midió mal por un defecto del arnés (`admin.close()` antes de P8) y el instrumento lo reportó como fallo en vez de darlo por verde | Capacidad Fabric **F2** `vergisfablab` | 1m47s + 1m51s = ~4 min encendida, US$0,36/h | **US$0,02** | Simón Alero |
| 2026-08-19 | Ventana para responder **P5 (#163)** — qué ve el service principal de serving con el DDM aplicado, ya con `FAB_SP_TOKEN` disponible. **Cuatro tramos, y tres de ellos no midieron**: el útil (`fab:proof` completo, P5 respondida), dos abortados por defectos del script de sonda (top-level `await` con salida CJS; `mssql` no resuelve fuera del árbol del repo) y uno de diagnóstico cuyo **control positivo falló** — sin el prelude de `SESSION_CONTEXT` la row policy deniega todo. Se asienta el total, no solo el tramo que sirvió | Capacidad Fabric **F2** `vergisfablab` | ~7 min encendida sumando los cuatro tramos, US$0,36/h | **US$0,04** | Simón Alero |
| 2026-08-19 | **Experimento del rol** — qué destraba la propagación de un cambio de rol de workspace al plano de datos, sondeando por tres vías (misma conexión · conexión nueva con token viejo · conexión nueva con token nuevo) sin tocar DDL. Refutó la hipótesis del token cacheado, acotó la asimetría conceder/revocar y **detectó que el veredicto de P5 de la mañana era falso** | Capacidad Fabric **F2** `vergisfablab` | ~10 min encendida (13:47–13:57), US$0,36/h | **US$0,06** | Simón Alero |
| 2026-08-19 | Intento de medir la discriminación de la vista **como el SP** (#238). **No midió**: el control de premisa detectó que la staleness de la revocación de rol seguía viva 20 min después y **se negó a concluir**. Dos tramos: uno donde la conexión no levantó tras el `resume`, otro donde el control abortó. La pregunta se respondió después **gratis**, en el arnés local, fabricando un usuario sin `UNMASK` | Capacidad Fabric **F2** `vergisfablab` | ~4 min encendida (14:08–14:09 · 14:11–14:13), US$0,36/h | **US$0,02** | Simón Alero |
| 2026-08-19 | Medición del **DDL del centinela de #238 contra el SKU** — que las 3 sentencias emitidas se acepten, sean idempotentes, el descubrimiento las encuentre y `sys` corrobore la máscara, con control positivo del instrumento. Corrida **después** del tag de 0.21.0: el orden estuvo mal y consta en `PENDINGS.md` | Capacidad Fabric **F2** `vergisfablab` | ~3 min encendida (22:31–22:34), US$0,36/h | **US$0,02** | Simón Alero |

| 2026-08-19 | **E3/E4/E5 de #238** — cerrar los tres experimentos que 0.21.0 publicó como «sin medir». **Dos ventanas.** La primera: E5 murió en el arranque porque el runner no le exportó `FAB_SP_TOKEN` (lo exige pre-obtenido, a diferencia del script de E3), y E3 respondió en negativo — el SP **no tiene principal propio en la BD** y Fabric rechaza `CREATE USER … FROM EXTERNAL PROVIDER`, así que E4 quedó sin medir por depender de E3. La segunda ventana corrigió el token y agregó **E3-bis**, la escalera contra `public` que la primera no probó por filtrar los roles de la consulta de recon: **`GRANT UNMASK ON <tabla>(<columna>) TO [public]` se acepta, surte efecto, la vista discrimina y el revoke se verificó en el plano de datos** (issue #245). E5 quedó verde | Capacidad Fabric **F2** `vergisfablab` | ~3 min (01:29–01:32 UTC) + ~4 min (01:32–01:36 UTC) ≈ 7 min, US$0,36/h | **US$0,04** | Simón Alero |

| 2026-08-19 | **Verificación de P9 y P10** — los dos sondeos nuevos del arnés (el control de premisa con la discriminación como el SP, y el centinela) corridos contra el SKU **con sus predicciones escritas antes de medir**. Salieron las siete: premisa `enmascarado` coincidiendo con el rol declarado, control negativo verde (0/2 celdas con el valor real ni con el claim), las 3 sentencias del centinela aceptadas, idempotencia en 1 fila tras dos pasadas, descubrimiento y `sys` corroborando, control positivo del instrumento (el admin lee el valor esperado) y retiro verificado leyendo. `26 hallazgos · 0 sin medir · exit 0` | Capacidad Fabric **F2** `vergisfablab` | ~4 min encendida (01:59–02:03 UTC), US$0,36/h | **US$0,02** | Simón Alero |

### Cómo se mide este recurso

La capacidad F2 factura **por hora encendida** (US$0,36/h) y está **pausada por defecto**. El monto
de cada fila es el tiempo real entre `fab:resume` y `fab:pause`, no la duración de la sesión de
trabajo. La pausa va en un `trap EXIT/INT/TERM`: se apaga aunque el script reviente o lo maten —
acordarse no es un mecanismo.

**Un tramo se pasó de la ventana prevista y el `trap` no lo apagó** (2026-08-19): el experimento del
rol excedió el timeout de 10 min de la herramienta que lo corría, y al morir el proceso por SIGTERM
externo la pausa del `trap` no alcanzó a ejecutarse. Se detectó y se pausó a mano en el minuto
siguiente. **El `trap` protege contra que el script reviente, no contra que lo maten desde afuera** —
un experimento con sondeo largo se parte en tramos que quepan en la ventana del ejecutor, o se corre
en background con su propio vigilante.

---

• *Generado con Wingworking*
