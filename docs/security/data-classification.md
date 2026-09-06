# SAND — Phân loại và luồng dữ liệu

Trạng thái: policy thiết kế 0.1, 2026-09-07. Retention dưới đây là giá trị đề xuất để operator phê duyệt/cấu hình trước production; chưa có cam kết dịch vụ đang vận hành.

| Class | Ví dụ | Lưu trữ/recipient được phép | Quy tắc xuất và thời hạn đề xuất |
| --- | --- | --- | --- |
| `public` | Public documentation; model ID; pricing công khai có source/timestamp | Registry/cache; renderer; provider nếu policy cho phép | Cache có `fetchedAt`, `expiresAt`, source; stale/unknown được hiển thị rõ |
| `internal` | Project settings, tool manifest, health/latency tổng hợp | Tenant-scoped DB; renderer sau authz | Export theo role; 30 ngày cho operational telemetry mặc định |
| `confidential` | Source code, prompts, issue/PR private, tool output, file paths, artifacts | Workspace; tenant DB/object storage encrypted; model chỉ khi data policy cho phép | Default deny external sharing; artifacts 30 ngày, run content 30 ngày; project/org có thể rút ngắn |
| `restricted` | PII, customer datasets, production config không chứa credential, IP/device metadata | Scope nhỏ nhất; encrypted store; redacted renderer nếu được phép | Provider/region/retention phải explicit; raw IP không thu mặc định; operational metadata 7 ngày trừ policy khác |
| `secret` | API/OAuth token, signing/private keys, cookie/session secret, DB/cloud credential | OS keychain hoặc KMS/Vault; in-memory broker đúng purpose | Không renderer/model/log/audit/plaintext artifact; short-lived credential, revoke/rotate; không copy vào source hoặc clipboard tự động |

Class mặc định cho repository và tool output là `confidential`, không phải `public` chỉ vì agent có thể đọc. Unknown classification không được làm tăng quyền. Organization có thể tăng mức bảo vệ; project/user không được giảm thấp hơn policy organization. Khi trộn dữ liệu, output kế thừa class cao nhất cho đến khi declassification được audit và cho phép.

## Luồng được phép

1. **Local source → renderer:** main broker xác thực workspace/path, giới hạn kích thước và lọc file/content được phân loại secret trước khi trả. Source hiển thị để chỉnh sửa không mặc nhiên được gửi đến cloud. Không đưa `.env`, private keys, credential stores, browser profiles hoặc Git credential material vào explorer preview/model context theo mặc định. Scanner cần xử lý metadata và embedded credential phổ biến; scanner không bảo đảm phát hiện mọi secret không có pattern.
2. **Source → model:** context builder chỉ lấy dữ liệu đã policy cho phép, ghi source references/digests và provenance. Secret broker không có API cung cấp credential plaintext cho context builder. Provider nhận dữ liệu theo classification, region, retention và ZDR policy đã kiểm chứng; fallback phải qua cùng kiểm tra.
3. **Credential → external service:** broker giải reference, gắn credential vào đúng request cho đúng audience/resource; không chuyển token sang MCP khác. Auth headers và cookies bị loại trước logging. Không đặt credential vào URL/query, child-process command line, tool arguments hoặc model messages. Worker chỉ nhận capability ngắn hạn đúng purpose khi thiết kế cần.
4. **Tool output → model/UI/artifact:** output là untrusted input; giới hạn byte/time/MIME; redaction trước khi ghi sink. HTML không được đưa vào privileged renderer bằng raw injection. Attachment/download cần quarantine và policy trước mở.
5. **Actions → audit:** metadata được allowlist, không lưu raw payload. Lưu actor/tenant/project/run/task/tool/target reference, canonical input/output digest, policy/approval/model/source commit/result/cost. Secret-bearing fields phải bị loại hoặc dùng HMAC có key quản lý; hash plaintext secret ngắn có thể bị dictionary attack.
6. **Logs/traces/crash reports:** structured allowlist, correlation IDs không chứa token. Không stringify toàn bộ request/error/environment/process memory. Trace baggage không chứa PII/secret. Crash dump có nguy cơ secret và mặc định tắt cho đến khi pipeline được kiểm chứng.

## Các loại kho và quyền

| Kho | Nội dung | Kiểm soát phải triển khai | Hủy/khôi phục |
| --- | --- | --- | --- |
| OS keychain | Desktop credential references và giá trị được broker dùng | Access từ main, namespace theo installation/account, fail closed nếu unavailable | Device revocation xóa local entry và revoke upstream nếu có |
| PostgreSQL | Tenancy, run/task/step/tool metadata, policy, approvals, event/audit records | RLS với role non-owner; encryption at rest; tenant context transaction-local | Migration versioned; deletion request không phá retention/audit integrity |
| Temporal | Workflow state + references + minimal redacted arguments | Không chứa raw provider token/secret; mTLS/authz/namespace boundaries | Workflow/history retention theo policy; reset/replay không phục hồi capability đã thu hồi |
| S3-compatible storage | Artifact/log lớn/snapshot đã policy kiểm tra | Tenant authz tại API + storage IAM, encryption, bounded signed URLs, optional WORM | Lifecycle tenant aware; backup/restore test bao gồm retention/deletion markers |
| Audit ledger | Metadata tamper-evident | Append-only app role, serialized hash chain, external anchor/signature; optional WORM | Đề xuất 365 ngày; rotation/retention segment có signed manifest để verification vẫn có nghĩa |
| Metrics/debug | Aggregated counts, latency, redacted errors | Tách audit; label cardinality/PII bounds; RBAC | Đề xuất 30 ngày metrics, 7 ngày debug; không dùng để phục hồi accepted run |

Các thời hạn phải được resolve thành policy snapshot của organization trước ghi dữ liệu; chúng không phải constants duy nhất rải trong code. Legal hold là trạng thái explicit có quyền và audit; không âm thầm giữ mọi dữ liệu vô thời hạn.

## Yêu cầu triển khai và bằng chứng

- Admission/routing hiển thị giá có currency, unit, source URL/API, `fetchedAt`, effective date nếu có, operator override provenance. Thiếu giá là `unknown`, không phải miễn phí.
- UI hiển thị model/provider thực tế và data policy của từng step; đổi recipient/region/scope phải tái đánh giá và hỏi khi policy yêu cầu.
- Export JSONL không bao gồm token/raw prompt mặc định; export confidential data cần scope và audit riêng. Download URL dùng short expiry, đúng tenant/object, không xuất hiện trong analytics.
- Test canary đi qua success/error/retry/cancel/failover/log/audit/renderer/model capture. Synthetic canary không được là credential thật. Real-provider tests dùng staging secret injection an toàn, không snapshot raw request headers.
- Secret scanning trước commit/build, lockfile verification và dependency/SBOM checks phải là CI evidence. Không dùng scan pass để chứng minh không có secret tuyệt đối.
- Backup/restore phải kiểm tra encryption, IAM, tenant isolation, audit anchors, retention và revoked session/credential behavior sau restore.
