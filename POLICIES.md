# POLICIES — Vergis

> **Qué es.** Las **autorizaciones permanentes** que César declaró para que el agente actúe sin
> consultarlo. No es método —eso es `CLAUDE.md`— ni inventario —eso es `RESOURCES.md`—: es el
> instrumento que responde **«¿hasta dónde puedo actuar solo?»**.
>
> **Quién lo escribe.** Solo César. Una autorización que el agente se redacta a sí mismo no es una
> autorización, y por eso este archivo es el único canónico donde el agente **propone y no dispone**:
> puede sugerir una política, no darse una. Lo que el agente sí escribe es el **contador**
> (`POLICIES-ledger.md`), que es otro archivo justamente para que se vea de un vistazo qué declaró
> él y qué anotó el agente.
>
> **Cómo se consume — la regla que le da sentido:** **un acto que cae dentro de una política
> declarada NO se consulta.** Consultarlo no es prudencia: es devolverle un trámite y erosionar la
> autorización hasta volverla decorativa. La regla vale al revés con la misma fuerza — **fuera del
> techo se detiene y se pide**, no se ejecuta y se avisa después.

## Políticas vigentes

| ID | Política | Techo | Ventana | Vigencia |
|--|--|--|--|--|
| **POL-01** | **Uso de recursos externos con costo** — el agente contrata, enciende, consume y paga recursos externos necesarios para el trabajo del Producto, sin consultar, mientras el gasto quede bajo el techo | **US$50 / mes** (pote, cualquier recurso) · **US$10 por acto** individual | Mensual, calendario: el pote repone el día 1 y **no acumula** — lo no gastado se pierde | Hasta revocación · declarada **2026-08-18** |

### POL-01 — la letra chica que la vuelve operable

**Los dos techos son conjuntivos:** un acto pasa si cabe en el pote **y** cabe en el techo por acto.
Un acto de US$12 sube a decisión aunque el pote esté intacto; cinco actos de US$10 con US$45 ya
gastados también.

**El gasto se acota ANTES.** Si el costo de un acto no se puede acotar por arriba antes de
ejecutarlo, **no está cubierto** — un gasto que no se puede estimar no cabe bajo ningún techo, y
«resultó más caro de lo que pensé» es exactamente el modo de falla que el techo existe para impedir.
Después se **mide** lo real y se asienta lo medido, no lo estimado; si lo medido supera lo estimado,
se asienta igual y se reporta en el mismo acto.

**Un acto que crea obligación recurrente NO es un acto de su primer mes.** Una suscripción de
US$8/mes no es un gasto de US$8: es un compromiso sin fondo, y ninguna política lo cubre. Va a
decisión de César, aunque la primera factura quepa en el pote.

**Lo que este presupuesto NO levanta.** Cubre **el gate de gasto y nada más**. Siguen intactos,
sobre cualquier monto:

| Sigue siendo de César | Por qué el dinero no lo compra |
|---|---|
| Infra, cuentas o terreno **del operador o del cliente** | El gate ahí nunca fue la plata, sino la autoridad sobre lo ajeno (`CLAUDE.md` §«La frontera») |
| **Comunicación saliente** a un tercero | Su voz y su relación, no un recurso |
| Lo **irreversible sin respaldo recuperable** | Constitución, Procedimiento 3 |
| **Secretos** — emitir, rotar, extraer credenciales | Su custodia |
| Lo que **él ya decidió distinto** | Una política delega hacia adelante; no revoca sus juicios de atrás |

**Ejemplo que fija la frontera, con datos reales del proyecto:** encender la capacidad F2 del
**terreno propio** (US$0,36/h, ≈US$1 por sesión de medición) entra bajo POL-01 y se corre sin
preguntar. Encender o tocar capacidad en el tenant **del cliente** no entra jamás, cueste lo que
cueste.

## El contador

El consumo se asienta en **`POLICIES-ledger.md`** — una fila por gasto, con fecha, monto medido,
para qué y contra qué política. **Nace con el primer gasto**, no antes: un ledger vacío creado por
completitud es ruido.

Un presupuesto sin contador es un permiso ilimitado con cara de límite: **no medir no es gastar
cero.** Si el ledger no se pudo escribir, el acto se reporta igual y se dice que el asiento falta.

## Revocación y cambio

Una política se revoca o se cambia **por acto de César**, editando este archivo. La fila revocada
**no se borra**: se marca revocada con su fecha — saber que algo estuvo autorizado explica actos del
pasado que de otro modo se leen como excesos. Los IDs `POL-NN` son de pool propio y **jamás se
reusan**. Próximo disponible: **POL-02**.

**Los presupuestos no se heredan ni se suman.** Si `~/.claude/POLICIES.md` declara un pote
transversal y este archivo declara uno para Vergis, rige el de Vergis **para Vergis** — no se suman.
Un techo que se suma deja de ser techo.

---

• *Generado con Wingworking*
