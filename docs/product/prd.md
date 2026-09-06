# SAND — Product requirements, v0.1

Trạng thái: foundation được thiết kế; chưa production-ready. Chủ sở hữu: nhóm SAND. Ngày: 2026-09-07.

SAND là desktop workbench cho developer chuyên nghiệp muốn giao việc nhiều bước cho AI nhưng vẫn kiểm soát được repository, quyền, dữ liệu và chi phí. Giá trị cần chứng minh là khôi phục run, replay timeline và provenance từ yêu cầu đến thay đổi đã test. Không tuyên bố vượt Cursor trước khi chạy benchmark đối chứng.

## Người dùng và hành trình

1. Developer chọn repository bằng native dialog, xem Git status, mở/sửa/lưu file với phát hiện xung đột; không tự thực thi code trong repo.
2. Developer kết nối control plane, thấy trạng thái thực của hạ tầng/provider, gửi một workflow có idempotency key và xem timeline đã persist khi reconnect.
3. Khi agent runtime được kiểm chứng, developer giao task, duyệt action cụ thể, xem test/diff/cost và tạo draft PR qua GitHub App.
4. Operator xem run bị kẹt, quota, audit integrity và phục hồi bằng thao tác có quyền; không sửa lịch sử để tạo thành công giả.

## Phạm vi sản phẩm

Desktop IDE (Monaco, LSP, PTY, Git, search, browser, tests); durable local/cloud agents; unified policy/MCP; live provider registry/routing; isolated workers; production operations. Toàn bộ yêu cầu chi tiết của đề bài là release scope, không phải mô tả trạng thái hiện tại.

Batch 01 là nền móng: mở/sửa repository thật, shell desktop, control-plane PostgreSQL cho run/event/audit, outbox → Temporal và workflow registry refresh thật. Chưa cấu hình provider thì báo unavailable. Registry refresh không được gọi là agent sửa code. Không tạo UI khẳng định những tính năng chưa có backend.

## Tiêu chí sản phẩm

- Local Windows trước theo giả định ban đầu; macOS là release gate kế tiếp.
- Mọi trạng thái rỗng/loading/error có remediation. Không dữ liệu mẫu trong production path.
- Chi phí chưa biết hiển thị unknown; không đổi thành $0. Giá phải đi cùng source và timestamp.
- Không gửi nội dung repository ra Internet trong batch 01.
- Keyboard-first, focus nhìn thấy được, reduced motion, theme sáng/tối, bố cục laptop/widescreen.
- SLO mục tiêu (chưa đo): API không phụ thuộc provider p95 <300 ms, availability 99.9%, cancel p95 <5 s; accepted run/event không mất; privileged action audit coverage 100%.

## Ngoài phạm vi xác nhận của batch 01

Full IDE parity, agent code editing, microVM isolation, remote MCP OAuth, GitHub App E2E, failover, signed releases, cloud SLO và benchmark thắng Cursor. Từng hạng mục cần evidence riêng trước khi đánh dấu hoàn thành.
