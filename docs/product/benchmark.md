# Reproducible benchmark protocol

Status: NOT RUN. Không có bằng chứng để tuyên bố SAND vượt Cursor.

## Test setup

Pin repository commits, task prompts, test command, OS/hardware, region, network profile, date, product versions, model ID/version và published pricing snapshots. Run cùng task set cho SAND và Cursor, luân phiên thứ tự, ít nhất 20 attempts/task để báo phân phối; tách cold/warm cache, human intervention và unavailable. Report median/p95 và bootstrap confidence intervals, n, raw run IDs. Không gán 0 lỗi cho gate không hỗ trợ.

Parity cases: repository open/edit; text/symbol search; PTY; Git diff/commit; multi-file edit; tests; controlled browser; MCP stdio/HTTP; GitHub branch/draft PR; background tasks; parallel agents; approval enforcement.

Differentiation cases: durable admission; kill API/dispatcher/worker then resume; network disconnect/replay; scoped cancellation; isolation escape attempts; hierarchical budget contention; argument-change approval; policy version change; sourced cost routing; fresh registry; provider timeout/failover; ledger tamper; prompt→PR provenance; dead-letter/recovery.

## Measurements

| Metric | Definition |
|---|---|
| Task completion rate | tests passed and requested behavior verified / all attempts |
| First useful result | accepted timestamp → first relevant validated output |
| Time to tested change | accepted → completed required test execution |
| Human intervention | interventions per task and fraction needing intervention |
| Retry / recovery | retry attempts; fault injection → resumed useful work |
| Cancel latency | accepted cancel → last worker side effect/termination |
| Cost per success | all billed attempts including failures / successful tasks; unknown separate |
| Provider p95 | measured request completion latency, provider/model/region stratified |
| Provenance coverage | privileged actions with complete required fields / observed actions |
| Permission escape | unauthorized effects / adversarial attempts |
| Duplicate side effects | repeated external mutations for one logical effect / logical effects |

Results CSV/JSONL must include evidence artifact paths, source commit, test exit code, fault schedule, prices+timestamps, skipped reason. Cursor measured behavior/terms/version must be checked when executing; this document makes no current feature claims about Cursor.
