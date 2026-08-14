# ADR-001 — Lenguaje de Programación y Seguridad de Supply Chain

**Versión:** 1.0
**Fecha:** 2026-06-11
**Estado:** Aceptado

---

## Contexto

Vergis está implementado en TypeScript (Node). La pregunta evaluada es si el producto debería estar implementado en un lenguaje de sistemas (Rust, Go), considerando dos ejes: solidez del runtime y riesgo de supply chain del ecosistema npm — este último agravado por la cadencia sostenida de incidentes públicos (compromisos de cuentas de mantenedores, paquetes con install scripts maliciosos, typosquatting).

Este documento registra la evaluación y la decisión, con datos medidos sobre el repositorio.

## ¿Dónde importa el lenguaje en Vergis?

La decisión no se evalúa en abstracto sino por componente, según lo que cada pieza le exige al lenguaje:

| Pieza | ¿Qué hace? | ¿El lenguaje importa? |
|---|---|---|
| Enforcement RLS | `ROW POLICY` / `SECURITY POLICY` nativas | No corre en Vergis: corre dentro de ClickHouse (C++) y Fabric (SQL Server). Vergis solo genera el DDL en specialize-time |
| Policy compiler (`packages/policy`) | Transformación pura de estructuras de datos a SQL | Portable a cualquier lenguaje. Cero I/O, cero concurrencia |
| Render (Vega-Lite → SVG) | Compila gramática declarativa de charts server-side | Amarrado a JS: Vega/Vega-Lite no tienen equivalente en Rust/Go (las alternativas son imperativas, no una gramática declarativa) |
| Table runtime (`table-runtime.ts`) | Funciones puras testeadas en Node y embebidas vía `.toString()` en el HTML | Solo posible en JS/TS: servidor y cliente comparten literalmente el mismo código. En otro lenguaje el runtime cliente se escribiría en JS aparte y se testearía aparte, perdiendo la única fuente de verdad |
| Servidor HTTP (`serve-rls.ts`) | Orquestación I/O-bound | Node es suficiente: el trabajo pesado (filtrar filas) lo hace la base de datos; Vergis renderiza result sets ya filtrados |

**La frontera de confianza de Vergis es el motor de base de datos, no el proceso Node.** El RLS se ejecuta nativamente en ClickHouse y Fabric; el proceso de aplicación solo compila las policies e inyecta claims (siempre parametrizados, nunca concatenados). Un rewrite en Rust no haría el RLS más seguro, porque el RLS no se ejecuta en el proceso de la aplicación.

Donde un bug de lógica sí sería grave — el compilador de policies — la garantía no proviene del type system sino del diseño: IR no-Turing-completo, evaluador de referencia como oráculo, y **1.600 iteraciones** de property testing diferencial que prueban `filas(ClickHouse) ≡ filas(Fabric) ≡ filas(referencia)` — dos property tests de 800 iteraciones cada uno en `tests/policy.test.ts` (líneas 184 y 430); el segundo compara tres vías, de modo que las aserciones diferenciales suman 2.400. *(Corregido 2026-08-10: la v1.0 decía «2.100», cifra que no se reproduce por ningún conteo.)*

## ¿Qué cuesta TypeScript?

- **Tipos borrados en runtime** — los contratos entre Botler y Capabilities requieren validación explícita en las fronteras (no la provee el lenguaje). Mitigación: validación de shape en `capabilityCall`.
- **Supply chain npm** — el costo dominante; se analiza en detalle abajo.
- **Compilación al vuelo en producción** — ejecutar `tsx` en la imagen es una deuda operacional independiente del lenguaje. Mitigación: build a `dist/` y `node dist/`.
- **Sin binario único** — Go produciría un binario estático; la distribución por imagen Docker (`ghcr.io/gegolabs/vergis`) lo mitiga.
- **Percepción de solidez** — factor real en ventas enterprise, técnicamente discutible para un workload I/O-bound.

## Exposición de supply chain (medida sobre el repo)

Medición del árbol de dependencias (2026-06-11):

| Métrica | Valor |
|---|---|
| Paquetes únicos en producción | 170 |
| Paquetes totales (con dev) | 217 |
| Paquetes con install scripts en producción | **0** |
| Paquetes con install scripts en dev | 1 (esbuild, vía tsx/vitest) |

Distribución por workspace:

| Workspace | Dependencias externas runtime |
|---|---|
| `botler` (gate, log encadenado, runtime) | **cero** |
| `policy` (compilador RLS) | **cero** |
| `mira` (DSL, pipeline) | ajv, ajv-formats, yaml |
| `capabilities` | mssql, tedious, vega, vega-lite |

**El kernel de seguridad (gate + log auditado + compilador de policies) tiene cero dependencias externas.** El árbol de 170 paquetes vive entero en la capa de presentación (charts) y el driver de Fabric.

### ¿Cuáles son las superficies de ataque?

1. **Máquina del desarrollador** (install time) — vector: install scripts. Estado: cero en producción; mitigado con `ignore-scripts` global.
2. **CI** (build) — mitigado: `npm ci` con lockfile + gate de audit.
3. **Imagen de producción** — mitigado: imagen multi-stage con `--omit=dev --ignore-scripts` y código precompilado.
4. **HTML servido a consumidores** — la superficie más grave para un producto de governance: una dependencia comprometida en el path de render podría inyectar JS en los reportes servidos a las organizaciones cliente. Vega está exactamente en ese path; por eso su versión se mantiene al día y toda dependencia nueva en `capabilities` es una decisión documentada.

### ¿Cambiaría el riesgo con Rust/Go?

- **Go es genuinamente superior en este eje**: checksum database pública verificada por default, sin install scripts, cultura de stdlib (árboles de 5–20 dependencias), vendoring trivial.
- **Rust no tanto**: `build.rs` y proc-macros ejecutan código arbitrario en build-time (el equivalente moral del postinstall), y los árboles de crates también crecen.
- **El rewrite no elimina el problema**: los charts seguirían necesitando Vega (JS) o un cambio de gramática de visualización, y el HTML servido siempre lleva JS embebido.

## Decisión

**Estrategia híbrida evolutiva:**

1. **TypeScript es el runtime del producto.** El ecosistema lo determina por razones técnicas: Vega-Lite para charts server-side y el isomorfismo servidor/cliente del table runtime.
2. **El policy compiler es el kernel portable.** Es pequeño, puro, con cero dependencias y un oráculo + property tests que hacen cualquier port verificable mecánicamente (se corre el port contra la implementación TS con los mismos casos). Se porta — Go es el candidato, por su modelo de supply chain — cuando exista un driver de negocio concreto: Custos como producto standalone, embedding en otro runtime, o distribución como librería/WASM. No antes.

   > **Delta 2026-08-10 — el driver principal quedó reencuadrado por ADR-002.** Aquel ADR catalogó
   > `packages/policy` (Custos, kernel RLS) como pieza **abierta, prioridad 1**, y situó la frontera
   > comercial en el control plane de flota + HA/K8s. «Custos como producto standalone» deja por
   > tanto de ser un driver **de ingreso**: si Custos standalone nace, nace abierto. Disparadores
   > que siguen vivos: **embedding en otro runtime** y **distribución como librería/WASM** —
   > ninguno con demanda al día de hoy. Contra-consideración registrada: si se construye el frente
   > 09 de #113 (Motor L, `execute-sql-local`), `applyPolicy` pasaría a ser el motor de filtrado
   > local y el kernel se entrelazaría más con el runtime JS, encareciendo el port. *Leído del
   > diseño `work/004-…/09-…`, no medido — es diseño, no código construido.*
   > Este delta es la razón por la que la línea gemela salió de `TODO.md`: la decisión vive acá.
3. **El riesgo de supply chain se gestiona operacionalmente**, con las medidas de la sección siguiente.
4. **Presupuesto de dependencias como regla de gobernanza:** `botler` y `policy` permanecen en cero dependencias externas por contrato; toda dependencia nueva en cualquier workspace es una decisión documentada, no un default.

## Mitigaciones operacionales

| Medida | Instrumento |
|---|---|
| Bloquear install scripts | `.npmrc` con `ignore-scripts=true` |
| Builds reproducibles | `package-lock.json` + `npm ci` |
| Cooldown de actualizaciones | Renovate con `minimumReleaseAge` de 14 días — los compromisos de paquetes npm se detectan típicamente en horas/días. **Se ejecuta self-hosted** (`.github/workflows/renovate.yml`), no como GitHub App: instalar la App exige consentimiento OAuth del owner de la org, acción humana que mantuvo el control inerte desde el 2026-06-11. **Requiere el secret `RENOVATE_TOKEN`; sin él el workflow FALLA en rojo a propósito** — un control que no corre tiene que verse, no quedar verde |
| Gate de vulnerabilidades | `npm audit --omit=dev` como paso de CI |
| Imagen mínima | Dockerfile multi-stage: build a `dist/`, imagen final con `--omit=dev --ignore-scripts`, sin tsx |
| SBOM | Generación en CI por build de imagen |

## Consecuencias

- La respuesta a "¿por qué TypeScript?" queda evaluada y documentada: es una decisión de ecosistema con el riesgo medido y gestionado, no una herencia.
- El costo de un port futuro del kernel está acotado por diseño (cero deps + oráculo de equivalencia).
- La capa de presentación concentra el riesgo residual de supply chain; su gestión es operacional y continua.
