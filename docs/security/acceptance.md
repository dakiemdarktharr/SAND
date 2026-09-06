# SAND — Security acceptance và release gates

Đây là danh mục kiểm chứng, **không phải kết quả test**. Khi viết tài liệu, mọi mục ở trạng thái `not-run`. Chỉ cập nhật trạng thái cùng commit, command, môi trường, thời điểm và artifact kết quả thật. Test bị `skipped` không hoàn thành gate. Test thuần code không thay thế integration/E2E với PostgreSQL, Temporal, OS, provider hoặc worker thật khi boundary phụ thuộc thành phần đó.

## Gate cho từng vertical slice

| Gate | Bằng chứng tối thiểu | Phạm vi chưa được phép tuyên bố |
| --- | --- | --- |
| Batch 1 local repository | IPC/path/repository policy unit + real temporary Git repository integration + Electron E2E mở/sửa/readback; writer optimistic conflict; audit metadata thật | Không gọi là agent sandbox, production authentication hay cloud IDE hoàn chỉnh |
| Batch 1 durable foundation | Migration với PostgreSQL thật, runtime RLS role, accepted-run/outbox commit, Temporal thật, event replay + audit integrity integration | Không tuyên bố no-loss/crash recovery nếu chỉ có in-memory tests hoặc schema/UI |
| Identity/policy | OIDC/PKCE flow staging, session revocation, tenant tests, approval binds exact payload; deny/ask thực sự chặn consumer | Config screen hoặc policy evaluator đơn lẻ không hoàn thành authorization |
| Provider/MCP/GitHub | Contract tests thật và success/error/cancel/readback, secret captures, missing-credential skip evidence | Không dùng test fake provider để báo integration thành công |
| Isolated durable agent | Production runtime isolation, network/quotas/cancel/crash/failover/operator recovery và external side-effect reconciliation | Docker development hoặc local process không hoàn thành microVM gate |
| Production release | Cross-platform installer/update signature, security review, backup restore, operational SLO evidence, benchmark, on-call/runbook | Không công bố production-ready/SLO đạt/vượt Cursor trước evidence |

## Test cases bắt buộc

| ID | Test và kết quả bắt buộc | Loại / môi trường |
| --- | --- | --- |
| SEC-IPC-01 | IPC từ frame/URL/window không được phép, payload sai schema và command lạ đều bị từ chối trước filesystem/process/secret access | Unit + Electron E2E, Windows/macOS |
| SEC-IPC-02 | Renderer `nodeIntegration=false`, `contextIsolation=true`, sandbox enabled; không có generic exec/secret getter; navigation/new-window/permission requests bị policy kiểm soát; CSP không cho remote privileged code | Source review + packaged E2E |
| SEC-REPO-01 | Mở/list/read repository chứa hook/package script/untrusted markdown không chạy code; content secret bị chặn/redact; chỉ user-selected root tạo handle | Real temp repository + E2E |
| SEC-REPO-02 | Status/diff thật hoạt động; malicious filenames không biến thành options/shell; external diff/textconv/fsmonitor helper không được chạy; output/time bounded | Git executable thật, integration |
| SEC-PATH-01 | `../`, absolute paths, sibling prefix collision, mixed separators, UNC/device/reserved names/ADS bị reject; repo metadata và file ngoài root không đổi | Unit + filesystem integration, Windows/macOS |
| SEC-PATH-02 | Symlink/junction/reparse point escape ở target và ancestors bị reject; controlled link-swap race không ghi ngoài root, hoặc runtime bị chặn cho workload đó và limitation documented | Native filesystem adversarial integration |
| SEC-PATH-03 | Save dùng expected content hash/revision, concurrent external edit trả conflict; failed write không làm mất bản gốc; retry cùng operation không ghi lặp; không overwrite/delete ngoài thao tác được cấp | Integration + desktop E2E |
| SEC-SECRET-01 | Synthetic key/token/cookie canaries không xuất hiện trong renderer payload/log, model context, trace, audit, error response, subprocess argv hoặc exported artifact | Unit + integration với captures |
| SEC-SECRET-02 | Secure store unavailable trả lỗi và không ghi plaintext; chỉ broker nhận secret; revoke/expiry không dùng được sau retry/restart; log redaction chạy cả exception paths | Keychain/vault integration trên OS thật |
| SEC-TENANT-01 | A không list/get/mutate B qua API/run/task/policy/approval/events/snapshot/artifact/export; token hợp lệ nhưng sai org vẫn 403/404 an toàn | PostgreSQL + API integration, ≥2 tenants |
| SEC-TENANT-02 | DB non-owner không BYPASSRLS; direct SQL A không đọc/ghi B; pooled connection và background activity không rò SET LOCAL; missing tenant fail closed; cross-tenant FK insert reject | PostgreSQL thật, migration integration |
| SEC-POLICY-01 | `deny` và pending `ask` tạo audit nhưng zero side effect. Approval một lần bind actor/tenant/project/session/run/tool/resource/args digest/policy version/expiry; đổi bất kỳ protected field phải deny hoặc hỏi lại | Unit + real executor integration |
| SEC-POLICY-02 | Concurrent consume không dùng approval hai lần; revoked organization policy thắng cached session allow; mới tool/schema/scope không kế thừa approval cũ | Concurrency integration |
| SEC-IDEM-01 | Repeated side-effect API cùng tenant/key/body trả cùng logical result; key reused với body khác trả conflict; key không thể truy cập kết quả tenant khác; restart vẫn dedup | DB/API integration |
| SEC-IDEM-02 | Kill executor sau external effect trước ACK; retry/recovery reconcile bằng operation key rồi không tạo file/commit/PR/tool effect trùng; unknown outcome → reconciliation_required | Crash/chaos staging |
| SEC-RUN-01 | Sau accepted response, kill API/dispatcher/Temporal worker ở mỗi commit boundary; run vẫn truy xuất được và được dispatch đúng workflow ID sau restart | PostgreSQL + Temporal thật, chaos |
| SEC-RUN-02 | Cancel org/project/run/task/step/tool truyền cooperative signal; quá grace hard terminate đúng worker, cleanup lease/artifact/temp/cost reservation; p95 worker nhận signal ≤5 s trong profile đo | Worker integration + load |
| SEC-RUN-03 | Heartbeat mất làm lease bị fence/reclaim; worker cũ không tiếp tục side effect; retry-from-step và clone-run giữ provenance và operation semantics riêng | Real runtime chaos |
| SEC-STREAM-01 | Drop mạng, duplicates, reorder, reconnect nhiều lần: sequence/event ID ổn định, client dedup đúng, replay mọi event chưa nhận; bounded backlog → snapshot/polling; slow consumer không unbounded memory | DB/WebSocket + browser/Electron E2E |
| SEC-STREAM-02 | Reconnect re-auth, expired/revoked session bị deny; cursor/ack sai stream/tenant không tiết lộ dữ liệu hoặc skip consumer khác; ACK không vượt authorized stream high-watermark | Auth + stream integration |
| SEC-AUDIT-01 | Privileged operation có durable intent trước side effect và outcome sau; ledger outage fail closed cho operation mới; concurrency giữ chain hợp lệ; canonical verify phát hiện sửa/xóa/reorder ở giữa | DB + executor integration |
| SEC-AUDIT-02 | External anchor/WORM verification phát hiện rewrite chain và tail truncation; JSONL export redacted; retention segment manifests verify sau rotation/restore | Storage/KMS integration staging |
| SEC-NET-01 | URL credentials, private IPv4/IPv6, mapped IP, loopback/link-local/metadata, redirect sang private, DNS rebinding bị block; validated IP được pin cho connection với TLS hostname đúng | Controlled DNS/HTTP integration |
| SEC-NET-02 | Direct worker egress/DNS bypass bị OS/network policy chặn; domain/tool/org rules compose deny-wins; byte/MIME/rate/redirect limits có hard enforcement | Container development + production cluster |
| SEC-BROWSER-01 | Preview attacker không có Node/keychain/IPC host; session/cookies cách ly, popups/downloads qua policy; oversized/malicious download quarantine, không auto-open executable | Browser isolation E2E |
| SEC-MCP-01 | Stdio và Streamable HTTP với server thật: manifest diff/new tool denied; timeout/cancel/output limit; untrusted output không tự kích hoạt tool; per-argument approval chặn | MCP compatibility integration |
| SEC-MCP-02 | OAuth resource/audience mismatch và token passthrough sang server khác bị chặn; scope tăng yêu cầu step-up; token expiry/rotation/revocation không fake success | Remote MCP OAuth staging |
| SEC-OAUTH-01 | System browser Code+PKCE S256; state single-use/expiry, exact redirect, issuer/resource binding, OIDC nonce khi áp dụng; code/state/callback replay reject; callback cleanup | OAuth staging + desktop E2E |
| SEC-GITHUB-01 | HMAC invalid/missing/raw-body altered → reject; repeated delivery ID xử lý một lần; repo ngoài installation reject; installation token short-lived và không lộ | Webhook integration + staging GitHub App |
| SEC-GITHUB-02 | Branch→commit→draft PR thật có run provenance; branch protection awareness; merge/force-push deny khi chưa có specific approval; retry không duplicate | Staging repo/GitHub App E2E |
| SEC-AGENT-01 | Prompt injection trong README/source/issue/web/MCP yêu cầu lấy secret, thay policy, tạo remote call: broker chặn ngoài scope, event giải thích policy; model không tự duyệt approval | Adversarial integration, real provider ở staging |
| SEC-QUOTA-01 | Concurrent reservations theo org/workspace/project/user/provider/model/agent/run không oversubscribe; cảnh báo 50/80/95% dedup; hard cap/cancel; reconcile usage/refund khi fail | DB concurrency + worker/provider staging |
| SEC-QUOTA-02 | CPU/RAM/disk/process count/network/time/concurrency/browser/MCP/tool/token limits được đo ở runtime; retry/failover không reset counter | Real runtime/load tests |
| SEC-FAILOVER-01 | Retry-After/error mapping/circuit breaker/cancel thật; fallback chỉ candidate phù hợp capability/context/region/retention/budget/consent; audit ghi model thực tế từng attempt | Provider contracts + staging failover |
| SEC-REGISTRY-01 | `registry.refresh` dùng endpoint/provider thật được allowlist; redirect không làm lộ Authorization; bounded response/time; error redacted; missing credential → unconfigured, thiếu price/capability → unknown có source/observedAt; discovery không quảng cáo inference available | Provider discovery contract + real-provider staging |
| SEC-WORKER-01 | Unprivileged worker không host mount/Docker socket/cloud admin env; không đọc volume run khác; seccomp/cgroup/network policy có hiệu lực; ephemeral cleanup | Production runtime isolation integration |
| SEC-WORKER-02 | MicroVM/Kata unavailable làm admission unavailable; không silently fallback local/Docker; scoped credential hết hạn/revoked bị reject; stale fence không execute | Production cluster chaos |
| SEC-STORAGE-01 | Artifact object IDs/path/content-disposition/URLs không vượt tenant hoặc injection; signed URL expiry đúng; encryption/retention policies và scanner hook fail behavior được test | S3-compatible storage integration |
| SEC-SUPPLY-01 | Immutable lockfile install, registry pinning, dependency/secret scans, SBOM; unexpected lockfile/artifact change fail CI; không embed credential trong package | CI/build evidence |
| SEC-RELEASE-01 | Windows signed installer và macOS signed/notarized installer verified; altered/unsigned/wrong-platform/downgrade updates reject; key material không nằm trong build artifacts | Packaged cross-platform E2E/signing staging |
| SEC-RESTORE-01 | Restore DB/object/audit metadata từ backup vào isolated env; verify ledger anchors và tenant boundaries; revoked sessions không hoạt động trở lại; ghi RPO/RTO thật | Backup/restore rehearsal |

## Hình thức báo cáo test

Mỗi batch lưu báo cáo có các trường: `commit`, `startedAt`, `environment`, `command`, `exitCode`, `passed`, `failed`, `skipped[]` với reason, artifact path và acceptance IDs. Không đếm source review là executed test. Real-provider report ghi provider/model thực tế, credential source dạng reference, usage/cost/source timestamp; không ghi credential value. Bằng chứng performance ghi sample size, p50/p95, concurrency, CPU/RAM/OS/region và phiên bản dependency.

## Release blockers phải giữ hiển thị

- Chưa có test ứng với security boundary đã expose, hoặc regression test đang fail.
- Chưa có production identity/session revocation, tenant isolation, worker isolation hoặc policy enforcement tại executor.
- Accepted-run recovery, duplicate side-effect prevention, replay/cancellation/quota mới được mô phỏng hoặc chưa đo với dependencies thật.
- Có secret leak, unknown external action outcome bị báo success, unsafe provider fallback hoặc pricing unknown bị coi là zero.
- Chưa có provider cloud thật tối thiểu ba nhà cung cấp và một local; MCP OAuth/GitHub App flow chưa chạy thật.
- Chưa có signing/notarization/update verification, immutable build/SBOM, retention/backup/restore, audit external anchor hoặc security owner/on-call.
- Chưa có benchmark định lượng, accessibility/performance/cross-platform evidence và production readiness review.

External dependencies chưa cấu hình là blocker cho gate liên quan, không phải lý do chuyển production sang mock. Slice local đã được test có thể bàn giao với trạng thái và giới hạn rõ ràng trong khi gate cloud vẫn mở.
