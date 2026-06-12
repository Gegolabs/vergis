# Vergis · Meta-Cognitive Platform

**Vergis** is the *Meta-Cognitive Platform* — the reference implementation of **AgencyDomains**. It hosts a **Botler** (generic Layer 3 runtime) that runs **Botlets**; **Mira** is the information proto-Botlet that produces reports and dashboards from a declarative spec.

> Naming scheme: **Vergis** (platform) · **Botler** (Layer 3 runtime, generic) · **Mira** (information proto-Botlet).

## Run

```sh
npm install
./bin/vergis run examples/hello.yaml      # writes hello.html + vergis.log.jsonl
npm test                                  # hermetic acceptance suite
npm run typecheck                         # tsc --noEmit
```

## What it proves (Definition of Done · walking skeleton)

1. `vergis run examples/hello.yaml` exits 0 and writes `hello.html`.
2. The HTML shows the composed piece and the live-agent count.
3. The log (`vergis.log.jsonl`) hash-chains `invoke`, `capability-call` (×N), `render`, `publish`.
4. A spec with an uncatalogued Capability is **rejected with a structured error** (`examples/bad-capability.yaml`).
5. A Capability failure **triggers the agentic fallback** (`examples/force-fail.yaml` → `agentic-fallback` log).
6. **Reproducibility**: the same spec ⇒ byte-identical HTML.

## Real data

Beyond *mocks*, Mira consumes real data through access Capabilities (e.g. `execute-sql-dwh` against a SQL endpoint, authenticating with a Service Principal). The render produces KPIs, charts (Vega-Lite → server-side SVG) and tables; the *freshness check* degrades according to `quality.degradation` when data exceeds `max_age`. Each instance's credentials and specs are supplied **from the outside** (env `VERGIS_CONNECTIONS`, `VERGIS_SPEC`/`VERGIS_SPECS`) — never baked into the image or the product repo.

## Server and deployment

`server/serve-rls.ts` serves one or more **Information Products** **per consumer** (data-anchored RLS): it discovers the specs (`VERGIS_SPECS_DIR`/`VERGIS_SPECS`), routes by `identity.code` (per-consumer index at `/`), applies the **policy store** policy (`VERGIS_POLICIES`) over the ClickHouse store (`VERGIS_DATASETS`), and injects the gate claims. **There is no path to serve without RLS** (the static server was retired). The image (`Dockerfile`) is **generic and instance-agnostic**: specs, policies, datasets and connections are injected via the environment.

## Layout

```
vergis/
├── packages/
│   ├── botler/         # generic Layer 3 runtime
│   ├── mira/           # information proto-Botlet (parse + validate + pipeline)
│   ├── capabilities/   # static-data · execute-sql-dwh · render-html-piece · publicar-artefacto · themes
│   └── cli/            # `vergis run <spec>`
├── docs/               # ADRs & engineering docs (language/supply-chain, improvement plan)
├── examples/           # hello.yaml + validation & fallback cases (generic)
├── schema/             # mira-spec.schema.json
├── server/             # deployment server (multi-report)
└── tests/              # acceptance (hermetic suite)
```

## Edition and license

Core **AGPL-3.0-or-later**, functionally complete on single-node. The Enterprise edition (HA / Kubernetes / carrier-grade) is commercial. The canon's normative specs (Botler contract, Mira spec, DSL, naming) ship with AgencyDomains; their migration to this repo's `docs/` is pending.

---

Language: TypeScript (Node). · A Gegolabs project · *Built with Wingworking*
