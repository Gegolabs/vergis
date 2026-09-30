# Changelog — plugin `custos`

El plugin tiene **la versión del Producto** (lockstep: `plugin.json` sigue a `package.json`, y el
marketplace lo fija al tag `vX.Y.Z`). Lo que el operador consume de cada versión está en el
`CHANGELOG.md` de la raíz del repo; este archivo registra lo que es **del plugin**.

## Sin publicar

Nace el plugin (#387, diseño `lab/work/288`): gobernar el dato de una instalación —quién ve qué dato,
quién pertenece a qué grupo, quién responde por qué dato—, que tiene dueño propio y no es el operador
de la plataforma. Depende de `vergis`, que trae el CLI `vergis-ops` y la declaración de la instalación.

- **Cuatro skills**: `custos:compile` · `custos:validate` · `custos:enforce` · `custos:verify`. No hay
  `specify`: crear una política es decisión del dueño del gobierno del dato, y `custos` compila lo que él
  decidió.
- **`enforce` hace valer la política en sus dos puntos**: en el nodo (políticas, grupos, mapa de
  identidad, dominios, fuentes y dueños de PI, con `vergis-ops publish`, clase `content`) y en la fuente
  (el DDL aceptado).
- **Lo que responde sin soporte del Producto** (#390, las herramientas de Custos en el Producto):
  `compile` → «no pude compilar desde el YAML»; `validate` → «no pude medir»; `enforce` en la fuente →
  «no pude aplicar en la fuente». `verify` mide la RLS por identidad con `smoke --rls` y el drift
  declarado↔nodo con `parity`; el drift nodo↔fuente, «no medido». Sin `rls_checks` declaradas: «RLS no
  verificada», nunca «RLS bien».

• *Generado con Wingworking*
