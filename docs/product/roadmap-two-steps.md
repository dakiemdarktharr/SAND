# SAND — roadmap hai bước, phạm vi cập nhật 2026-09-16

SAND là IDE cho chuyên gia ít viết code: mô tả mục tiêu, chọn vai trò/model, nối dữ liệu, giao công cụ có quyền hạn và nhận artifact có nguồn gốc kiểm tra được. Local-first giúp tận dụng máy hiện có; cloud là lựa chọn có consent và chi phí hiển thị rõ.

## Bước 1 — MVP đầy đủ phạm vi người dùng yêu cầu

**Bước 1 vẫn đang thực hiện.** Bản preview chạy được không đồng nghĩa hoàn thành toàn bộ bước này. Yêu cầu autonomous tools/MCP/research/cloud inference/keychain/OIDC/production hardening thuộc bước 1, không chuyển sang bước 2.

| Thứ tự bàn giao | Phạm vi | Trạng thái và gate còn lại |
|---|---|---|
| 1.1 Workflow nền tảng | Composer, DAG nhiều model, parallelism, version, review, artifacts | Có đường chạy local thật; cần conditional/data mapping, reusable subflows và trigger/schedule |
| 1.2 Autonomous tools | Agent loop, per-tool argument approval, durable receipt, repo read/save, research | Có local path và tests; cần policy scope session/project/org, recovery cho unknown outcomes và isolation |
| 1.3 Kết nối | MCP stdio + Streamable HTTP, provider adapters, live discovery | Stdio/live local đã chạy; HTTP dùng server kiểm thử thật; remote OAuth, staging cloud contracts còn mở |
| 1.4 Identity | OS protected vault, system-browser OIDC/PKCE | Vault đã test trên Windows; external issuer, refresh rotation, backend OIDC/RBAC/org chưa hoàn tất |
| 1.5 IDE | Monaco, explorer, safe save, Git inspection | Terminal/PTTY, LSP, tests/problems, full Git/worktree/PR, isolated browser còn thiếu |
| 1.6 Runtime bền vững | Local recovery; PostgreSQL/RLS/outbox/WS; Temporal | Temporal hiện chỉ registry.refresh. Agent DAG cloud, isolated workers, leases/hierarchical cancel và operator recovery còn thiếu |
| 1.7 Kinh tế model | Usage, nguồn/thời điểm của giá; routing/failover | Usage/discovery có; currency reservations, quotas nhiều cấp, health routing, consented failover chưa có |
| 1.8 Release/ops | CI, SBOM, backups, tests, TLS, signing/updater, telemetry | Local backup/restore và source CI có; cloud TLS/IAM, signed updates, WORM, load/chaos/macOS/SLO còn mở |
| 1.9 Demo và benchmark | Repository + research + MCP + multiple models + human review | Có demo kiểm chứng từng luồng; cần benchmark cùng task với các alternative, chưa có claim vượt đối thủ |

Acceptance chi tiết: [stage-one-gates.md](stage-one-gates.md). Mỗi slice phải có backend thật, negative tests, telemetry/audit và tài liệu. Missing credentials phải unavailable/skipped, không thay bằng dữ liệu giả. Các module chưa có không được tính là hoàn thành chỉ vì có mục trên roadmap.

## Bước 2 — Phản hồi của bạn → sản phẩm cuối

Sau khi các gate bước 1 đạt: bạn thử workflow thật trong lĩnh vực của mình; ghi expected/actual, bước tái hiện và run ID. Ưu tiên P0 mất dữ liệu/permission, P1 chặn công việc, P2 onboarding/UX. Polish canvas, keyboard, accessibility, mẫu ngành và khả năng giải thích; đo thời gian tới kết quả đã kiểm chứng và số lần cần can thiệp. Fix/debug kèm regression tests, rồi security/release review và rollout có rollback.

Không đưa các chức năng bắt buộc của bước 1 sang bước 2 để báo hoàn thành sớm. Không cam kết số alpha chất lượng/ngày hoặc parity với n8n/Cursor/Antigravity/Amoeba khi chưa có benchmark.

## Dependency

Local: Node 24, npm 11, Git, Ollama và model đã cài. Không cần Docker/PostgreSQL server để chạy Studio hoặc demo PGlite. Cloud gates: provider credentials và model IDs, OIDC public client/issuer, GitHub App registration, isolated runtime/container host, PostgreSQL/Temporal/S3, TLS/KMS, monitoring và signing identities. Các thứ này chưa được tự mua/cấp phát.
