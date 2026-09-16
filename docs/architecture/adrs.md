# Architecture decision records

Ngày quyết định: 2026-09-07. Accepted là quyết định thiết kế, không chứng nhận implementation hoàn tất.

## ADR-001 — Electron thay cho Tauri 2 (accepted)

Context: cần Monaco, Node tool ecosystem, PTY, Git/process integration trên Windows/macOS. Electron dùng Chromium nhất quán, main/preload/renderer boundaries và ecosystem Node; đổi lại footprint và attack surface lớn hơn, cần cập nhật Chromium đều. Tauri 2 có Rust core và capabilities, dung lượng nhỏ hơn nhưng thêm Rust/sidecar bridge và khác biệt webview khi tích hợp editor, PTY, OAuth callbacks, watchers/updater/tool ecosystem. Chọn Electron để giảm số runtime bridges trong first production version. Tauri chưa được benchmark cho các tiêu chí này, nên không chọn dựa trên giả định tương đương. Revisit nếu startup/RAM của Electron không đạt ngân sách đo được.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Tauri security](https://v2.tauri.app/security/). Accessed 2026-09-07.

## ADR-002 — Modular monolith + worker processes (accepted)

Control plane TypeScript/Fastify, module boundaries rõ. PostgreSQL source of truth; Temporal chỉ sở hữu execution history/timers/retry, application views ở DB. Không tạo service riêng cho mỗi domain; tách code execution, egress và secrets theo trust boundary. Chi phí: phải quản lý schema và workflow versioning đồng thời.

## ADR-003 — Transactional outbox + deterministic workflow ID (accepted)

Admission ghi run/event/audit/outbox nguyên tử. Dispatcher claim có lease, start Temporal ID `sand/<tenant>/<run>`, mark delivered sau start. Already-started cùng ID được reconcile, không khởi tạo run mới. Worker writes cũng cần deterministic event/effect keys. Không promise exactly-once external side effects. Reference: [Temporal TypeScript](https://docs.temporal.io/develop/typescript), accessed 2026-09-07.

## ADR-004 — Tenant isolation at database + authenticated context (accepted)

Tenant không lấy từ JSON body tùy ý. JWT/session → validated membership → transaction-local tenant. FORCE RLS và composite FK; runtime role không superuser/BYPASSRLS. Migrator role tách riêng. Local-only identity là development mode explicit, bind loopback, production từ chối khởi động. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), accessed 2026-09-07.

## ADR-005 — Persisted replay and audit (accepted)

Per-run sequences cấp phát trong transaction với row lock. ACK chỉ tối ưu delivery; event retention tách khỏi live connection. REST fallback dùng cùng schema. Audit append-only hash chain, redaction trước persist; WORM checkpoint/signing required cho enterprise tamper evidence ngoài DB administrator boundary.

## ADR-006 — One policy engine, no ambient execution (accepted)

Actor/project/tool/arguments/resource/environment/cost cùng được evaluate. Explicit deny thắng allow; unmatched deny; ask không phải permission. Approval phải gắn digest arguments + policy version + scope + expiry, consume atomically. Repo file content, website và MCP output không có quyền thay policy. Agent execution mặc định disabled cho tới isolation tests.

## ADR-007 — Live registry, unknown metadata preserved (accepted)

Model list lấy từ provider API; normalize trường không được API công bố thành unknown/null. Pricing/capability có evidence source + observedAt, snapshot history và operator override provenance. Separate pricing ingest bắt buộc trước cost routing. Không dùng static model list hoặc giá ước đoán làm truth. Discovery không chứng minh inference/tool-call contract.

## ADR-008 — Desktop credentials and network boundary (accepted)

Renderer không giữ credential/token; main broker chỉ expose thao tác allowlist, validate sender/frame và args. OS-backed secret storage, Linux plaintext fallback phải bị từ chối. Local dev backend credentials không được trộn vào release authentication. Renderer chỉ chạy packaged code, CSP chặn network tự do; main provider/network client có destination allowlist. General browser/HTTP tools đóng cho tới DNS pinning, redirect/SSRF tests. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), accessed 2026-09-07.

## ADR-009 — Development and production worker runtimes (planned)

Interface reserve/start/heartbeat/cancel/terminate/collect/reclaim. Local process chỉ trusted infrastructure activities, không chạy untrusted repository scripts; Docker dev là explicit reduced isolation. Production Kata/Firecracker cần separate namespace, quota, read-only base image, ephemeral disk, seccomp, no socket/host credential mounts; runtime selection fail closed.

## ADR-010 — Signed release gates (accepted)

Electron builder tạo Windows NSIS/macOS DMG; unsigned artifacts chỉ là development preview. Production yêu cầu Authenticode + Apple Developer/notarization, updater signature verification, pinned lockfile, SBOM, dependency/secret scans, restore/security/load/cross-platform evidence. Không publish tự động trong batch 01.

## ADR-011 — Explicit offline PGlite demo (accepted, 2026-09-11)

The recruiter demo uses disk-backed PGlite through the existing Database/Store interfaces and unchanged SQL migrations. It runs the real Fastify API with a scoped development policy, a non-owner runtime role, serialized single-session transactions and a directory ownership lock. Bootstrap creates one explicitly labeled development project; no model, worker or provider responses are fabricated. The existing network PostgreSQL API and Temporal worker do not import this adapter and retain their production startup gates.

The CLI proves authenticated HTTP admission, policy rejection, idempotency, cancellation intent and stable event/audit replay after graceful server-process exit and reopening the same directory. It intentionally leaves execution queued/cancellation_requested: no Temporal server or inference is launched. PGlite is a development dependency and this mode requires npm ci including dev dependencies. This is not a production fallback, native PostgreSQL concurrency benchmark, abrupt crash/power-loss test or agent execution claim. A fresh directory per invocation prevents overwriting earlier evidence; stale locks require operator inspection, never automatic deletion.

Audit body JSON now includes safe policy decision/reason/matched-rule identifiers for admission and a cancellation reason. Existing ledger rows are unchanged; no SQL migration is necessary because bodies are append-only text with a canonical hash.

## ADR-012 — Local Workflow Studio for the low-code MVP (accepted, 2026-09-16)

Use Node SQLite in Electron main for a single-user local DAG runtime. Verified node:sqlite is available in the installed Electron 44 runtime. WAL + synchronous FULL, transactional immutable run snapshots, node checkpoints, event hash chains and an Electron single-instance owner make desktop workflows independent of external service setup. This is a separate local execution mode, not a replacement or silent fallback for the PostgreSQL/Temporal cloud architecture. SQLite SQL migrations are embedded/versioned for this module; existing PostgreSQL migrations stay unchanged.

MVP agent nodes perform one bounded text inference each with explicit dependencies; independent nodes can overlap. Model output is untrusted text, not executable instructions. No generic terminal, network, browser, filesystem or MCP capability is exposed to these nodes. Human review is a durable explicit node. Cloud transmission requires per-run consent. Secrets remain environment-owned in main; keychain onboarding belongs to step 2. Interrupted requests have unknown provider outcome and require explicit resume permission because a retry may incur a second bill; completed checkpoints are not replayed. No exactly-once provider billing claim. Cloud failover is not automatic.

The custom local runner is limited to 12 DAG nodes / 4 concurrent text calls, immutable graph snapshots and manual input. It must not grow into a second general cloud orchestrator: Temporal remains the target for cloud execution, distributed leases, task queues and durable tool side effects. Packaging must exercise real Electron SQLite, not only Node unit tests.

## ADR-013 — Governed local agent tool execution (accepted, 2026-09-16)

Extend the existing local Studio rather than replace its scheduler. Persist each tool intent, exact argument digest, approval, outcome and agent transcript in SQLite. A crash between external effect and receipt produces an unknown outcome requiring reconciliation, never an automatic retry. Every tool request is denied unless enabled for that node, then requires one-time human approval bound to its arguments and tool manifest. Native repository operations retain their existing recovery/idempotency mechanisms. Read-only research uses an HTTPS broker with DNS pinning, private-address rejection, bounded responses and no redirects. MCP stdio is an explicitly trusted local process, not a sandbox; it is never advertised as worker isolation.

Credentials remain in Electron main. OS-protected encrypted storage must fail closed if the OS backend is unavailable; Windows DPAPI is not protection from another application running as the same OS user. OIDC uses system browser, loopback callback, PKCE S256, state, nonce and signature/issuer/audience verification. External authentication, cloud inference, release signing and isolated execution retain separate live acceptance gates.

The expanded Stage 1 scope requested by the owner supersedes the earlier text-only MVP boundary. Shipping a preview does not close the Stage 1 production gates.

## ADR-014 — Provider/tool protocol and preview release evidence (accepted, 2026-09-16)

Use the pinned maintained MCP SDK v1.30 client for the tested stdio and Streamable HTTP contracts; a later SDK-major migration needs its own compatibility checks. Remote OAuth remains unavailable rather than accepting ad-hoc shared bearer tokens. Ollama may advertise tools yet return call JSON as content; therefore native parsing and explicit JSON-schema tool protocol are distinct node settings. Ordinary text/JSON responses never become commands implicitly. Cloud adapter absence/failure is not replaced by local or fake success.

The preview installer remains unsigned. A separate production package command sets forceCodeSigning and was verified to fail without a certificate. CI uses pinned action commits, a lockfile install, static checks, real local integration/Electron tests and source SBOM. Opt-in credentialed/live suites have distinct evidence. No release is automatically published. The text-only/keychain-in-Stage-2 scope in ADR-012 is superseded by ADR-013 and the expanded Stage 1 gates.
