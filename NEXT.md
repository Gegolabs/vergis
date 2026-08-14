# NEXT — Vergis

PROD corre **0.15.0** y está sano. Dos frentes grandes cerrados el 2026-08-13: **Renovate** (causa
raíz curada) y **la observabilidad del intake** (#161 y #162, ambos cerrados, con 3 de sus 4
pendientes saldados). Suite en **1854 tests**, typecheck y build verdes. Árbol limpio.

## Lo primero: dos PRs esperando merge

| PR | Estado | Qué es |
|----|--------|--------|
| #176 | `stability-days` pendía el cooldown | Digest de **nuestra propia imagen**. Ver la decisión de abajo antes de mergear. |
| #175 | ídem | Digest de `caddy:2` en el compose de referencia. |

Si el cooldown de 14 días ya los liberó, mergean directo. **No se saltan**: ese control es la razón
de ser del arnés de Renovate.

## El pin de nuestra propia imagen — DECIDIDO (2026-08-13, César): se quita

`deploy/compose.reference.yml` vuelve al tag móvil `ghcr.io/gegolabs/vergis:latest`, con la regla en
`renovate.json` que impide al preset `docker:pinDigests` re-pinearla sola (`pinDigests: false` +
`enabled: false` para ese paquete). El cooldown queda intacto donde importa: las imágenes de terceros.

**Queda por verificar, y solo lo dirá una corrida**: que la regla gane sobre el preset. La señal es
que Renovate **no** vuelva a abrir `renovate/ghcr.io-gegolabs-vergis-latest`. Y **#176 queda sin
objeto** — es el bump de ese mismo digest: se cierra cuando esto llegue a `main`.

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

## El siguiente frente de producto

**#159 — el mapa identidad→claims se administra desde la plataforma.** Hoy vive en un archivo del
host que se genera fuera, se sube, y se lee **solo al arrancar**: nadie lo ve desde la plataforma,
corregirlo obliga a reiniciar, y cada regeneración borra las cuentas que no vienen de la fuente
autoritativa (típicamente la de operación). Es la única pieza del gobierno que no se administra —
las políticas de datos ya se recargan en caliente, esta no.

⚠️ **El «44 personas pierden acceso» que este archivo arrastraba NO está verificado**: el issue no
menciona cifra alguna y `P-22` no existe en este árbol (sería del repo del lab). Es una cadena de
citas que ganó autoridad sin que nadie volviera a medirla. **Comprobarlo antes de usarlo para
priorizar.**

Después: **#163** (control por columna; ganó peso — la doctrina de terreno ancho sellada en el lab
declara como único límite que no existe), **#164**, **#165**.

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
