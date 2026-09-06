# Dependencies và vận hành

## Local

Node.js 24 LTS và Git đã được phát hiện trên máy thực hiện. Chưa phát hiện Docker, PostgreSQL hoặc Temporal CLI khi khảo sát đầu tiên. Chỉ chạy lệnh trong repo, không thay đổi global security settings. PostgreSQL integration qua isolated test database hoặc PGlite (PostgreSQL WASM) phải được gắn tên chính xác; PGlite test không được dùng làm backend production hoặc chứng minh network/pool/HA.

## Credentials và cloud requirements

- OIDC issuer/client + registered loopback redirect; GitHub login/app registration là các credential riêng.
- Credential của các provider cloud chỉ được cấp qua environment hoặc Vault ở trusted broker/worker. Ollama local cần endpoint allowlisted. Không nhập credential vào chat hoặc localStorage.
- PostgreSQL runtime/migrator identities, Temporal namespace/mTLS, S3 narrow IAM, KMS/Vault, OTLP collector.
- GitHub App private key/installation ID + signed webhook secret; không personal token scope rộng.
- Windows code-signing identity; macOS Developer ID/notarization; signed update channel storage.
- K8s node pools có Kata/Firecracker support, egress gateway, DNS enforcement, observability, backup target.

## Operating cost model

Chưa có invoice, provider usage hoặc cloud deployment, nên chi phí thực tế chưa biết. Local development không tạo phí API khi chưa cấu hình provider; CPU/disk/electricity thuộc máy người dùng. Cloud estimate phải tính `API+DB HA+Temporal+worker CPU-hours+S3+egress+observability+signing+tokens`. Không đặt giá vendor chưa kiểm tra vào UI. Dự toán số tiền chỉ chốt sau region, concurrency, retention và sourced pricing; mọi model price hiện thiếu nguồn là unknown.

## Release gates

No deployment until identity/TLS/runtime role verified. Backups: logical + PITR, encrypted offsite, scheduled isolated restore and ledger/event count verification; RPO/RTO measured. Worker reclaim phải fencing trước reuse. Signed update verification phải được negative tested. Full SRE runbook, escalation, load/chaos/restore evidence cần hoàn tất ở slices 08–09.
