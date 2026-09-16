# Local Workflow Studio threat model — 2026-09-16

This scoped supplement preserves the earlier [target-system threat model](threat-model.md). It models the local MVP requested by the user, not a production deployment or a completed security assessment. Source citations were checked against the working tree. A separate read-only architecture review was performed; the admission-limit issue it identified was fixed and regression-tested. Review nodes remain optional by design, so export wording now says completed report rather than necessarily reviewed report.

## 1. Overview

React forms and a DAG view call named Electron IPC methods. Main owns local SQLite state, evaluates fixed local/cloud-consent policy, and dispatches text-only HTTP inference. Independent nodes may run concurrently; dependent nodes receive the original document plus only their connected upstream outputs. Human review gates the default template before a report. Model output is displayed as text, never evaluated as code.

| Component | Source / responsibility |
|---|---|
| Desktop entry and IPC | apps/desktop/src/main.ts:22 — validate main frame/origin and schemas |
| Runtime | packages/studio/src/runtime.ts:17 — SQLite schema/WAL/recovery; packages/studio/src/runtime.ts:98 — DAG scheduler |
| Inference | packages/studio/src/inference.ts:20 — fixed endpoint chat payload, bearer in main, no tools |
| Network | packages/providers/src/network.ts:26 — exact origins, public cloud DNS, pinned address, no redirect |
| Review/export | packages/studio/src/runtime.ts:157 and packages/studio/src/runtime.ts:167 — persisted review, completed output, audit check |

| Deployment or workflow | Resource/capability | Configuration and precedence | Safe effective location | Readers/writers/recipients | Enforcing control / unknowns |
|---|---|---|---|---|---|
| Normal desktop | Workflow/input/output DB | Electron userData | <userData>/studio.sqlite plus WAL/SHM | Main; renderer receives selected run data over IPC | OS account permissions; plaintext; apps/desktop/src/main.ts:108 |
| Unpackaged E2E | Same DB | SAND_E2E=1 + SAND_TEST_USER_DATA, otherwise userData | <test directory>/studio.sqlite | Isolated test main/renderer | Override disabled when packaged; same entry point |
| Desktop audit | IPC intent/result hashes | dataRoot above | <dataRoot>/audit/desktop.jsonl | Main LocalAudit | No raw arguments in this ledger; apps/desktop/src/main.ts:110 |
| Local model | Input/instructions/upstream outputs | SAND_OLLAMA_ORIGIN or default | http://127.0.0.1:11434/api/chat, configurable loopback port | Local Ollama process | Exact origin; host process trusted; packages/studio/src/inference.ts:10 |
| OpenAI | Provider key and allowed run data | OPENAI_API_KEY in main environment | https://api.openai.com/v1/chat/completions | OpenAI, with its own key only | Cloud consent, TLS, fixed host broker; packages/studio/src/inference.ts:23 |
| OpenRouter | Provider key and allowed run data | OPENROUTER_API_KEY in main environment | https://openrouter.ai/api/v1/chat/completions | OpenRouter and its downstream provider handling | Same broker/consent; downstream retention is not verified |
| Manual discovery | Credential headers, no document | Only configured providers; public OpenRouter only if enabled | Provider /models or local /api/tags | Corresponding provider only | packages/studio/src/inference.ts:16; registry configuration source |
| Import/export | User document/report | Native file selection, no model-selected path | Selected file | Main filesystem operation | Size/symlink checks on import; exclusive creation on export; apps/desktop/src/main.ts:69 |

## 2. Threat model, trust boundaries and assumptions

Protected assets: documents, outputs, credentials, provider spending, workflow definition integrity, approval/checkpoint state, and audit provenance. A document author or provider may supply arbitrary misleading text, including prompt injection. They do not thereby gain a shell, file API, browser, MCP session or approval call: none exists in the inference protocol. The prompt instruction about untrusted data is advisory; the absence of a tool executor is the enforced boundary.

A compromised renderer does have the entire exposed desktop bridge, including existing repository/control methods; Studio is not a separate renderer security principal. Sender checks reject other frames, not a compromise of the approved frame itself. Sandbox/context isolation/no Node/CSP reduce entry points (apps/desktop/src/main.ts:132); they do not make a compromised trusted UI unable to issue its allowed commands or synthesize cloud consent. This is a local user UI consent model, not independent high-assurance multi-party authorization.

Each accepted run stores an immutable definition/input, consent, steps and audit intent before dispatch (packages/studio/src/runtime.ts:76). Review decisions bind to persisted output hashes and step state. Retry is explicit after an uncertain request; no automatic provider/model failover occurs. Cancel fences subsequent result writes but does not promise remote cancellation or no billing. Admission now counts paused requests still in flight and rechecks start/resume/review (packages/studio/src/runtime.ts:70).

Local OS account, TLS trust store, installed Ollama and application dependencies are trusted prerequisites. Local DB files are plaintext; app signing/keychain/monetary budgets/worker isolation are absent. These differ from SECURITY.md production objectives and are explicitly preview limitations. No claim is made that credential-pattern scanning detects arbitrary secrets. SQLite append-only triggers and hash chaining do not provide an external trust anchor. Shutdown/reopen tests do not establish survival of disk failure or power loss.

## 3. Attack surface, mitigations and attacker stories

Scenarios below guide review; they are not reported vulnerabilities.

| Priority | Scenario and capability gain | Prerequisites | Impact | Existing controls | Mitigation / residual | Evidence |
|---|---|---|---|---|---|---|
| P0 | Inject document instructions to execute host code | Model must have an executable tool route | Host compromise if route later added | Text-only requests; plain text rendering; no tool loop | Require a new threat review before tools/MCP/browser | packages/studio/src/inference.ts:25 |
| P0 | Exfiltrate input to arbitrary URL/private service | Control over destination or redirect | Data disclosure/SSRF | Fixed HTTPS host or exact loopback; DNS/IP pinning; redirects denied | Test broker on each new adapter; proxy/retention policies not implemented | packages/providers/src/network.ts:26 |
| P0 | Leak provider keys through prompt/log/UI | An accidental secret-bearing payload or compromised main | Credential compromise | Main-only env/config; explicit messages exclude config; hashes in command audit; pattern screening | Keychain and systematic secret canaries remain necessary; env is not vault | packages/studio/src/inference.ts:24; packages/studio/src/runtime.ts:12 |
| P1 | Replay/uncertain requests incur repeated spending | Call processed before local receipt or user resumes | Duplicate provider charge | No auto retry; completed checkpoints retained; explicit resume warning/event | No exactly-once claim or spend budget; operation key only deduplicates local admission | packages/studio/src/runtime.ts:81; packages/studio/src/runtime.ts:150 |
| P1 | Bypass review or change reviewed data | User changes graph or compromised trusted UI | Unreviewed/incorrect artifact | Immutable run snapshot; persisted waiting output; state checks; optional explicit review node | Graph omitting review is an authorized user design, not universal approval enforcement | packages/studio/src/runtime.ts:157; packages/studio/src/schema.ts:38 |
| P1 | Exhaust provider work by repeated pause/start/resume | Local UI authority | Resource use/cost | 3 active workflow admission including in-flight paused calls; per-run max4; HTTP deadline | No multi-tenant quota or hard currency cap | packages/studio/src/runtime.ts:70 and runtime admission test |
| P1 | Rewrite audit or read another local person's documents | Access to OS account/database | Local confidentiality/provenance loss | Append-only SQL triggers/internal hash verification | Plaintext; no external anchoring, encryption, retention, or multi-user isolation | packages/studio/src/runtime.ts:28; packages/studio/src/runtime.ts:69 |
| P1 | Import link swap/export overwrite | Concurrent writer or existing selected file | Reading unintended content / data loss | lstat and secret/size checks; exclusive wx export | Import precheck is not atomic handle-based defense; do not use with hostile concurrent writers | apps/desktop/src/main.ts:78; apps/desktop/src/main.ts:74 |
| P1 | Deliver malicious unsigned desktop build | Distribution compromise | App-level code execution | No automatic updater; local build only | Production requires signing and update verification; Windows preview is NotSigned | package.json build config; package verification report |

## 4. Severity calibration

Critical would require a reachable untrusted input gaining broad host execution or equivalent independent privilege; model text alone with no tool route does not establish that. High could include credential disclosure to an unauthorized recipient through an actual application route. Medium may fit a bounded resource/approval defect with demonstrated prerequisites and impact. Low covers limited metadata or hardening gaps without a supported escalation chain. An OS-account owner reading their own plaintext SQLite, or intentionally omitting a review node, is not evidence of a remote cross-tenant vulnerability. Confidence and test gaps are separate from severity.

Repository: github.com/dakiemdarktharr/SAND (local Workflow Studio scope)
Version: sha256:1d001bb55e2a2e8a7c2d883b5642d14303817cea1a57ce9e89f3c705ee441d2b

## 2026-09-16 governed-tools boundary update (supersedes text-only assumptions above)

The earlier independently reviewed snapshot was text-only; it does not constitute review of this extension. Agents now reach named tools through packages/tools/src/agent.ts. The shared policy returns ask, and a durable one-time approval binds run, node, exact argument digest, tool manifest and workspace identity. Unselected tools are denied. Prompt instructions are advisory; enforcement is in the broker and journal. Tool output is treated as untrusted text, size-limited and pattern-scanned.

New assets: tool arguments/results and model transcripts in plaintext tools.sqlite; OS-encrypted credentials.enc; OIDC callback/code/verifier/tokens in main memory; configured MCP process authority. Journal schema version 1 is separate from Studio schema version 1. Every intent is persisted before tool execution; interrupted executing calls become unknown and are not retried. Tool receipt and Studio event are different transactions; a crash can leave a receipt without its completion event. Replay records receipt consumption rather than repeating the effect. Hash chaining is still not externally anchored.

New egress: explicit approved public HTTPS requests through packages/tools/src/egress.ts. It rejects private DNS results, pins the selected address, rejects redirects/credentials in URLs, caps bytes/time and streams with backpressure. Research accepts text/HTML/JSON only. Wikipedia search is encyclopedia search, not a general search engine. Query arguments are visible before consent; pattern scanning is not a proof that arbitrary secrets cannot be exfiltrated.

MCP stdio requires native server-start consent and a reduced environment, but inherits the OS user's authority and can read that user's files. It is not isolation. Remote MCP uses the same broker and does not implement OAuth/token passthrough. Both tool-list retrieval and per-call manifest consistency checks are bounded. Tool/server descriptions can contain injection; they never grant privileges.

Vault: OS encryption is required and Linux basic_text is rejected. Windows DPAPI does not protect against same-user processes; macOS signing/Keychain remains unverified. Main imports keys from launch environment; no renderer key-entry or key-read API exists. Actual Windows encrypted-canary E2E covers this path. OIDC uses system browser + fixed loopback exact callback + S256/state/nonce/JWKS validation. It is a desktop login foundation, not backend multi-tenant authorization; external issuer, refresh rotation and device/session revocation gates remain open.

Tests: packages/tools/src/agent.test.ts (denial, bindings, unknown outcomes, cached receipts, backup/restore), mcp.test.ts (real stdio and HTTP/SSE fixture servers), egress.test.ts (private/invalid origin denial), identity.test.ts (crypto claims and vault failure), and tests/e2e/studio.spec.ts (real OS vault, real Ollama, full desktop restart with pending approval). No claim of exhaustive adversarial testing, worker escape resistance, completed external security review or production readiness.
