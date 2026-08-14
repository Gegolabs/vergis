# NEXT — Vergis

PROD corre **0.15.0** y está sano. Suite en **1882 tests**, typecheck y build verdes. Árbol limpio.

La sesión del 2026-08-13 cerró tres tandas: **Renovate** (causa raíz curada) y **la observabilidad
del intake** (#161/#162) en la primera; **el pasivo trabajado con mandato** en la segunda — el pin de
nuestra imagen, `~/evals-finaliza/` versionado, la marca decidida, el frente de authz.

## Lo primero: un PR esperando el cooldown

| PR | Estado | Qué es |
|----|--------|--------|
| #175 | `test` ✓ `review` ✓, `stability-days` **pendiente** | Digest de `caddy:2` en el compose de referencia. |

Cuando el cooldown de 14 días lo libere, mergea directo. **No se salta**: ese control es la razón de
ser del arnés de Renovate. (#176 se cerró: era el bump del pin que se retiró.)

## El pin de nuestra propia imagen — DECIDIDO (2026-08-13, César): se quita

`deploy/compose.reference.yml` vuelve al tag móvil `ghcr.io/gegolabs/vergis:latest`, con la regla en
`renovate.json` que impide al preset `docker:pinDigests` re-pinearla sola (`pinDigests: false` +
`enabled: false` para ese paquete). El cooldown queda intacto donde importa: las imágenes de terceros.

**Queda por verificar, y solo lo dirá una corrida**: que la regla gane sobre el preset. La señal es
que Renovate **no** vuelva a abrir `renovate/ghcr.io-gegolabs-vergis-latest`. Aplicado en `9beeda8`;
#176 cerrado por quedar sin objeto.

## Gates de despliegue que este trabajo dejó pendientes

Ninguno se puede medir sin terreno; **simularlos produciría la evidencia falsa que estos frentes
existen para evitar**. Levantarlos en el próximo despliegue a QA:

- **C6 — drenar un landing real deja el directorio existente**: `listOrAbsent` debe dar `ok` vacío,
  **no `absent`**. Acotado desde el código (ningún camino de Vergis borra el directorio; retiro y
  reversión hacen `remove` del archivo), pero la semántica de OneLake no se mide desde acá.
  **Si un landing vaciado devuelve `absent`, el control del directorio se retira.**
- **C7 — ningún `slots.yaml` de instancia trae hoy una clave `watch:` inerte** que el parse nuevo
  empezaría a interpretar. Verificado que **este** repo no tiene ningún YAML con `slots:`; los de
  instancia viven en el repo del lab. Un `grep -n 'watch:'` antes de subir basta.
- **Los dos supuestos del intake contra motor vivo**: que un job que muere antes de arrancar aparezca
  como `Failed` en `jobs/instances`, y que la correlación carga↔corrida aguante el desfase de reloj
  del motor (**no lleva margen**: con el reloj adelantado una carga real podría marcarse `varada`).
- Siguen abiertos los **gates manuales del 0.14.0** en `TODO.md`, que nunca se corrieron.

## El frente de authz — diseñado el 2026-08-13, con orden declarado

`work/010-cluster-authz-2026-08-13/` tiene el diseño de los cuatro issues, que son **cuatro caras de
una pregunta**, no cuatro pedidos. Lo construido y lo que falta:

| Issue | Estado |
|---|---|
| **#165** | §1 y §3 **construidos** (`07271b5`): el claim es un **conjunto** —declarado en el IR y el README— y la negación por cardinalidad **dejó de ser muda** (`packages/policy/src/diagnose.ts`, con `deniesAllRows` afirmado como teorema sobre el oráculo). §4 se decide dentro de #159 |
| **#164** | **Mitigado, no resuelto** (`bc64922`): `FabricEnforcement.schemaDependencies` vuelve legible la dependencia que `SCHEMABINDING` crea. Los caminos 1 y 2 esperan **una medición en QA**, que está en `PENDINGS.md` con su control obligatorio |
| **#163** | **Diseñado** con sus cinco decisiones resueltas y 5 hitos. **No se construye antes de #165 §4 y #159** |
| **#159** | **Diseñado** en su encaje. Es el siguiente del frente |

**El orden no es el de apertura, y es la parte que no se puede saltar:** #165 y #159 definen al
sujeto; #163 define qué se le sirve. Construir la granularidad fina antes de cerrar el modelo del
sujeto es construir sobre una definición pendiente — y ese error no se cae, se propaga.

### El siguiente: #159 — el mapa identidad→claims se administra desde la plataforma Hoy vive en un archivo del
host que se genera fuera, se sube, y se lee **solo al arrancar**: nadie lo ve desde la plataforma,
corregirlo obliga a reiniciar, y cada regeneración borra las cuentas que no vienen de la fuente
autoritativa (típicamente la de operación). Es la única pieza del gobierno que no se administra —
las políticas de datos ya se recargan en caliente, esta no.

⚠️ **El «44 personas pierden acceso» que este archivo arrastraba NO está verificado**: el issue no
menciona cifra alguna y `P-22` no existe en este árbol (sería del repo del lab). Es una cadena de
citas que ganó autoridad sin que nadie volviera a medirla. **Comprobarlo antes de usarlo para
priorizar.**

Y lo que el diseño le agregó a este issue: **la procedencia por entrada es lo que hace revisable
todo lo demás** —sin ella la regeneración borra los overrides, que es el defecto reportado— y admite
un **tercer valor**, `autoritativa ambigua`, que es donde cae el §4 de #165 (la persona con doble
ficha activa). Con eso «ninguna» deja de ser un hueco.

## Lo que estos dos frentes dejaron como método

Vale más que el código, y es la misma lección en dos planos: **un instrumento que no distingue «no
ocurrió» de «no lo registré» fabrica conclusiones tan falsas como las afirmaciones que pretende
corregir.**

- El `renovate-config-validator` **verifica forma, no semántica**: acepta valores que la corrida
  rechaza. Correrlo es obligatorio; pasarlo no es prueba.
- Contar ocurrencias en un log **cuyo nivel no las imprime** «refutó» una causa verdadera.
- Medir el lockfile **con un solo npm** exoneró tres días a la variable culpable. **Un experimento
  que no varía la variable sospechosa no la exonera: la ignora.**
- Un `grep` sobre un log puede contar **los propios comentarios que describen el fenómeno** como si
  fueran el fenómeno.
- **Un test verde que nunca se vio fallar no es evidencia.** Dos ejecutores descubrieron que sus
  tests estaban tapados por un efecto lateral y los endurecieron.

De ahí la práctica que quedó instalada en el frente del intake y conviene sostener: **prueba por
mutación en cada hito, y re-verificación independiente al integrar**. Y su corolario honesto:
cuando un mutante sobrevive, la primera hipótesis es que el test es flojo; **declararlo equivalente
exige razón demostrada**.

## Lo demás abierto

En `TODO.md` y `PENDINGS.md`. De César: revisión legal de `CONTRIBUTING.draft.md` —renombrarlo **es**
publicarlo—, y la marca. Sin tocar: **#139**, **#113**, **#111**, **#110**.

<!-- /ww:next · 2026-08-13 · HEAD 7e9eb30 -->
