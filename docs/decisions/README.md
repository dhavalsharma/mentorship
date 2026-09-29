# Decision records

One file per architectural decision that could reasonably have gone the other
way. The point of each is not to justify what was built — it is to record the
**forces** and the **rejected options**, so that when a constraint changes
someone can tell whether the decision still holds.

A decision that had no plausible alternative does not need a record here.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-program-policy-is-data.md) | Program policy is data, not code | Accepted |
| [0002](0002-agents-are-durable-sagas.md) | Long-running flows are durable sagas, not primitives | Accepted |
| [0003](0003-pairing-is-optional.md) | Pairing is an optional mode; import emits the same event as matching | Accepted |
| [0004](0004-agreement-is-deterministic.md) | Agreement resolution is deterministic, with five outcomes | Accepted |
| [0005](0005-document-is-a-projection.md) | The database is the source of truth; the shared doc is a projection | Accepted |
| [0006](0006-capabilities-are-probed.md) | Capabilities are probed per tenant, not inferred from the vendor | Accepted |
| [0007](0007-scores-are-deterministic.md) | Scores are deterministic; the model explains them | Accepted |
| [0008](0008-postgres-only.md) | Postgres only — pgvector, pg-boss, RLS | Accepted |
| [0009](0009-pairs-choose-their-own-cadence.md) | Pairs choose their own session length and rhythm | Accepted |
| [0011](0011-email-is-a-port-not-a-slot.md) | Outbound email is a port bound from the environment, not a ninth slot | Accepted |

## Adding one

Copy the shape of an existing file. Keep it short: context, decision, the
options you actually weighed, the trade-off, and what becomes harder. The
"what becomes harder" section is the one people skip and the one that ages
best.

Number sequentially. Never edit an accepted ADR to change its decision —
supersede it with a new one and set the old status to `Superseded by ADR-NNNN`.
The history of what you used to believe is the useful part.
