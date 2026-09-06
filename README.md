# SAND

AI-native engineering workbench, đang xây theo vertical slices. **Đây là development preview 0.1; chưa production-ready và chưa có bằng chứng vượt Cursor.**

Batch 01 có Electron + React + Monaco, repository broker thực, Git status/diff, PostgreSQL run/event/audit/outbox, Temporal registry workflow, model discovery 5 provider, policy evaluator và replay WebSocket. Agent sửa code, inference adapters đầy đủ, MCP/OAuth, GitHub App, microVM, quota nhiều cấp, signed release vẫn là backlog. Xem [báo cáo batch 01 và bằng chứng thực tế](docs/reports/batch-01.md) hoặc [backlog](docs/product/backlog.md).

## Chạy desktop trên Windows

Yêu cầu Node.js 24 và Git.

```powershell
npm ci
npm run setup:desktop
npm run dev
```

Chọn **Open repository** bằng native dialog. SAND không chạy install scripts khi mở repository. File save kiểm tra phiên bản và giữ bản khôi phục. API chưa cấu hình → unavailable, không có fake run/model.

## Control plane và worker

Đọc [hướng dẫn backend](docs/control-plane.md) để tạo PostgreSQL migrator/runtime role riêng, bootstrap organization/project local, và khởi chạy API trên 127.0.0.1:4310. [Compose development](infra/compose.dev.yaml) là lựa chọn khi đã có Docker. Không có in-memory fallback trong API production path.

[Worker hướng dẫn](docs/workflows.md): Temporal dev server + npm run worker. Cấu hình cùng SAND_TENANT_ID / SAND_ACTOR_ID giữa API và worker; queue được tách theo identity local. SAND_API_TOKEN chỉ ở môi trường main/API, không renderer. Khởi động production bị từ chối cho tới khi OIDC/TLS và runtime gates hoàn tất.

[Provider hướng dẫn](docs/providers.md): credential chỉ ở process worker/Vault. Có thể dùng public catalog OpenRouter với SAND_OPENROUTER_PUBLIC_DISCOVERY=1; đây là discovery, không xác nhận inference. UI không coi giá unknown là $0.

## Kiểm chứng

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:durability -- --live-registry

# Full-stack desktop test dùng public OpenRouter catalog thật
$env:SAND_FULLSTACK_E2E = "1"
npm run test:e2e
Remove-Item Env:SAND_FULLSTACK_E2E
```

Default tests dùng unit fixtures và PGlite (PostgreSQL WASM) để test SQL; live-provider/staging tests thiếu cấu hình được **skipped có lý do**. test:durability chạy native PostgreSQL 17 trong thư mục .runtime và Temporal dev server thật, không yêu cầu Docker. --live-registry thêm public OpenRouter thật. Không dùng native test database hoặc fixture như một production fallback.

Không cần gửi secret vào chat. Credentials đã có trong environment chỉ dùng cho endpoint tương ứng khi bật live test. Xem [acceptance plan](docs/product/acceptance-tests.md), [security matrix](docs/security/acceptance.md) và batch report trong docs/reports.

## Build installer preview

```powershell
npm run package:win
npm run test:package
```

Artifact trong release là **unsigned development preview** trừ khi signing được cấu hình và xác minh. Không phát hành production hoặc tự update từ artifact chưa ký. macOS build/E2E/notarization cần máy macOS và signing identity.

## Tài liệu thiết kế

[PRD](docs/product/prd.md) · [Kiến trúc](docs/architecture/overview.md) · [ADRs](docs/architecture/adrs.md) · [Threat model](docs/security/threat-model.md) · [Data classification](docs/security/data-classification.md) · [Contracts](docs/architecture/contracts.md) · [Benchmark protocol](docs/product/benchmark.md) · [Dependencies/cost assumptions](docs/operations/dependencies.md)
