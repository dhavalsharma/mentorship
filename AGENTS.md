The agent context for this repository lives in [CLAUDE.md](./CLAUDE.md), so
there is one file to keep current rather than two that drift apart.

Read it before changing anything — particularly the **Invariants** section,
which covers the constraints that are not visible from the code (idempotent
effects, tenancy scoping, never inferring consent from prose, never falling a
private message back to the joint thread).

The reasoning behind each architectural choice, including the rejected
alternatives, is in `docs/decisions/`.
