# Changelog — plugin `mira`

El plugin tiene **la versión del Producto** (lockstep: `plugin.json` sigue a `package.json`, y el
marketplace lo fija al tag `vX.Y.Z`). Lo que el operador consume de cada versión está en el
`CHANGELOG.md` de la raíz del repo; este archivo registra lo que es **del plugin**.

## 0.42.0 — 2026-09-30

Nace el plugin (#387, diseño `lab/work/288`): el ciclo del spec de un Producto de Información del
Botlet Mira, un proto-Botlet del catálogo que otra instalación puede no usar. Depende de `vergis`, que
trae el CLI `vergis-ops` y la declaración de la instalación.

- **Cinco skills**: `mira:compile` · `mira:specify` · `mira:validate` · `mira:specialize` · `mira:status`.
  Los verbos `specialize`, `status`, `activate`, `deactivate` y `retire` son los del canon para el ciclo
  de vida de un Botlet.
- **`compile` y `specify` usan el motor de Miranda, no lo copian**: ninguna skill escribe specs con el
  conocimiento propio del agente.
- **Lo que responde sin soporte del Producto:** `compile` → «no disponible» mientras Miranda no acepte
  documentos (#389); `specify` exige Miranda encendida en el nodo y, si no, lo dice; `validate` valida en
  local —esquema del DSL del tag que corre, `database_ref` declarados, render local contra el dato y
  marcas con su corrida discriminante— y sella el veredicto en `mira-veredictos.jsonl`, junto a
  `vergis-ops.json`, mientras el nodo no exponga el punto de validación (#388); `specialize` se niega a
  publicar un sha sin veredicto «acepta»; `status` responde «no disponible» a `activate`, `deactivate` y
  `retire` hasta que el Producto defina qué significan para un PI (#392).

• *Generado con Wingworking*
