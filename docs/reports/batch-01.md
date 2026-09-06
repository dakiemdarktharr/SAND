# SAND — Báo cáo batch 01

Ngày: 07/09/2026 (Asia/Saigon). Phiên bản: 0.1.0 development preview. **Đã có một vertical slice chạy thật; toàn dự án chưa đạt Definition of Done, chưa production-ready và chưa có kết quả so sánh Cursor.**

## Bàn giao

- Installer Windows x64 NSIS: [SAND Preview Setup 0.1.0.exe](../../release/SAND%20Preview%20Setup%200.1.0.exe), 112.097.156 byte. SHA-256: 58B3DB13609DF3A3B31A54BC4941E3CB7CAF57C3CB97AB13B47DB90BC15C4A7F. Authenticode: NotSigned. Chưa kiểm tra install/uninstall hoặc cập nhật trên máy sạch.
- [README và lệnh khởi chạy](../../README.md). Có thể chạy desktop local với Node.js 24 và Git; không cấu hình API thì UI hiển thị unavailable.
- [PRD](../product/prd.md), [kiến trúc](../architecture/overview.md), [ADRs](../architecture/adrs.md), [threat model](../security/threat-model.md), [phân loại dữ liệu](../security/data-classification.md), [contracts](../architecture/contracts.md), [backlog](../product/backlog.md), [acceptance plan](../product/acceptance-tests.md).
- [Review implementation độc lập](../security/implementation-review.md), [benchmark protocol](../product/benchmark.md) và [26 benchmark cases](../../benchmarks/matrix.json). Các benchmark đối chiếu Cursor chưa chạy.

## Phạm vi thực sự hoạt động

| Module | Đã triển khai và kiểm chứng | Giới hạn |
|---|---|---|
| Desktop | Electron main/preload/renderer tách biệt; sandbox; CSP; IPC allowlist, kiểm tra sender; theme; palette; panel resize | Windows đã chạy; macOS chưa chạy. Chưa dock layout đầy đủ, updater hoặc code signing |
| Repository/editor | Native repository selection; explorer; Monaco/tabs; đọc/lưu file thật; kiểm tra phiên bản; backup và receipt chống save trùng; giữ edit khi conflict | Chưa create/move/delete, LSP, global search, merge editor, PTY/test explorer |
| Git | Git status và unstaged diff thực, argv không shell, chặn hooks/external diff khi đọc | Chưa commit/branch/worktree/push/PR hoặc GitHub App |
| Control plane | Fastify typed API/OpenAPI; PostgreSQL; 2 migrations; tenant RLS; idempotency; run/event/outbox/audit giao dịch cùng nhau | Development identity cố định; production startup bị từ chối vì thiếu OIDC và production gates |
| Durable execution | Temporal registry workflow, stable workflow ID, outbox retry/lease, idempotent activities, run cancel, terminal-state reconciliation | Chưa agent DAG/task/step/attempt đầy đủ, hierarchical cancellation, OS-isolated worker hoặc operator recovery UI |
| Replay | Persisted sequence/event ID; WS replay/ACK/auth/backpressure; REST fallback; client reducer chống duplicate/reorder/gap | Desktop đang polling REST; chưa nối WS client. Không cam kết exactly-once delivery |
| Registry | Discovery adapter OpenAI, Anthropic, Gemini, OpenRouter, Ollama; unknown metadata giữ null; nguồn và thời điểm; OpenRouter cung cấp catalog pricing | Chỉ public OpenRouter được gọi thật ở batch này; chưa authenticated inference/tool streaming, routing, health scoring hoặc failover |
| Policy | Pure evaluator allow/deny/ask, argument-aware, scope/expiry/binding, explicit deny precedence; enforcement tại registry admission | Chưa issuer/storage/atomic consume cho approvals; chưa thống nhất mọi filesystem/Git/MCP action |
| Network | Broker giới hạn origin provider, DNS/public-IP validation, pinned address, deny redirect, MIME/size/timeout | Chưa OS egress gateway, proxy/category rules, malware scanning hoặc browser automation |
| Audit/telemetry | Append-only DB triggers; hash-chain/head verification; JSONL pagination; local audit; structured metadata và OpenTelemetry foundation | Chưa external anchor/WORM, SIEM/OTLP delivery verification, operational dashboards hoặc load-tested streaming verifier |

Các module chính: apps/desktop/src, services/control-plane/src, services/control-plane/migrations, services/workflows/src, packages/policy/src, packages/providers/src, packages/telemetry/src, tests/integration, tests/e2e, infra và scripts. Manifest nguồn đi kèm ghi SHA-256 của từng file; repository chưa có commit nguồn để viện dẫn.

## Kiểm thử đã chạy

| Lệnh / kiểm tra | Kết quả thực tế | Bằng chứng / giới hạn |
|---|---|---|
| npm run lint | PASS | Chạy lại sau sửa packaging scripts |
| npm run typecheck | PASS | TypeScript strict, trước thay đổi cuối chỉ thuộc packaging/docs |
| npm test -- --reporter=json --outputFile=artifacts/local/unit-integration-results.json | 130 PASS, 0 FAIL, 11 SKIP | [JSON](../../artifacts/local/unit-integration-results.json); gồm policy 52, provider fixtures 34, desktop 27, backend 17 |
| npm run test:durability -- --live-registry | 5 PASS | PostgreSQL 17 native + Temporal server thật; kết quả lệnh đã quan sát trong phiên làm việc |
| Real provider contract, bật public OpenRouter | 1 PASS, 4 SKIP | OpenRouter live discovery; 4 provider khác thiếu credential/service nên skipped, không fake success |
| SAND_FULLSTACK_E2E=1 với npm run test:e2e | 4 PASS, 0 FAIL, 0 SKIP | [Playwright JSON](../../artifacts/local/e2e-results.json); 14,52 giây cho suite |
| npm run package:win | PASS | Tạo NSIS x64 development preview, chưa ký |
| npm run test:package | PASS | [Smoke JSON](../../artifacts/local/package-smoke.json); chạy executable đóng gói, xác minh sandbox/contextIsolation và không Node |
| Get-AuthenticodeSignature | NotSigned | [Artifact metadata](../../artifacts/local/package-authenticode.json); trạng thái này không đáp ứng production release gate |
| npm audit | 0 vulnerabilities được báo tại thời điểm chạy | [JSON](../../artifacts/security/npm-audit.json); không thay thế security review |
| Gitleaks 8.30.1 | 0 findings ở source scan cuối | [JSON](../../artifacts/security/gitleaks.json); binary tải từ release chính thức, checksum đã đối chiếu; generated/dependency directories loại khỏi source scan |
| CycloneDX SBOM | Đã xuất, 103 components | [SBOM](../../artifacts/security/sbom.cdx.json); dependency inventory production của workspace, không phải chứng nhận toàn bộ supply chain |

11 default skips gồm 5 live-provider contract, 5 Temporal gates và 1 external staging database gate. Các gated suites được chạy riêng như bảng trên; không cộng số này thành tổng test độc lập. PGlite chỉ dùng trong test, không phải backend fallback. Native PostgreSQL tests riêng có RLS, concurrent admissions và API restart.

### End-to-end đã thấy chạy

1. Desktop mở repository test → sửa Monaco → lưu thật → đọc lại nội dung → Git diff; file thay đổi bên ngoài gây conflict và edit chưa lưu được giữ lại.
2. Desktop → API có bearer development → PostgreSQL run/event/audit/outbox → Temporal → public OpenRouter API → snapshot persist → model registry hiển thị trên desktop. Lần chạy ghi nhận **430 model**, audit valid; đây là dữ liệu catalog quan sát lúc chạy, không phải danh sách cố định. [Evidence](../../artifacts/local/fullstack-evidence.json), [ảnh UI](../../artifacts/local/fullstack-registry.png).
3. Run được nhận trước khi worker khởi động; missing provider kết thúc failed với lý do rõ ràng. Mất acknowledgement sau Temporal start được mô phỏng bằng release lease, re-dispatch vẫn chỉ có một workflow start. Native PostgreSQL chịu concurrent same-key admission mà chỉ tạo một run/event/outbox.
4. Temporal workflow bị terminate thật → reconciler ghi terminal failure. Queued run cancellation được kiểm chứng. Đây chưa phải SIGKILL worker/process crash hoặc restart storage của Temporal.
5. Packaged application mở và render thành công. Một mẫu launch-to-visible là 689 ms; ba mẫu E2E unpackaged trước đó là 819/681/669 ms. Đây không phải p95 hay benchmark production.

## Chưa kiểm chứng và rủi ro còn lại

- Chưa triển khai backend cloud, OIDC/session revocation, OS keychain/KMS/Vault; trusted registry worker đang nhận credential qua environment. Không giao credential đó cho future untrusted code workers.
- Chưa có inference ≥3 cloud +1 local, real tool calling/streaming, token billing, reservations/quota, failover, durable multi-agent code changes, MCP stdio/remote OAuth hoặc GitHub App E2E.
- Chưa có Kubernetes/Kata/Firecracker isolation, hard termination, network namespace, artifact S3, backup/PITR restore, dead-letter operator recovery, load/chaos/cross-platform/macOS/accessibility audit đầy đủ.
- File/path/secret controls hiện có test đối kháng nhưng vẫn có giới hạn race của filesystem và heuristic secret detection; chưa bảo đảm chặn mọi secret hoặc mọi same-user attack. DB runtime role phải không có owner/admin membership kế thừa; guard hiện tại chưa kiểm chứng toàn bộ membership graph.
- Hash chain chưa có external trust anchor; host/DB administrator vẫn ngoài bảo đảm hiện tại. OTLP export là network path hạ tầng riêng, chưa kiểm tra collector delivery.
- Chưa đo 99,9% availability, API p95 dưới 300 ms hoặc cancellation p95 dưới 5 giây. Chưa chứng minh không mất run trong mọi crash/power-loss scenario. Không tuyên bố exactly-once delivery hoặc thắng Cursor.
- Bundle renderer có cảnh báo Vite chunk lớn khoảng 2,9 MB chưa gzip; installer dùng icon Electron mặc định. Performance budgets, onboarding và product polish tiếp tục ở các slice sau.

## Chi phí và dependency

Chưa triển khai cloud hoặc gọi model inference, nên **chưa có số liệu billing thực tế**. Batch này chỉ gọi public model catalog; không dùng giá catalog làm chi phí đã tiêu thụ. Desktop/backend test dùng tài nguyên máy local. Dự toán cloud cần region, concurrency, runtime giờ/tháng, retention, token workload và nguồn giá có timestamp; hiện chưa đủ dữ liệu để đưa con số tiền đáng tin cậy.

Công thức dự toán: API + PostgreSQL HA/backup + Temporal + worker CPU/RAM-hours + S3 + egress + observability + signing + model input/output/cache/tool usage. [Dependency và cost assumptions](../operations/dependencies.md) liệt kê OIDC registration, provider credentials, GitHub App, Temporal namespace/mTLS, storage/KMS và signing identities. Không cung cấp secrets trong chat hoặc renderer.

## Bước bàn giao nhỏ nhất tiếp theo

Slice 02: system-browser OIDC với PKCE/state/nonce, OS keychain cho session, organization/project membership và revocation, nối vào API cùng registry run hiện có. Acceptance gồm interception/replay/expiry/wrong-audience tests và two-tenant E2E. Sau đó mở rộng Git/editor và inference theo backlog; không đánh dấu phần còn lại đã hoàn thành chỉ vì đã có thiết kế hoặc panel unavailable.
