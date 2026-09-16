# Alternative-inspired acceptance matrix

This is a SAND backlog/evidence matrix, not a claim that the alternatives have been benchmarked or that their UI/code was copied. Official sources and dated research: [research notes](../research/agentic-platforms-2026-09-16.md).

| Product inspiration | Useful capability | SAND evidence now | Open Stage 1 acceptance |
|---|---|---|---|
| n8n | Visible workflow, human approval, integrations | Editable DAG, dependency wiring, review node, argument approvals, MCP | Conditions, loops, reusable subflows, mappings, triggers/webhooks/schedules, credentialed connector breadth |
| Cursor | Repository context, editing, agent tools, IDE flow | Monaco edit/save, Git status/diff, governed agent read/save and recovery receipts | Terminal/PTTY, LSP/symbols, merge/test explorer, full Git/PR flow, broader coding evaluation |
| Antigravity | Multiple agents, artifacts, reviewable execution | Multi-model DAG, actual local inference, reports, run timeline, approvals | Isolated browser/computer automation, cloud/background agents, independent task supervision |
| Amoeba | Accessible agent/workflow composition | Role/model configuration, workflow template, file import, report export | Domain templates validated with experts, reusable forms/data mapping, deliverable apps |
| SAND differentiation | Recoverability and verifiable provenance | SQLite checkpoints, tool intents/receipts, persisted approval, hash-chain verification; separate PostgreSQL replay/RLS foundation | Cloud agent Temporal workflow, hardened worker isolation, budgets/failover, external audit anchoring, operator recovery |

A parity benchmark must use the same repository/input, permitted tools, model/version where configurable, time/cost budget and scoring rubric. Preserve raw events and changes. Measure task completion, first useful result, tested change time, intervention, retry, recovery, cancellation, cost, provider latency and permission/duplicate-effect rates. Current demos measure one run each, do not establish p95, and do not evaluate competitors. Model narration is not a valid side-effect success oracle; use actual file hashes/server receipts/tests.
