> Historical slice documentation. Current governed tools, credential storage and open Stage 1 gates are described in [governed tools](../governed-tools.md). Later evidence supersedes the old feature/limitation list below.

# Stage 1 local MVP — verified handoff, 2026-09-16

## Delivered

The product direction is a low-code multi-model workflow IDE for domain experts. The [two-stage roadmap](../product/roadmap-two-steps.md) and [primary-source research](../research/agentic-platforms-2026-09-16.md) define a usable document workflow first, followed by user feedback and product hardening. This batch stops at that handoff; it does not claim the initial full production specification is complete.

Usable slice: editable saved DAG → role/model per agent → original document + explicit upstream context → parallel text inference through policy/broker → persisted checkpoints/events → human review → Markdown output with model, usage, timestamp and hashes. Resume is explicit after interruption, cancellation fences late output, and exports refuse to overwrite files. The default template contains review; custom graphs may omit it.

Existing user work was retained: README/PGlite local-demo changes, Store audit metadata, and ADR-011. No git reset, commit, push, deployment or credential changes were performed in this batch.

## Files and architecture

| Files/module | Changes |
|---|---|
| packages/studio/src/schema.ts | Validated bounded DAG, template, run/event/inference contracts |
| packages/studio/src/runtime.ts | Embedded SQLite migration v1, revision/idempotency checks, scheduler, checkpoints, review, cancel/resume, audit/export |
| packages/studio/src/inference.ts | Actual Ollama/OpenAI/OpenRouter non-streaming text adapters; no synthetic fallback |
| packages/studio/src/*.test.ts | Deterministic state-machine, admission, recovery, policy and adapter tests; inference doubles confined to tests |
| packages/providers/src/network.ts | JSON POST through existing fixed-origin/DNS-pinned broker, bounds and cancellation |
| apps/desktop/src/main.ts, preload.ts, shared.ts | Typed Studio IPC, sender/schema validation, native import/export, startup/shutdown |
| apps/desktop/src/renderer/WorkflowStudio.tsx, studio.css, App.tsx | Workflow graph/forms, model discovery, run history, review and output inspector; existing IDE retained |
| services/studio-demo/main.ts, package.json | Repeatable real-local-provider demo and test command |
| tests/e2e/studio.spec.ts, desktop.spec.ts, fullstack.spec.ts | Desktop graph persistence and real workflow; legacy entry-point adjustments |
| scripts/smoke-package.mjs | Packaged Studio entry point/security smoke |
| README.md, docs/studio.md, roadmap/research/ADR/security/evidence files | Setup, scope, architecture decisions, threat model, raw observations and user-feedback gate |

Local SQLite is a separate single-user execution path; PostgreSQL/PGlite/Temporal modules were not replaced. No new dependency or lockfile change was necessary. [ADR-012](../architecture/adrs.md#adr-012--local-workflow-studio-for-the-low-code-mvp-accepted-2026-09-16).

## Commands executed and results

| Command | Final observed result |
|---|---|
| npm run lint | Passed |
| npm run typecheck | Passed |
| npm run test:studio | Initial 13 passed; subsequent full run includes the added admission regression (14 Studio tests) |
| npm test | **145 passed, 11 skipped**, 0 failed; 45.06 s in the final run |
| npm run build | Passed, including Electron main/preload and Vite renderer |
| SAND_STUDIO_LIVE_TESTS=1; npm run test:e2e | **5 passed, 1 skipped**, 0 failed; 48.9 s; live multi-model test 27.5 s |
| npm run demo:studio | Passed with actual Ollama; final run below |
| npm run package:win | NSIS installer generated, publish disabled |
| npm run test:package | Packaged executable starts; sandbox/contextIsolation true, nodeIntegration false |
| Get-AuthenticodeSignature | **NotSigned**; builder log wording is not signing evidence |
| gitleaks dir . --config .gitleaks.toml --redact --no-banner | No leaks found in scanned authored source (~535 KB at scan time); not a proof of complete secret detection |
| npm audit --json | 2 moderate development-dependency findings (Vitest / @vitest/mocker, same advisory); 0 high/critical |
| git diff --check | Final whitespace verification recorded after documentation cleanup |

The default Vitest skips are five Temporal integration cases, five opt-in provider discovery contracts, and one privileged maintenance/audit case. The Electron full-stack PostgreSQL+Temporal registry test is configuration-gated. They were not counted as passes. Real local Ollama inference is verified separately by the CLI and live desktop tests; **no paid cloud inference was run**.

Initial desktop testing found two brittle IPC-key-order assertions; these were fixed to compare sorted allowlists, and the full suite then passed. Independent architecture review found the paused/resumed-workflow admission bypass; a shared admission guard and regression test now cover it. Export response/provenance and no-overwrite behavior were also verified. Test-only native chooser substitution is used for file export; the actual production IPC writer and file contents are exercised.

## Raw measured evidence

Final CLI run: [summary](../evidence/studio-demo.json), [audit JSONL](../evidence/studio-audit.jsonl), [actual generated report](../evidence/studio-report.md). The supplied museum brief is explicitly an example input, not a research dataset or business claim. Model text is untrusted and was not independently scored for domain quality.

- Run: 666fbeb7-8566-4aa5-ad4d-98070d0aafb3.
- Actual models: qwen2.5-coder:7b and llama3:latest, discovered from local Ollama.
- 3 real calls; total **22,595 ms**. Per-call observed durations: 929 / 10,542 / 11,736 ms.
- Reported input/output tokens: **429 / 103** total. No output-limit truncation reported.
- 9 events preserved identically across database reopen; all 3 completed agents remained at attempt 1.
- 12 events passed hash-chain verification after explicit approval and report completion.
- Cloud usage cost: none incurred by these local runs. Local hardware/electricity cost is **not estimated**, so the UI does not claim zero total cost.

[Desktop test evidence](../evidence/studio-desktop-tests.json) includes a real Electron process close/relaunch while review was pending. The CLI closes/reopens its SQLite connection. Deterministic unit tests simulate interrupted execution and late completions; hard power loss/worker escape/cloud outage are not tested here.

[Windows package evidence](../evidence/studio-package.json): installer 112,145,327 bytes; packaged ASAR 4,208,356 bytes; one launch-to-heading sample **1,552 ms**. The unpacked executable was smoke-tested, not the installer install/uninstall lifecycle. Timings are observations on this machine, not p95/SLO or competitor benchmarks. Existing warm model state and provider scheduling affect inference timings.

## Remaining limitations and next handoff

- Basic text agents only: no shell, MCP, autonomous browser/web research, LSP/terminal expansion, GitHub App or tool loop.
- OpenAI/OpenRouter inference adapters lack live cloud validation because credentials were unavailable; Anthropic/Gemini are discovery-only.
- No keychain/OIDC, encrypted local documents, tenant isolation in Studio, monetary reservations, distributed cloud agent runtime, microVMs, TLS deployment or signed updater. Existing PostgreSQL tenant tests concern the separate control plane.
- Unknown provider outcome may incur another charge on explicit retry. Closing the desktop stops its execution. Audit has no external anchor; document credential screening is heuristic. Human review does not validate truth automatically.
- No macOS/Linux validation, broad accessibility audit, workload/chaos testing or production recovery guarantee.
- Vite reports a ~3.0 MB main renderer chunk and Zod annotation warnings. npm audit retains GHSA-82fw-gwwq-j7x9 under Vitest/@vitest/mocker; avoid exposing a test UI server. A major test-runner upgrade was kept outside this MVP batch.

Estimated infrastructure requirement for this local MVP: no hosted backend; uses the user's machine and Ollama. Actual electricity/hardware cost is unknown. Cloud cost needs the chosen model's current provider pricing and real token usage; no unsupported dollar estimate is supplied.

Next smallest deliverable: **the user tries a non-sensitive workflow in their own field and supplies feedback**. Stage 2 starts from reproducible P0/P1 issues and domain needs, as the roadmap specifies. No production-readiness or superiority-over-Cursor claim is made.
