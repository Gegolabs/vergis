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

### Operational contract (`GET /contrato`)

The node answers for itself, so the operator never has to trust an external manual that nobody
invalidates. `GET /contrato` is **admin-only** (it is operations surface, not consumption surface: it
requires governance and an admin role), answers JSON, and responds **even when the engine is not
ready** — «why won't it start?» is exactly the question you ask an unhealthy node. It never exposes
env **values** or secrets: only variable **names**, file paths, sha256 hashes and authored texts.

**Snapshot** — what this process is doing *right now*, derived from live state, never a hand-kept
list: `version` · `engine` · `startedAt` · `hotReload` · `watches[]` (which envs configure each
watch, which paths it watches, what it reloads) · `signals[]` (e.g. `SIGHUP` → what it does) ·
`reloads{last,recent}` · `artifacts[]` with the sha256 of what was **loaded** vs the sha256 **on disk
now** and a `pending` flag — that pair answers «did the node take my file?» without reading logs —
· `env{bootOnly,reloadableContent,unknown}` (which variables demand a restart, which reload their
content, and which are present but never consumed — a typo doesn't disappear silently) · `caveats[]`.

**Delta between versions** — the `delta` section answers «what changed in the operational contract
compared with the version that ran here before?», so deploying a new image is the moment the
operator's stale rules invalidate themselves. It is **computed**, never authored: each boot records a
diffable projection of the contract in `<VERGIS_OUT>/contrato/journal.json` (the instance's
persistent volume, since the image is instance-agnostic), and the delta is the structural diff
against the most recently seen different version. Highlights `env.nowReloadable` (no longer requires
a restart) and `env.nowBootOnly` (now does) as first-class facts, plus added/removed/modified
watches, signals and caveats. `unchanged: true` is an answer too: your rules still hold.

- `GET /contrato?desde=<version>` diffs against any version this instance has run (multi-version
  jumps, audits). An unregistered version returns **404** with the `disponibles` list.
- With no reference yet the payload says so honestly instead of fabricating a diff: `reason` is
  `primer-registro` (the first release carrying this feature only **seeds** the journal — the delta
  appears from the second deployment on), `version-desconocida` (build without a version) or
  `journal-no-disponible`. The journal never degrades the snapshot and never affects serving.

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

The entire Product in this repository is **AGPL-3.0-or-later** and **functionally complete on
single-node** — that phrase is a normative clause, not marketing: see
[ADR-002](docs/adr-002-open-core.md) for the open-core boundary, its two veto tests (auditability,
adoption) and the anti-crippleware promise. Commercial territory is what only an organization
operating at scale buys: HA / Kubernetes / carrier-grade, the multi-instance fleet control plane,
and the operated service — none of it exists as code today, and when it does it will live in a
separate program talking to Vergis over its APIs, never linked into the AGPL process. The canon's
normative specs (Botler contract, Mira spec, DSL, naming) ship with AgencyDomains; their migration
to this repo's `docs/` is pending.

---

Language: TypeScript (Node). · A Gegolabs project · *Built with Wingworking*
