> Historical slice documentation. Current governed tools, credential storage and open Stage 1 gates are described in [governed tools](governed-tools.md). Later evidence supersedes the old feature/limitation list below.

# Workflow Studio — local MVP

## What it does

Build a bounded agentic workflow without writing code: assign roles/models, connect upstream results, execute independent branches concurrently, inspect output, approve a review node, and export Markdown with provenance. These are text-inference agents, not autonomous shell/browser/tool agents. The default document-analysis template has two independent readers, a synthesizer, a human review, and a report.

The original repository editor and Git status/diff remain available through **Mở IDE**. The existing PostgreSQL/Temporal registry control plane and PGlite demo remain separate; Studio does not silently fall back to them.

## Local setup

Requirements: Node **24.x**, npm 11, Git, Windows (tested); Electron macOS/Linux are not verified in this batch. Install dependencies from the lockfile:

~~~sh
npm ci
npm run setup:desktop
npm run dev
~~~

Studio creates its database on first launch; no SQL server, Docker, Temporal, API token, or cloud account is needed. For actual inference, install/start [Ollama](https://docs.ollama.com/api/chat) and install chat models suitable for your hardware using Ollama's own tools. Check installed models with:

~~~sh
ollama list
~~~

The default endpoint is exactly http://127.0.0.1:11434. If Ollama is not already running, use `ollama serve`. The optional SAND_OLLAMA_ORIGIN must be an exact http://127.0.0.1:<port> origin. SAND does not download models automatically. The real validation used qwen2.5-coder:7b and llama3:latest; these are observations, not a hard-coded model catalog or universal hardware recommendation.

## Desktop walkthrough

1. Click **Kết nối / tìm model**. Missing credentials/server show their real status. Source and observation time are available; discovery does not imply chat capability.
2. Click **Điền model cho các agent còn trống**, or select a model per agent. The helper prefers discovered local models and alternates models; review its choices before running.
3. Select each node to edit role/instructions/output limit and dependencies. Root agents see the original document; descendants also receive only connected upstream outputs. Cycles/missing configuration block running. Add/remove nodes with the inspector. Save creates a new revision.
4. Paste a permitted document or import .txt/.md/.csv (16,000 characters maximum). No upload, vector database, Internet research or spreadsheet parsing occurs.
5. Click **Chạy workflow**. Select nodes to inspect model, result, time and usage. Independent requests dispatch concurrently; Ollama may queue actual computation depending on RAM/GPU settings.
6. At **Cần bạn duyệt**, inspect the actual synthesis. Close/reopen SAND and select the waiting history item: the checkpoint remains. Choose **Duyệt và tiếp tục** or **Từ chối**.
7. Select **Báo cáo cuối** and **Xuất Markdown**; choose a new filename. Existing files are refused, never silently overwritten. Open **Timeline & audit → Verify ledger**.

The review node is optional in custom graphs. Only workflows containing a review gate require that review; exports always require all nodes to complete and a valid internal audit chain. Export is an explicit native-dialog action, not model filesystem access. Unsaved editor-form/input changes are not a saved run; save definitions before closing. The Studio blocks switching to the IDE while the definition is dirty.

## Repeatable evidence demo

With two distinct locally installed text/chat models:

~~~sh
npm run demo:studio
~~~

This makes **three real local inference calls**, checks the human-review gate, closes/reopens SQLite, asserts event preservation and attempt counts, explicitly approves the non-sensitive example, verifies the audit, and writes summary.json, audit.jsonl and report.md into a new .runtime/studio-demo-*/ folder. It never deletes earlier runs or substitutes fake output. Missing server/models fail visibly. An optional SAND_DEMO_MODELS value contains two comma-separated IDs already present in discovery.

The separate `npm run demo` / `npm run test:demo` path still tests actual PGlite/HTTP admission and new-process replay **without inference**. See [its report](reports/resume-ready.md).

## Cloud configuration and current contracts

| Provider | Implemented | Evidence in this batch |
|---|---|---|
| Ollama | Discovery and non-streaming text chat | Real CLI and Electron multi-model E2E |
| OpenAI | Discovery; basic Chat Completions text adapter | Adapter source; cloud inference not live-tested, no key available |
| OpenRouter | Discovery/pricing metadata; basic chat adapter | Adapter source; cloud inference not live-tested, no key available |
| Anthropic / Gemini | Existing discovery | No Studio inference adapter |

Inject OPENAI_API_KEY or OPENROUTER_API_KEY into the **desktop main process environment** using your secret-management mechanism before launching. There is no key entry field or keychain integration yet. Never place keys in workflow text, a committed file, command-line arguments or localStorage. Cloud workflows require an explicit per-run checkbox to share their document and connected outputs. No automatic retry or model switch occurs. Only text-chat-compatible discovered models work; capability filtering/streaming/tool calls are not implemented. Unknown token counts or prices remain unknown. OpenRouter costs are shown only if its actual response provides them, with endpoint source and observation time.

## State, cancellation and recovery

- SQLite WAL + synchronous FULL, embedded migration user_version=1, immutable run definition/input, versioned editable definitions, transactional step/event transitions and stable per-run sequence. One Electron instance owns the local database.
- Pause stops dispatching new nodes; current provider calls may finish. Cancel aborts HTTP and fences late replies. It cannot promise immediate remote compute/billing cancellation.
- On reopen, in-flight calls become interrupted. Explicit resume retries only failed/interrupted steps; completed checkpoints remain. A provider may already have processed/billed an interrupted call. Exactly-once provider requests are **not** claimed.
- Limits: 12 nodes, 4 concurrent calls/run, 3 executing workflows including paused calls still in flight, 16k input characters, 30k context/instruction characters, 4,096 output tokens/node, 180-second HTTP deadline. These are bounds, not organizational quotas or a monetary budget.
- Normal storage: Electron userData/studio.sqlite (+ WAL/SHM) and userData/audit/desktop.jsonl. The desktop API audit hashes arguments/results; the run ledger stores metadata/hashes. Documents/outputs themselves are plaintext in local SQLite. Protect the OS account/device. Close SAND before copying the whole userData directory for an experimental backup; automated encrypted backup/restore is not implemented.
- Hash-chain verification has no external anchor and cannot defeat a local account owner rewriting all database state. Heuristic credential screening is not DLP.

## Verification / packaging

~~~sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package:win
npm run test:package
~~~

The live desktop test is opt-in and fails rather than faking results if configured but unavailable. PowerShell:

~~~powershell
$env:SAND_STUDIO_LIVE_TESTS='1'
npm run test:e2e
Remove-Item Env:SAND_STUDIO_LIVE_TESTS
~~~

Deterministic tests use inference doubles only inside test files. The live export test substitutes the native chooser selection in the test process, then exercises the real IPC writer, reads the file and verifies overwrite prevention. Installer generation and unpacked executable smoke are distinct from install/uninstall lifecycle validation. This is an **unsigned preview**, not a production release.

## Handoff gate

Try one non-sensitive document from your field. Record the intended outcome, edited roles/models, confusing UI steps, incorrect output and any reproducible error. [The two-stage roadmap](product/roadmap-two-steps.md) stops here for feedback; stage 2 contains tools/MCP/web/GitHub, cloud durability, identity, spending controls, signing and domain-specific UX.
