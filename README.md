# Vergis · Meta-Cognitive Platform

**Vergis** es la *Meta-Cognitive Platform* — la implementación de referencia de **AgencyDomains**. Hospeda un **Botler** (runtime genérico de Capa 3) que ejecuta **Botlets**; **Mira** es el proto-Botlet de información que produce reportes y dashboards a partir de un spec declarativo.

> Esquema de nombres: **Vergis** (plataforma) · **Botler** (runtime de Capa 3, genérico) · **Mira** (proto-Botlet de información).

## Correr

```sh
npm install
./bin/vergis run examples/hello.yaml      # escribe hello.html + vergis.log.jsonl
npm test                                  # suite hermética (acceptance)
npm run typecheck                         # tsc --noEmit
```

## Qué demuestra (Definition of Done · walking skeleton)

1. `vergis run examples/hello.yaml` termina con código 0 y escribe `hello.html`.
2. El HTML muestra la pieza compuesta y el conteo de agentes vivos.
3. El log (`vergis.log.jsonl`) encadena por hash `invoke`, `capability-call` (×N), `render`, `publish`.
4. Un spec con Capability no catalogada se **rechaza con error estructurado** (`examples/bad-capability.yaml`).
5. Un fallo de Capability **dispara el fallback agéntico** (`examples/force-fail.yaml` → log `agentic-fallback`).
6. **Reproducibilidad**: mismo spec ⇒ HTML byte-idéntico.

## Datos reales

Más allá de los *mocks*, Mira consume datos reales vía Capabilities de acceso (p. ej. `execute-sql-dwh` contra un SQL endpoint, autenticando con Service Principal). El render produce KPIs, charts (Vega-Lite → SVG server-side) y tablas; el *freshness check* degrada según `quality.degradation` cuando los datos superan `max_age`. Las credenciales y los specs de cada instancia se proveen **desde afuera** (env `VERGIS_CONNECTIONS`, `VERGIS_SPEC`/`VERGIS_SPECS`) — nunca van en la imagen ni en el repo del producto.

## Servidor y despliegue

`server/serve.ts` sirve uno o varios reportes (ruteo por `identity.code`, índice en `/`), regenerándolos en cadencia (`VERGIS_REFRESH_MS`). La imagen (`Dockerfile`) es **genérica y agnóstica de instancia**: los specs y conexiones se inyectan por entorno. Empaquetado Free: `docker-compose.yml` + `.env.example`.

## Layout

```
vergis/
├── packages/
│   ├── botler/         # runtime genérico de Capa 3
│   ├── mira/           # proto-Botlet de información (parse + validar + pipeline)
│   ├── capabilities/   # static-data · execute-sql-dwh · render-html-piece · publicar-artefacto · themes
│   └── cli/            # `vergis run <spec>`
├── examples/           # hello.yaml + casos de validación y fallback (genéricos)
├── schema/             # mira-spec.schema.json
├── server/             # servidor de despliegue (multi-reporte)
└── tests/              # acceptance (suite hermética)
```

## Edición y licencia

Núcleo **AGPL-3.0-or-later**, funcionalmente completo en single-node. La edición Enterprise (HA / Kubernetes / carrier-grade) es comercial. Las specs normativas del canon (contrato del Botler, spec de Mira, DSL, naming) se distribuyen con AgencyDomains; su migración a `docs/` de este repo está pendiente.

---

Lenguaje: TypeScript (Node). · Producto de Grupo Ultra (Gegolabs) · *Generado con Wingworking*
