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

## Docs

Canonical product docs live in `docs/`:

- [`arquitectura-multi-reporte.md`](docs/arquitectura-multi-reporte.md) — Multi-report architecture: how **one deployment serves N Information Products** — spec path resolution (`VERGIS_SPECS_DIR`/`VERGIS_SPECS`), discovery and slug routing, per-PI isolation (servability verdicts, artifact ACL, per-consumer render/cache), what the node shares (engine, policy store, identity, governance) vs what is per-PI, and hot-reload. Includes the **contract for agents**.
- [`gobierno-permisos.md`](docs/gobierno-permisos.md) — Governance: the **three-state model**, the `GovernanceStore` and its full inventory (**`platform_setting`** with the editable catalog title, per-PI ACLs, admin seeds, intake upload/revert registries, ingestion projection, in-app source-registry management with `managed_at`/tombstones), **PI permissions** (owner/collaborator/viewer, Mira-managed groups, public/private), the two orthogonal authz layers (artifact vs RLS, no bypass), and how RLS is applied. Includes the **contract for agents**.
- [`data-maestra-y-publicacion.md`](docs/data-maestra-y-publicacion.md) — Master data management: authoring, the **universal publication model** (`md_<entity>__replica` projections, not Fabric shortcuts), freshness via oferta/demanda, and the **contract for agents**.
- [`frescura-oferta-demanda.md`](docs/frescura-oferta-demanda.md) — Freshness: **oferta vs demanda**, demand ceiling, required-cadence derivation, observability, and the reconciler (delegate to the engine's scheduler).
- [`capa-de-notas.md`](docs/capa-de-notas.md) — The **notes layer**: the two species (**comment** anchored to a governed record via the dataset's `anchor`, **annotation** anchored to a frozen **impression**), the write-time authorization check against live data, lazy materialization, governed sharing, retention settings, and the **contract for agents**.
- [`adr-001-lenguaje-y-supply-chain.md`](docs/adr-001-lenguaje-y-supply-chain.md) — language & supply-chain ADR.

## Edition and license

Core **AGPL-3.0-or-later**, functionally complete on single-node. The Enterprise edition (HA / Kubernetes / carrier-grade) is commercial. The canon's normative specs (Botler contract, Mira spec, DSL, naming) ship with AgencyDomains; their migration to this repo's `docs/` is pending.

---

Language: TypeScript (Node). · A Gegolabs project · *Built with Wingworking*
