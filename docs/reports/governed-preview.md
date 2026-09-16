# Governed workflow preview — 2026-09-16

## Delivery status

Runnable and installable Windows developer preview, with an actual local-model/tool workflow. **Expanded Stage 1 remains incomplete.** Remote MCP OAuth, backend identity, isolated/cloud agents, full IDE/GitHub workflow and production release requirements have not been moved to Stage 2 or marked done. No competitor-parity claim.

## Changes

- packages/studio: saved/versioned DAGs, local SQLite migration, real inference, recovery/review/audit; five text adapters. The original text workflow is retained.
- packages/tools: official MCP clients, public HTTPS broker, durable argument-bound approval/tool receipt journal (separate schema version 1), bounded autonomous agent loop and negative tests. Native and explicit Ollama JSON protocols are distinct.
- packages/identity: fail-closed OS-encrypted vault; OIDC system-browser/loopback/PKCE/JWKS client. Windows canary tested; external issuer remains unverified.
- apps/desktop: composer, tool selection, approval inbox, connection settings, authoritative tool receipts, backup snapshots and typed/sender-checked IPC. Existing repository save/recovery behavior retained; tool workspace identity survives explicit re-grant after restart.
- services/local-demo, studio-demo, tools-demo, mcp-utility: real runnable vertical-slice demos; no synthetic provider success.
- tests, scripts and .github: deterministic tool recovery, actual MCP stdio/HTTP/SSE servers, live Electron/model/vault tests, package smoke, clean install, source SBOM and pinned CI actions. Vitest updated to 4.1.11 to resolve GHSA-82fw-gwwq-j7x9; removed its retired minWorkers option.
- README/docs: concise product story, exact commands, updated two-stage roadmap/ADRs/threat model, alternative-feature matrix and measured evidence. Earlier slice reports are retained as historical records.

## Executed checks

| Command / scope | Actual result |
|---|---|
| npm ci; npm run setup:desktop | Passed from the final lockfile; no source reset |
| npm run lint; npm run typecheck | Passed |
| npm test | **164 passed / 16 opt-in/configuration skips**, 24.37 s; [final check receipt](../evidence/governed-checks.json); live suites run separately below |
| npm run test:durability -- --live-registry | **5 passed**, 24.41 s: actual native PostgreSQL + Temporal CLI 1.9.1/server 1.32.0; queued work, duplicate-start reconciliation, cancellation, termination recovery, concurrent admission and public OpenRouter discovery |
| SAND_STUDIO_LIVE_TESTS=1 npm run test:e2e | **7 passed / 1 full-stack skip**, 48.09 s; actual Electron and Ollama, two models, human review, desktop restart, vault canary, tool approval/re-grant/restart and one actual tool execution |
| SAND_FULLSTACK_E2E=1 npx playwright test tests/e2e/fullstack.spec.ts | **1 passed**, 14.1 s; actual desktop → API → PostgreSQL/outbox → Temporal → public registry. [Raw result](../evidence/governed-fullstack.json) |
| npm run package:win; npm run test:package | NSIS preview built; packaged security flags, actual vault availability and actual MCP subprocess discovery passed. Installer install/uninstall lifecycle not exercised |
| electron-builder with forceCodeSigning=true | **Expected failure**, exit 1: absent signing identity. Normal preview independently checked as NotSigned |
| npm audit --audit-level=moderate | 0 advisory findings at this run; not proof of absence of security defects |
| gitleaks dir . --config .gitleaks.toml --redact | No leaks found in authored files; heuristic coverage only |
| npm sbom --sbom-format cyclonedx | Generated actual source dependency SBOM under artifacts/local; not a signed-binary SBOM |

Default npm test skips opt-in Temporal, discovery, inference and external staging DB cases. Enabling a real test makes errors fail; it never swaps to a mock. Unit inference doubles are confined to tests and labeled. MCP HTTP tests use actual protocol servers with an explicit test-only loopback transport. Production remote MCP still rejects private addresses.

Temporal test-server persistence is ephemeral/in-memory: these tests exercise actual workflow machinery, dispatch and PostgreSQL state, but do not prove Temporal cluster disaster recovery. The cloud workflow is registry.refresh, **not the local agent DAG**.

## Actual model/tool observations

| Demo | Measured elapsed | Real model turns | Real tool calls | Restored events / verified final events |
|---|---:|---:|---:|---:|
| Repository read | 1,918 ms | 2 | 1 | 6 / 17 |
| Public HTTPS retrieval | 2,460 ms | 2 | 1 | 6 / 17 |
| MCP text utility | 1,904 ms | 2 | 1 | 6 / 17 |
| Recoverable repository write | 8,438 ms | 2 | 1 | 6 / 17 |

Actual model: qwen2.5-coder:7b. These are single observations during the batch, not p95, task-quality estimates or a competitor benchmark. Raw records: [read](../evidence/governed-read.json), [research](../evidence/governed-research.json), [MCP](../evidence/governed-mcp.json), [edit](../evidence/governed-edit.json); matching audit JSONL files are alongside them. Only machine-specific output directory names were normalized for publication. CLI restore reopens databases; full Electron restart is covered separately by the live desktop test.

The edit really changed the generated file with recovery backup and hash checking, but the model incorrectly said the tool did not return a hash. This output is preserved in the evidence. **Execution success is verified by receipts/file contents, not the model's narration.** The UI now shows system evidence separately; semantic quality still requires review. Earlier native-parser and loose-JSON demo attempts failed explicitly; explicit JSON schema constrained generation fixed protocol handling without treating arbitrary prose as commands.

Packaged single-launch timing and exact archive hash: [package receipt](../evidence/governed-package.json). One warm/cold-unspecified sample is not a startup SLO. Installer is unsigned; do not present it as a production release. Large ~3.0 MB renderer chunk and deprecated transitive build packages remain maintenance work.

## Demo and costs

Run **npm run demo:desktop** to execute actual local inference and open the completed run. Other demos and the interactive approval walkthrough: [governed tools](../governed-tools.md). The new generated workspace cannot overwrite your repository. The desktop never automatically grants the scripted demo's permissions to other runs.

No paid cloud inference or cloud infrastructure was provisioned. Local execution consumes the user's machine/electricity; no unmeasured monetary estimate is invented. Cloud usage remains unknown without the chosen provider/model/region/volume. Displayed absent cost is unknown, not zero.

## Remaining release risks and smallest next delivery

The full missing-feature list is in [Stage 1 gates](../product/stage-one-gates.md) and [roadmap](../product/roadmap-two-steps.md). Highest next acceptance slice: remote MCP OAuth with resource-bound credentials and step-up consent, plus a real configured identity/provider staging run. Independent gaps also remain in terminal/LSP/GitHub, isolated workers, cloud agent Temporal workflows, hierarchical quotas/cancellation, financial budgets/failover, browser automation, TLS/IAM, signed updates, external audit anchoring and cross-platform/load/chaos tests. These are implementation gaps as well as missing credentials; credentials alone will not complete Stage 1.

Local MCP processes have OS-user authority. Documents and transcripts are plaintext. Repository prechecks are not a hostile-writer sandbox. Vault protection does not defeat same-user malware. OIDC desktop login does not grant backend tenant permissions and has no refresh rotation. Model-output quality and arbitrary-secret detection are not guaranteed. No production-readiness or "better than Cursor" assertion is made.
