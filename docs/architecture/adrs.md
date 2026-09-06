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
