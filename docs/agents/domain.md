# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`PROJECT_SOURCE_OF_TRUTH.md`** at the repo root for the latest long-term project facts, decisions, current routes, safety rules, and handoff notes.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, proceed silently. Don't flag their absence; don't suggest creating them upfront. The domain-modeling flow can add or refine context lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```text
/
├── CONTEXT.md
├── PROJECT_SOURCE_OF_TRUTH.md
├── docs/adr/
└── local-backend/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, or a test name), use the terms as defined in `CONTEXT.md` and `PROJECT_SOURCE_OF_TRUTH.md`.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use, or there is a real gap to note for future domain modeling.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because..._
