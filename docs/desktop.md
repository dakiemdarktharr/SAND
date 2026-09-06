# SAND desktop — batch 01

Status: an implemented Windows development preview. It is not the complete IDE, a production agent runtime, or a signed production release.

## Run locally

From the repository root, install the pinned dependencies, run `npm run build`, then `npm start`.

No backend or model credential is required to open and edit local repository files. Use **Open a repository** (Ctrl+Shift+O), choose the Git root, select a file, edit it in bundled Monaco, and save with Ctrl+S. Explorer filters filenames, not file contents. Source control reads real Git status and unstaged diff; it does not commit or contact remotes.

The control room connects only to a loopback development API. Set `SAND_API_URL=http://127.0.0.1:4310` and `SAND_API_TOKEN` in the desktop process environment, start the documented local API/database/Temporal/worker stack, then reconnect. Model provider credentials belong to the trusted worker process. The token never enters the renderer, browser storage, repository subprocess environment, or a model prompt. Environment configuration is development bootstrap, not OS-keychain storage or production authentication.

A connected project enables **Start discovery**. This submits the actual `registry.refresh` workflow through the authenticated API with an idempotency key. The UI lists persisted runs, requests cancellation, replays persisted REST events every two seconds, displays real model records, and requests ledger verification. Models refresh on navigation and the persisted `registry.refreshed` event, with loading/error states and stale-response protection. Missing configuration and unknown pricing stay visible; there is no sample fallback.

## Modules and boundaries

- `src/main.ts`: Electron lifecycle, single-instance ledger ownership, packaged `sand://app` protocol, sender/main-frame checks, strict IPC schemas, native folder selection, bounded main-only API transport, audit intent/outcome.
- `src/preload.ts` / `src/shared.ts`: typed repository/control APIs; no generic IPC, shell, arbitrary URL, absolute file path, or secret getter.
- `src/repository.ts`: opaque grant identity; safe relative paths; denied metadata/credential paths, links/junctions and hard-linked reads; UTF-8 text at most 1 MiB; bounded listing; optimistic saves; durable backup/receipt; argv-only Git.
- `src/local-audit.ts`: serialized fsynced JSONL hash chain verified at startup. A ledger failure blocks following privileged operations. Records contain hashes and metadata, not file content.
- `src/renderer`: React, locally bundled Monaco/worker/languages, original visual system, editor tabs, filename filter, Git diff, capability and registry states, timeline, theme, keyboard palette, visible focus, reduced motion and adjustable sidebar.
- `src/renderer/replay.ts`: ordered/deduplicated consumption, stable ID/run/schema validation. Gaps never advance the cursor. At 5,000 displayed events, replay fails visibly; larger history requires the backend export/event API.

Electron uses context isolation, renderer sandbox, disabled Node integration, and web security. CSP blocks remote scripts, frames and arbitrary connections. Permission requests, navigation, new windows, webviews and downloads are denied. Monaco uses its supported textarea path (`editContext: false`) for accessible keyboard input.

No repository code is executed. Git has no shell, a reduced environment without provider tokens, bounded time/output, disabled fsmonitor/external diff/textconv/hooks, and rejects ancestor Git discovery when a subdirectory was selected. Native selection grants bounded local-user filesystem authority, not AI agent authority. The shared organization policy engine and persisted one-time approvals are not yet integrated into this desktop broker.

## Recovery and limits

Saves retain exact original-byte `.backup` files and JSON operation receipts under Electron `userData/recovery`. Backup and intent are fsynced before replacement. Same-key retries check the saved output hash; different input under an existing key is rejected. External change preserves disk content and leaves editor edits dirty. Repository switching invalidates previous document capabilities even when path and hash match.

Interrupted saves can require manual reconciliation from receipt/backup. No automatic recovery UI or retention pruning exists yet. Unsaved buffers remain in memory; crash recovery for them is not implemented. JavaScript path prechecks and O_NOFOLLOW do not eliminate all platform-specific concurrent link-swap/replace races. This local broker must not be used as a sandbox for a hostile concurrent repository writer; native handles or isolated workspaces are later gates.

`userData/audit/desktop.jsonl` detects altered/reordered interior records, but has no external anchor/WORM policy. A privileged host owner can rewrite a whole chain. Single-instance locking prevents ordinary simultaneous application processes from maintaining conflicting ledger heads.

## Executed checks

Windows workspace, 2026-09-07:

| Check | Actual evidence |
| --- | --- |
| TypeScript | `npm run typecheck` passed |
| Scoped lint | `npx eslint apps/desktop tests/e2e/desktop.spec.ts playwright.config.ts` passed |
| Filesystem/Git/audit | 23 tests passed using actual directories, Git, junction/hard-link fixtures, duplicate saves, stale grants, disk conflicts and tampered ledger |
| Replay | 4 unit tests passed: duplicate/reordered batches, 12 reconnects, gaps, conflicting identity, schema/run mismatch and memory bound |
| Electron E2E | 3 tests passed: unavailable states, real isolation/CSP, theme/palette, real Monaco edit/save/readback/Git patch, external conflict and dirty-tab retention |
| Build | Electron/Vite build succeeded; Vite reports a large main renderer chunk, approximately 2.9 MB uncompressed |
| Visual QA | Actual welcome and edited-file screenshots inspected |

E2E selects a real temporary directory using `SAND_E2E=1` and `SAND_TEST_REPOSITORY` only while unpackaged. This replaces the native chooser for automation; filesystem, Git, preload, and editor remain real. The native OS dialog itself has not been automated. Test-only user data is separately isolated.

Tests live in `tests/e2e/desktop.spec.ts`, `src/repository.integration.test.ts` and `src/renderer/replay.test.ts`. Root-owned `tests/e2e/fullstack.spec.ts` carries separate PostgreSQL/Temporal/provider/desktop evidence; its latest result belongs in the batch report. Synthetic replay data and credential canaries are test inputs only.

Screenshots: `artifacts/local/workbench.png` and `artifacts/local/workbench-editor.png`. Playwright attaches measured launch-to-visible-heading timing; the status bar reports actual renderer initialization and last panel transition. Individual observations are not a performance SLO or cross-platform benchmark.

## Explicit gaps and next delivery

No terminal/PTTY, LSP/symbol search, filesystem create/delete/move, merge editor, test runner, Git mutation, GitHub App, MCP, browser automation, agent execution, worker isolation, persisted arbitrary approvals, production identity, OS keychain, cloud deployment, or signed update flow is claimed. Only one repository is granted at a time.

Local editor work makes no paid inference request. Registry cost is unknown unless sourced metadata exists; infrastructure/provider charges depend on configured services. No fabricated dollar estimate is displayed.

The next desktop slice is native-handle repository mutation with durable recovery UI and tested keychain identity bootstrap, integrated with shared policy and persisted approvals. Untrusted execution requires isolated-runtime and egress evidence first.

