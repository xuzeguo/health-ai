# AGENTS.md

## Purpose

This file defines the repository rules for coding agents and human contributors. It follows common practices used by large engineering organizations: small scoped changes, explicit ownership, tests before release, secure handling of secrets, and evidence based handoffs.

More specific `AGENTS.md` files in child directories override this file for their scope. User instructions and system instructions take precedence over this file.

## Repository Snapshot

- HealthAI is a local, single process desktop web prototype.
- Runtime: Node `>=22.12 <23`; package manager: pnpm `10.26.0`.
- Frontend: Vue, TypeScript, Pinia, Vite, Element Plus.
- Backend: Fastify, TypeScript, Zod, OpenAI compatible DeepSeek provider.
- Storage: local SQLite through `better-sqlite3`.
- The stable Feature 01 chat contract must remain compatible while Feature 02 is developed.
- Current Feature 02 direction is recorded in `docs/PHASE2_LEARNING_PLAN.md`; older product-oriented planning documents are historical references only.

## Start-of-Task Protocol

1. Read this file and inspect `git status --short` before editing.
2. Read `docs/NEXT_PHASE_CONTEXT.md` and the task-specific status/design document.
3. Identify the smallest user-visible or contract-level change that satisfies the request.
4. Write or update the stage test conditions before implementation when working on Feature 02.
5. State the affected files, invariants, risks, and verification commands in the work log or handoff.

Do not reset, checkout, clean, or overwrite existing user changes. Do not assume a clean worktree. If an unexpected change appears in a file being edited, stop and ask how to proceed.

## Architecture Rules

- Keep the dependency direction `Route -> Service -> Repository / Provider`.
- Keep SQL in repository modules; keep database schema and migration logic in `apps/server/src/database`.
- Keep shared package exports limited to types and constants unless a dependency change is explicitly designed.
- Keep model access behind provider/AI ports. UI code must never receive or store an API key.
- Preserve the Feature 01 chat API and SSE events unless a documented versioned change is approved.
- Preserve these lifecycle invariants: persist before publishing deltas, commit terminal state before terminal events, terminal states cannot regress, cancellation reaches the provider, and uncertain POST results are reconciled with GET rather than retried.
- New workflow tasks must use the shared conversation task registry. They must not introduce a second per-conversation lock.
- Do not add a general purpose Agent, LangGraph, multi-agent loop, authentication, public deployment, or unrelated framework during Feature 02 without a separately approved scope.

## Feature 02 Stage Gates

Feature 02 is developed one stage at a time. The required order is:

1. Test conditions and isolated fixtures.
2. Failing tests for new behavior and failure paths.
3. Minimal implementation.
4. Targeted tests, then the full offline suite.
5. Typecheck, production build, and relevant browser/process/network checks.
6. Update the stage status document with pass/fail evidence and known limits.
7. Only then begin the next stage.

The current Feature 02 route is the AI learning plan: Prompt/JSON+Zod, Function Calling, RAG, SSE, HITL, and LangChain. The existing workflow code is a bounded historical smoke path and must not be expanded into a general workflow engine unless the learning plan is explicitly revised. Do not start OCR, report upload, measurement tools, or product RAG before the learning stages authorize them.

## Commands

Run commands from the repository root with Node 22 and pnpm 10:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Useful local development commands:

```sh
pnpm dev:server
pnpm dev:web
```

`pnpm test` is offline and must not call a real model. Real provider checks are opt-in and may incur cost:

```sh
pnpm test:provider
```

Run `verify:p4`, `verify:p5`, or `verify:p6` only when the requested change requires their scope. Do not repeat accepted real-model checks without a reason recorded in the task.

## Testing Requirements

- Test success, invalid input, boundary values, timeout/cancellation, state consistency, and resource cleanup where applicable.
- Prefer deterministic fixtures, injected clocks, temporary SQLite databases, mock transports, and Fastify inject.
- Never use a mock to claim that a real provider, OCR system, browser, or operating-system capability was validated.
- A test is not evidence until it has actually run. Record command, count, failures, and environmental limitations.
- New protocol or persistence behavior requires contract tests, including malformed frames, duplicate requests, wrong identity/sequence, terminal races, and restart behavior when applicable.
- Keep tests focused on behavior and failure prevention; do not add tests that merely mirror implementation details.

## Security and Privacy

- Never print, commit, upload, or include in reports: API keys, `.env` contents, Authorization headers, report files, full health conversations, tool results, or private reasoning.
- Never write a real secret into `VITE_*` variables or frontend source.
- Preserve `.env` and do not overwrite it. Use synthetic markers for leak tests.
- Use temporary databases and synthetic or authorized de-identified fixtures. Do not migrate or inspect the everyday health database for tests.
- Keep user-controlled Markdown escaped and links restricted by the existing renderer policy.
- Public errors must use the shared safe error codes/messages. Do not reflect upstream bodies, headers, stack traces, SQL, or arbitrary input.
- Keep the server bound to loopback. This project has no authentication or multi-user isolation and must not be exposed publicly.

## Data and Migration Rules

- Treat SQLite schema changes as migrations, not edits to `CREATE TABLE` alone.
- Preserve existing Feature 01 conversations and messages.
- Use short transactions; never hold a database transaction across network or model calls.
- Keep terminal state transitions monotonic and make recovery behavior explicit.
- Test empty databases, existing databases, repeated startup, checksum/version mismatch, rollback, WAL recovery, and foreign-key behavior for schema changes.

## Change and Handoff Standards

- Keep changes narrow and reviewable. Avoid unrelated formatting or dependency upgrades.
- Add concise comments only for non-obvious lifecycle, security, or concurrency decisions.
- Update affected documentation, status tables, protocol examples, and limitations in the same change.
- Before handoff, report: what changed, why, files touched, tests run, test counts, known limitations, and next action.
- Do not mark a stage complete when required tests are missing, blocked, or replaced by a weaker test.
- Do not create commits, tags, releases, or pushes unless the user explicitly requests that action.

## Definition of Done

A change is done only when the intended behavior is implemented, relevant failure paths are covered, existing contracts remain compatible, secrets and sensitive data are absent from logs/artifacts, `pnpm test` and `pnpm build` pass, and the applicable status/documentation is updated. If an environment prevents a required check, report it as unverified rather than passing.

