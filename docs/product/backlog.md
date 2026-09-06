# Vertical slices và release plan

Mỗi slice gồm schema migration khi đổi dữ liệu, tests theo risk, telemetry, UX lỗi và runbook. Không check hoàn thành từ UI alone.

| Slice | Kết quả chạy được | Acceptance / evidence | Dependencies |
|---|---|---|---|
| 00 Foundation | PRD, architecture, ADR, threat/data model, contract, benchmark plan | review consistency, risk ownership | không credentials |
| 01 Repository + durable registry run | native repo → editor save; API → DB/outbox → Temporal → real model discovery → event replay/audit | path/conflict tests; tenant/idempotency/replay/ledger tests; desktop E2E; real PostgreSQL/Temporal gate | Node, Git, PostgreSQL, Temporal; provider env optional |
| 02 Identity + project onboarding | system-browser OIDC PKCE → membership/project → revocation | wrong state/nonce/redirect/audience, multi-tenant integration | OIDC issuer, client registration, Vault/KMS |
| 03 Full editing + Git | LSP/PTTY/search/test explorer, safe checkpoints, conflict editor | malicious repo, symlinks, command args, cross-platform E2E | language servers; isolated dev runtime |
| 04 GitHub change delivery | GitHub App install → branch/worktree → signed webhook → draft PR | duplicate webhook/PR retries, permissions, branch protection | GitHub App ID/private key/webhook secret |
| 05 Provider + registry + budget | all 5 adapters inference/tool streaming; sourced pricing; reservations | staging real-provider contracts + retry/cancel/usage | API keys or Ollama/vLLM service; price sources |
| 06 Tool consent + MCP | policy broker → argument-bound approval → stdio/HTTP OAuth tool | manifest changes, PKCE, audience, injection, timeout | registered MCP servers, OAuth metadata |
| 07 Durable multi-agent | task DAG → isolated workers → test artifacts → checkpoint | worker kill/resume, bounded retries, leases, cancellation hierarchy | K8s + Kata/Firecracker, S3, egress |
| 08 Recovery + routing | quota/failover/dead-letter/operator recovery | concurrent/chaos/load/backup restore; no duplicated effects | controlled staging fault injection |
| 09 Release | signed installer/update, accessibility/performance, measured benchmarks | complete project DoD and readiness review | signing identities, notarization, monitored cloud |

## Definition of Done cho từng batch

Code nối tới thật hoặc explicit unavailable; pin dependencies; lint/typecheck/unit + integration/E2E tương ứng; skipped tests có lý do; migrations forward/restore reviewed; security/telemetry/docs cập nhật; report ghi verified/unverified, residual risks, operating assumptions và next smallest deliverable.

## Definition of Done toàn dự án

Chỉ release khi toàn bộ 22 nhóm yêu cầu được evidence map: installable signed Windows/macOS desktop + signed update; production backend/identity; >=3 cloud +1 local providers; discovery/capability/sourced prices; GitHub App/MCP stdio+OAuth E2E; policy enforcement; isolated agents; crash/replay/cancel/quota/failover; verifiable audit + tenant tests; monitoring/backups/runbooks; quantitative Cursor benchmark; không fake provider hoặc UI-only core feature.
