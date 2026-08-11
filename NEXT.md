# NEXT — Desplegar 0.15.0 a PROD

> **Kit de retome.** Escrito para arrancar **en frío**, sin la conversación que lo originó.
> Estampado **2026-08-10 21:0x (-04)**. Si al leerlo `main` avanzó más allá de `v0.15.0`, este kit
> está rancio: re-derivar antes de ejecutar.

## El objetivo, en una línea

Subir el Producto **0.15.0** a la VM de producción `vm-vergis`. Todo lo demás ya está hecho: el
release está cortado y tagueado, la imagen publicada, y **el ensayo en QA salió limpio**.

## Estado verificado (2026-08-10 ~21:00)

| Dónde | Qué corre | Evidencia |
|---|---|---|
| Repo `vergis` | `main` = `ef5b25d`, tag `v0.15.0`, CI verde, 0 PRs abiertos | `git log`, `gh pr list` |
| Imagen | `ghcr.io/gegolabs/vergis:latest` y `:v0.15.0` publicadas | build del tag ✓ |
| **QA** (`vm-vergis-qa`) | **0.15.0** — 6/6 PIs en 200, `healthz ok:true phase:serving` | ensayo de esta sesión |
| **PROD** (`vm-vergis`) | **0.14.0** — 8/8 PIs sirviendo, sano | `healthz` consultado hoy |

⚠️ **QA quedó ENCENDIDA.** Si ya no hace falta: `az vm deallocate -g rg-arbol-qw04 -n vm-vergis-qa`.

---

## Las dos compuertas — ninguna se salta

### 1 · Ventana aprobada por César (Regla dura 17 bis del lab)

`docker compose up -d vergis` **recrea el contenedor y corta el servicio**. La regla es explícita en
que **el mandato autónomo NO la levanta**: *«es autoridad, no criterio»*, y el permiso de desplegar
tampoco, porque son ejes distintos — desplegar es entregar valor, interrumpir es quitarle el
servicio a otro. El gate protege **el derecho de otro a decidir cuándo**, no la duración.

Las **tres obligaciones**, ninguna opcional:

- **(a) Declarar el impacto ANTES**, nombrado por lo que es — «reinicio la plataforma completa», no
  «actualizo el Producto» — con **qué cae y por cuánto**:

  > Caen los **8 PIs** (`pi-01` `pi-02` `pi-04` `pi-07` `pi-12` `pi-15` `pi-16` `pi-17`) más
  > `/admin`, `/miranda` e `/impresiones`. Corte esperado: **~7,4 s** (medido 2026-08-10 con
  > instrumento declarado; el recreate del CSRF de esa tarde midió 6,6 s).

- **(b) César aprueba la ventana** — es quien sabe qué hay en UAT o en cotejo ahora mismo.
- **(c) Medir el corte** (`SIGTERM` → rutas sirviendo) y registrarlo en el `BITACORA.md` del lab.
  **No medirlo por la duración del comando**: `docker restart` devuelve `rc=0` en 375 ms y eso se
  equivoca por un **factor de 20**.

### 2 · Terreno del repo de la instancia

El deploy se frenó el 2026-08-10 porque `~/wworkspace/clientes/ratio/hijuelas/arbol/lab` tenía
**5 archivos modificados y 2 sin trackear de otra sesión** —incluido `RESOURCES.md`, fuente de
verdad del runbook— y dos cierres del mismo día sobre esa misma VM. Es **la ocurrencia 8 de W-01**.

```bash
cd ~/wworkspace/clientes/ratio/hijuelas/arbol/lab && git status --short && git log --oneline -3
```

**Árbol sucio ⇒ no se despliega**: se averigua de quién es y se espera a que selle. Un deploy sobre
un `RESOURCES.md` en vuelo es desplegar contra un mapa que alguien está redibujando.

---

## El procedimiento

**Sesión `az`**: tenant GH (`arboltec@grupohijuelas.com`). Verificar con `az account show` — si no,
nada de lo de abajo apunta a donde crees.

```bash
# 0 · RESPALDO + digest de rollback (ANTES de tocar nada)
az vm run-command invoke -g rg-arbol-qw04 -n vm-vergis --command-id RunShellScript --scripts '
  cd /opt/mira && cp compose.yml compose.yml.bak-$(date +%s)
  docker inspect --format="{{index .RepoDigests 0}}" ghcr.io/gegolabs/vergis:latest'

# 1 · PULL (no corta: solo baja capas)
az vm run-command invoke -g rg-arbol-qw04 -n vm-vergis --command-id RunShellScript --scripts '
  cd /opt/mira && docker compose -p mira pull vergis'

# 2 · EL CORTE (esto es lo que exige la ventana) — con el poller de medición corriendo
az vm run-command invoke -g rg-arbol-qw04 -n vm-vergis --command-id RunShellScript --scripts '
  cd /opt/mira && docker compose -p mira up -d vergis'
```

**Digest de rollback vigente al escribir este kit** (por si el paso 0 no se pudo correr):
`ghcr.io/gegolabs/vergis@sha256:7462a8263ebc8aac4a7a49b7083564eda202900fc217628945b0ff21fa87f8d7`

### Cómo medir el corte (obligación c)

Poller cada 25 ms **desde dentro de la red del contenedor**, con el predicado de salud **completo**
— `HTTP 200 ∧ phase=serving ∧ pis.serving=8`, jamás «responde». El corte es de `SIGTERM` hasta que
ese predicado se cumple, y su anatomía esperada es ~75 ms de proceso caído + ~7,3 s de arranque.

---

## Verificación

1. **Versión y salud**: `healthz` debe dar `ok:true, phase:serving, pis:{total:8,serving:8}` y el
   pie de los PIs decir `Vergis v0.15.0`.
2. **Smoke de los 8 PIs** con el script del lab, que **ya apunta a PROD** (`VM=vm-vergis` hardcodeado):
   ```bash
   cd ~/wworkspace/clientes/ratio/hijuelas/arbol/lab
   for s in pi-01 pi-02 pi-04 pi-07 pi-12 pi-15 pi-16 pi-17; do scripts/probe-vm-pi.sh $s; done
   ```
   Ojo: `az vm run-command` **se serializa**; el script ya trae el apareamiento petición↔respuesta
   (P-144) para eso. No paralelizar.
3. **Sin regresión**, dicho explícitamente antes de reportar.

---

## Lo que este deploy convierte en hecho (o refuta)

Cuatro afirmaciones viven hoy **etiquetadas como conjetura**. Este deploy es su experimento — y
merecen medirse, no darse por buenas:

| Conjetura | Cómo se mide | Predicción falsable |
|---|---|---|
| **Delta del contrato (#139·N2, D6)** | `GET /contrato` como admin | PROD **nunca corrió N2** ⇒ este deploy solo **siembra** (`delta.reason: "primer-registro"`). El delta real aparece en el **siguiente**. Verificado así en QA hoy (`boots: 1`) |
| **Reclasificación `bootOnly→reloadableContent` (#151)** | `GET /contrato` → `env` y `watches` | PROD declara `VERGIS_SOURCES` y `VERGIS_PI_OWNERS` en el compose ⇒ deben **aparecer como recargables y con watch**. Si siguen en `bootOnly`, la afirmación central de #151 falla acá |
| **Entrega HTTP real por sink recargado (#151)** | Editar el yaml del sink y observar la entrega | Exige Fabric cableado; es la línea del fan-out que en local es inspección, no medición |
| **`serve-rls → runSpec` con identidad del roster (#145)** | Requiere `MIRANDA_PREVIEW_IDENTITIES` poblado | **Hoy PROD no lo declara** ⇒ esta NO se verifica en este deploy. Decidir el roster es paso aparte |

**Ojo con la trampa:** que los 8 PIs den 200 **no** verifica ninguna de las cuatro. Verdes
corroboran; no argumentan.

---

## Lo que NO se toca en esta ventana

- **`GATE_SECRET` / `x-gate-token`** — medido el 2026-08-10 (D-99 del lab): **su emisor no existe**;
  ni Caddy ni oauth2-proxy lo inyectan. Definirlo daría **403 a todo** y rompería `probe-vm-pi.sh`.
  Es un corte total disfrazado de hardening. Vive en `P-176`, con ventana y prueba en QA propias.
- **`identity/aad-area-map.json`** — la VM sirve un respaldo, y está **determinado** cuál es el
  autoritativo. No se sube: recortaría de **136 a 92 bindings** y `arboltec` desaparecería del mapa.
  Quién pierde acceso y con qué aviso es decisión de negocio de César (`P-22`/`P-174a`, e issue
  #159 del Producto).
- **`VERGIS_CSRF_SECRET`** — ya aplicado en PROD el 2026-08-10. **Falta en QA.**

---

## Al terminar

- Registrar el corte medido y la ventana en el `BITACORA.md` del **lab**.
- Cerrar la partida «PROD sigue en 0.14.0» de `PENDINGS.md` de este repo, con egreso a
  `PENDINGS-done.md`.
- Apagar QA si quedó encendida.

## Rollback

`docker compose pull` del digest anterior + `up -d vergis` — **y es otro corte**, así que la ventana
debe cubrir ida y vuelta. Compose: re-subir el `.bak-<ts>` del paso 0.

---

• *Generado con Wingworking*
