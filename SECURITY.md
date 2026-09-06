# Chính sách bảo mật SAND

Trạng thái: nền tảng thiết kế, **chưa được chứng nhận production-ready**. Các kiểm soát dưới đây là yêu cầu phải chứng minh bằng mã và test; tài liệu này không chứng minh chúng đã được triển khai.

## Phạm vi và tài sản cần bảo vệ

Phạm vi gồm Electron main/preload/renderer, repository broker, control plane, PostgreSQL, Temporal, workers, providers, MCP, GitHub App, network broker, artifacts, audit và chuỗi phát hành. Repository, issue, trang web, phản hồi model, MCP output và nội dung browser là dữ liệu không đáng tin, kể cả khi chúng chứa câu giống chỉ thị của người dùng.

Tài sản ưu tiên: dữ liệu tenant, mã nguồn, secrets, quyền trên máy người dùng và repository, tính toàn vẹn của run/approval/audit, tiền và quota, bản phát hành và signing keys.

## Các bất biến bắt buộc

1. Main process và backend quyết định quyền; renderer và model không thể tự cấp quyền. API/IPC có schema, allowlist, kiểm tra caller, resource và tenant ở điểm thực hiện.
2. Hành động đặc quyền đi qua policy `allow | deny | ask`; không có policy phù hợp là `deny`. `ask` chưa được chấp thuận không được thực thi. Approval phải gắn với actor, tenant, resource, canonical argument digest, scope, expiry và policy version; thay đổi arguments hoặc scope phải đánh giá lại.
3. Vault/keychain giữ secrets; renderer, prompt, telemetry và audit chỉ nhận reference hoặc trạng thái đã cấu hình. Không lưu credentials trong localStorage, URL, command line hay code repository. Không sử dụng kho plaintext khi secure storage lỗi.
4. Mọi truy cập dữ liệu backend dùng danh tính đã xác thực và tenant đã được server kiểm chứng. Tenant ID do client gửi không phải bằng chứng quyền. PostgreSQL runtime role không được có `SUPERUSER`, `BYPASSRLS` hay sở hữu bảng nghiệp vụ.
5. Filesystem chỉ truy cập workspace đã được chọn và cấp quyền. Từ chối đường dẫn thoát root, thiết bị, alternate data stream, link/reparse point không được hỗ trợ và ghi vào Git metadata. Không chạy shell, hook, package script, extension hoặc LSP chỉ vì đã mở repository.
6. Network của agent/browser/tool phải qua broker với DNS/IP/redirect kiểm tra tại thời điểm kết nối. Mặc định chặn private/link-local/metadata destinations và mọi đích chưa được policy cho phép. Không có đường egress trực tiếp thay thế broker.
7. Run đã được xác nhận phải được commit bền vững. Side effect cần operation key và reconciliation; kết quả bên ngoài không rõ phải chuyển sang `reconciliation_required`, không tự retry thao tác không an toàn.
8. Privileged action cần durable audit intent trước thực thi và audit outcome sau thực thi; thiếu kho audit làm thao tác mới fail closed. Audit không chứa raw arguments, source hay secret; hash chain phải có cơ chế neo ngoài kho mutable để phát hiện viết lại toàn bộ hoặc xóa đuôi.
9. Không bật agent execution nếu chưa có provider thật, admission/budget/policy và worker runtime phù hợp. Local process hoặc Docker development không được gắn nhãn tương đương microVM production.
10. Không merge, force-push, deploy, cập nhật scope OAuth hay xuất dữ liệu vượt policy mà không có quyền cụ thể. Approval trong hội thoại không được thay thế xác thực/ủy quyền runtime của sản phẩm.

## Quy tắc review và phát hành

- Review dùng [threat model](docs/security/threat-model.md), [phân loại dữ liệu](docs/security/data-classification.md) và [security acceptance](docs/security/acceptance.md). Mỗi thay đổi boundary phải cập nhật ADR và threat model cùng batch.
- Findings phải có input/actor thực tế, đường đi đến sensitive operation, quyền mới có thể đạt được, prerequisite và bằng chứng. Phân biệt giả thuyết, source review và runtime reproduction. Không chạy payload phá hoại hoặc gửi dữ liệu ra ngoài để chứng minh lỗi.
- Test fixture/mock chỉ ở test hoặc demo được đánh dấu; production path phải trả `unavailable`/lỗi thật. Contract test thiếu credential phải báo `skipped` kèm lý do và chặn gate tương ứng.
- Chặn phát hành production nếu thiếu signing/notarization phù hợp, update verification, SBOM/lockfile verification, secret/dependency scan, tenant isolation, restore rehearsal, staging provider/MCP/GitHub evidence hoặc production worker isolation evidence.
- Không công bố vượt sản phẩm cạnh tranh, đạt SLO hay an toàn tuyệt đối khi chưa có đo lường tái lập.

## Báo cáo vấn đề

Chưa có kênh vulnerability disclosure công khai hoặc SLA phản hồi được vận hành. Trước khi phát hành phải chỉ định security owner, kênh báo cáo riêng, triage/on-call và thời hạn phản hồi trong tài liệu release. Trong quá trình phát triển, gửi mô tả tối thiểu cho người duy trì qua kênh riêng đã được họ xác nhận; không đăng credential, exploit chứa dữ liệu người dùng hoặc private repository lên issue công khai.

Thông tin hữu ích: phiên bản/commit, môi trường, vai trò ban đầu, bước tái hiện an toàn, tác động, log đã redaction và test hồi quy đề xuất. Nếu nghi ngờ lộ credential, thu hồi/rotate qua hệ thống sở hữu credential; không chép giá trị secret vào báo cáo.
