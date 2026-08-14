# Terreno T-SQL local — el arnés que no pide permiso a nadie

> Motor real, local y gratis para medir la **semántica T-SQL** que el compilador Fabric da por
> supuesta. **No es Fabric** y no lo reemplaza: lee «Qué contesta y qué no» antes de citar un
> resultado de acá.

## Para qué existe

La Norma 7 de la práctica pide que un mecanismo no se publique sin el experimento que lo pone en
riesgo, y su corolario dice que **ese experimento lo corre quien publica**. El plano de columna de
#163 se publicó en 0.16.0 sin ese experimento, por una razón que parecía definitiva: *no hay dónde
medirlo*. Resultó ser falsa para una buena parte de las preguntas — el compilador emite **T-SQL**, y
un motor T-SQL cabe en un contenedor.

Lo que este arnés cambia no es el acceso a Fabric: es que **la excusa dejó de aplicar** para todo lo
que sea semántica del lenguaje.

## Cómo se corre

```bash
npm run lab:up      # SQL Server 2022 en Docker (amd64; en Apple Silicon corre emulado)
npm run lab:proof   # la prueba
npm run lab:down    # y a otra cosa
```

No entra en `npm test`: la suite es hermética y sin Docker. Es prueba de aceptación bajo demanda,
igual que `live-rls-proof.ts` para ClickHouse.

## Qué contesta y qué no

| | Lo contesta este arnés | Solo lo contesta Fabric (#186) |
|---|---|---|
| **Semántica del lenguaje** — DDM, `UNMASK`, `SECURITY POLICY`, `SCHEMABINDING`, `SESSION_CONTEXT` y su interacción | ✅ | |
| **Formas del DDL** — si una sentencia que emitimos es válida y qué error exacto devuelve si no | ✅ | |
| **El emulador** que sostiene la suite, contrastado contra un motor | ✅ | |
| Si el **SKU de Fabric** acepta cada DDL | | ✅ |
| Qué permisos tiene el **Service Principal** de una instancia | | ✅ |
| **Costo** de enforcement, plano de control, OneLake, jobs | | ✅ |

**La asimetría que hay que respetar al citar:** un **negativo** de acá refuta para toda la familia
T-SQL —si el motor rechaza la forma, Fabric no la va a aceptar por ser Fabric—; un **positivo** de
acá **no garantiza** Fabric, que restringe su superficie. Confundirlas es exactamente el error que la
Norma 7 persigue.

## El principio que no se negocia

**El arnés usa el DDL que emite `compileFabric`, nunca SQL escrito a mano para la ocasión.** Un
arnés con su propio SQL se mide a sí mismo: pasaría en verde mientras el Producto emite otra cosa.
Por eso el script importa el compilador y aplica `enforcement.setupSQL` tal cual sale.

Los datos son **sintéticos** y viven en el script. El terreno se **recrea** en cada corrida (la base
se tira y se vuelve a levantar): si el script no puede levantarlo desde cero, el script está
incompleto.

## Cómo se lee la salida

- `✓` / `✗` — una **aserción**: algo que tenía que pasar, y pasó o no.
- `◆` — un **hallazgo**: una respuesta que el terreno da y que había que registrar. No es un fallo.

Cada pregunta trae **su control**, y los controles son la mitad del valor: sin la consulta a la tabla
sin vista, un negativo en la vista de máscara no distingue «al principal le falta el permiso» de «la
vista no se aplicó». Sin el control positivo de la forma actual, un rechazo de la forma nueva no
distingue «esta forma no se acepta» de «acá no anda nada».

---

• *Generado con Wingworking*
