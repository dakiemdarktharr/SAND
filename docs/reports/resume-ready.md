# Focused local-demo verification — 2026-09-11

## Outcome and scope

One offline control-plane workflow now runs with npm ci followed by npm run demo. It uses the real Fastify HTTP server, shared policy evaluator, unchanged migrations, and Store against disk-backed PGlite. It bootstraps a clearly labeled development project, rejects a disallowed request, accepts one request idempotently, records cancellation intent, exits the server cleanly, opens the database in a different process, and verifies stable event IDs, persisted idempotency/outbox records, and the audit chain.

This is a request-admission and recovery demonstration for an AI-engineering workbench. It is not AI inference, agent execution, Temporal execution, or evidence of production crash recovery. No provider calls are made. The final run state remains cancellation_requested because no worker consumes the two outbox entries.

The repository was clean at 7fc0d5f when inspected. No existing user changes were reset. New code and documentation remain in the working tree for review.

## Files changed

| File | Purpose |
|---|---|
| README.md | Two-minute overview, exact commands, diagram, demo/evidence, implemented/planned distinction, limitations, two-line resume bullet |
| package.json | Add demo and test:demo commands; no dependency changes |
| services/local-demo/database.ts | Explicit development-only disk-backed PGlite adapter, serialized connections, existing migrations/bootstrap, runtime role and exclusive directory lock |
| services/local-demo/server.ts | Supervised loopback HTTP process with ephemeral bearer token; orderly database close |
| services/local-demo/main.ts | Automated terminal walkthrough, real HTTP assertions, new-process reopen, structured JSONL and measured summary |
| services/control-plane/src/store.ts | Include safe policy decision/reason/rule IDs in new audit bodies; explain cancellation intent |
| tests/integration/local-demo.integration.test.ts | One deterministic CLI/HTTP/database/restart E2E with exported-evidence assertions |
| docs/architecture/adrs.md | ADR-011 documenting the development adapter and audit-body compatibility |
| docs/evidence/local-demo.json | Actual clean-source demo summary; machine-specific directory omitted |
| docs/evidence/local-demo-audit.jsonl | Actual three-entry audit export |
| docs/evidence/local-demo-events.json | Actual persisted replay response |
| docs/reports/resume-ready.md | This report |

There is no new SQL migration: migrations 001 and 002 run unchanged. Audit bodies are canonical text/JSON; extra metadata applies only to newly appended entries. Old audit rows and their hashes remain unchanged. The existing network PostgreSQL entry point does not import PGlite and keeps its production startup refusal.

## Commands executed and results

- Inspected git status --short, git log -3 --oneline, README/package scripts, Electron/main/preload, API/server/store/migrations, Temporal workflow, policy evaluator, test helpers and limitations. Initial working tree: clean.
- npm run lint: PASS.
- npm run typecheck: PASS after correcting the new subprocess/readiness TypeScript types caught during implementation.
- npm test -- --reporter=json --outputFile=artifacts/local/resume-tests.json: **131 passed, 11 skipped, 0 failed**. Includes the new deterministic test, existing PGlite/API tests, and three native PostgreSQL tests.
- npm run test:demo: PASS in the working tree and in a fresh source copy. It starts two separate server processes, calls the real HTTP endpoints, and reads exported files; no provider fixtures are used.
- npm run demo: PASS; structured output includes project.registered, policy.rejected, run.persisted, audit.entry, replay.verified, and demo.completed.
- Created an isolated copy of tracked and new source files under ignored .runtime, without node_modules, .git, existing database or dist. This tests the current uncommitted source snapshot, not a new remote GitHub checkout.
- In that fresh copy: **npm ci → npm run demo → npm run test:demo → npm run build** all PASS. npm ci installed 702 packages. No global install, external database, Temporal server, or credentials were needed. Build completed with the existing large-renderer-chunk warning (~2.90 MB minified, ~764 KB gzip).
- In the same fresh copy: **npm run setup:desktop → npm run test:e2e**: **3 passed, 1 skipped**. Repository edit/save/diff, conflict handling, and renderer isolation/unavailable states passed. The gated live PostgreSQL/Temporal/OpenRouter desktop case was not enabled in this pass.
- npm audit --json: **2 moderate findings**, Vitest and @vitest/mocker under [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). A major test-tool upgrade is outside this focused slice; no npm audit fix --force was applied.
- Gitleaks 8.30.1 source scan with .gitleaks.toml and redacted output: **0 findings**. Generated/runtime/dependency directories are excluded by the existing scan configuration.

The 11 default skips are five provider contracts, five Temporal workflow cases, and one external staging-database case. Skips are not passes. Counts from the focused test overlap the full suite; do not sum them as independent tests. No live provider test was run during this pass.

## Measured evidence

[Summary](../evidence/local-demo.json), [audit](../evidence/local-demo-audit.jsonl), [events](../evidence/local-demo-events.json). Actual observation on Windows x64, Node 24.18.0 at 2026-09-11T08:50:00.420Z:

| Observation | Value |
|---|---|
| Persisted project / accepted run | 1 / 1 |
| Outbox entries after restart | 2, neither delivered |
| Persisted events / valid audit entries | 2 / 3 |
| Replayed cursor | after=1 returned sequence 2 |
| Duplicate admission | Same run before and after server restart |
| Audit decisions/reasons | deny/no_matching_rule; allow/explicit_allow; user_requested_cancellation |
| Model/provider requests | 0; no inference performed |
| Full demo elapsed | 9,300 ms |
| New server reopen-to-ready | 980 ms |

Timing is one observed sample, including local startup work. It does not establish p95 latency, throughput, an SLO, model quality, or a competitor benchmark. The three copied evidence files are documentation outputs, not application inputs. Earlier batch reports retain their historical scope and timestamps.

## Demo use and failure behavior

Run npm run demo from the repository root. A new .runtime/resume-demo-* directory is printed and retained on each invocation. The process exits after verifying both server shutdowns. Inspect summary.json, transcript.jsonl, events.json, and audit.jsonl with an editor or Get-Content in PowerShell. The token is randomly generated in memory, passed only to the supervised local server, and omitted from exports.

The local database uses a non-owner runtime role and serializes access to PGlite's single connection. An exclusive .sand-demo.lock prevents two owners of the same directory. A failed or killed process may leave a stale lock; inspect ownership and use a fresh demo run rather than deleting existing data. Production mode is refused. If setup fails, verify Node 24, installed dev dependencies, available disk and filesystem permissions; a failed check exits nonzero rather than returning sample data.

## Remaining limitations

The GUI does not attach to this temporary demo API. Its separate backend needs the existing PostgreSQL/Temporal setup. Full authenticated inference, provider contract coverage, OIDC, TLS, OS keychain/Vault, MCP/OAuth, GitHub App, quotas/failover, untrusted worker isolation, signing, deployment hardening and production backup/restore remain unfinished. The bootstrap is not an OIDC-backed project-registration API. PGlite is not a multi-process production database. No abrupt crash, host reboot, power-loss, worker cancellation latency, external audit anchoring, macOS, load, or availability target is established by this demo.

The current dependency advisory and renderer bundle-size warning remain open. A test-only provider fixture is never substituted into this demo or the production path. No new model-performance numbers, costs, production claims, or completed agent features were introduced.
