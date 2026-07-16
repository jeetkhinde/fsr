# Jag's List — Active Work

App work log only. Framework state → repo root [`../../.memory/active-work.md`](../../.memory/active-work.md).

Last updated: 2026-07-17

## Current State

- **Plan 1 (foundation + auth)** shipped as PR #6 — better-auth (FSR + SSR),
  invite-only access, session gating; 20 E2E tests pass.
- **Plan 2 (CRUD)** specced — next up.

## Auth / rendering note (in use)

Every auth-varying / per-request page exports `export const promote_after = false`
to force pure SSR. This works around the framework's absent-`promote_after` defect
(see root [`../../.memory/bugs-active.md`](../../.memory/bugs-active.md) §1; ADR-015).

## Next

- Implement Plan 2 (CRUD).
