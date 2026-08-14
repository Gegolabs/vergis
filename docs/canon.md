# The canon — where the normative specs live, and why they are not in this repo

Vergis is the **reference implementation of AgencyDomains**. The normative specs it implements —
the **Botler contract**, the **Mira spec**, the **DSL**, and the **naming** of the primitives — are
part of the canon, and the canon is a **published book with its own license and its own version
line**:

| | |
|---|---|
| **Work** | *AgencyDomains · Arquitectura del Mundo Agentivo* |
| **Published at** | <https://agencydomains.org> |
| **License** | **GNU FDL v1.3** |
| **Current edition** | **v1.0** (August 2026) — first edition; figure numbering is stable from v1.0 on |

## Why the specs are not copied into `docs/`

Two reasons. The first is a fact about licenses; the second is the one that would have hurt.

**1 · The licenses do not mix.** This repository is **AGPL-3.0-or-later**. The canon is **GNU FDL
v1.3**, which is *not* GPL-compatible: copying normative text from the book into this tree would
make part of it undistributable under the repo's own license. This is not a stylistic preference —
it is a defect that would only surface when somebody tried to redistribute.

**2 · A copied spec is a spec that drifts.** A normative text with two homes has two versions the
moment either one is corrected, and the copy always loses: it is the one nobody re-reads. This
project already paid that bill once — the Go-port line in `TODO.md` was a duplicate of a decision
that lived in [ADR-001](adr-001-lenguaje-y-supply-chain.md), and it aged worse than its source
because ADR-002 re-framed the driver and the duplicate never found out.

So the canon is **cited, not copied** — the same rule this project's own governing documents follow.

## What lives here instead

`docs/` holds what is **true of this implementation** and would be wrong to put in the canon:
architecture of the deployment, governance and permissions, master data, freshness, the notes
layer, the state surface, and the ADRs. Where an implementation decision *derives* from the canon,
it cites the canon and says which edition it read.

**When the canon and this repo disagree, the canon wins on what a Botler/Mira/DSL *is*, and this
repo wins on what this implementation *does*.** The two are different claims and only the second is
verifiable by running the code.

## If a specific normative fragment is ever needed in-tree

It is not forbidden — it needs an act, not a copy-paste: an explicit relicensing of that fragment
by its author (César Obach holds the copyright of both works), recorded in an ADR, and a stated
edition of origin. Absent that act, quoting the canon under fair-use-sized excerpts with attribution
is the way, and the pointer above is the citation.

---

*Cited edition: AgencyDomains v1.0 (August 2026). If you are reading this after a newer edition
shipped, the pointer is still correct — the edition is what needs re-checking.*
