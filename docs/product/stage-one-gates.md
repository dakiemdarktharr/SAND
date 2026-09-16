# Expanded Stage 1 acceptance gates

The owner explicitly includes autonomous tools, MCP, research, cloud inference, OS credential protection/OIDC and deployment hardening in Stage 1. Stage 2 is user feedback, polish and product iteration, not a place to hide these requirements.

| Gate | Evidence required |
|---|---|
| Low-code multi-model workflow | Real local providers, editable DAG, parallel steps, review and artifact |
| Governed autonomous tools | Model requests tool, persisted argument-bound approval, actual execution and replay |
| MCP | Actual stdio and Streamable HTTP servers; OAuth tested separately |
| Research | Actual brokered public HTTP retrieval, source/time recorded; SSRF denial tests |
| Cloud inference | Real credentialed staging calls for supported adapters; absent keys mean skipped/unavailable |
| Credentials and identity | OS vault roundtrip, no renderer secrets; real external OIDC login and revocation |
| Durable execution | Recovery, cancellation, quotas, no blind external side-effect retry |
| Full IDE and integrations | Terminal, Git write/PR, LSP, browser automation demonstrated independently |
| Production operations | Isolated worker, tenant auth, TLS, backup/restore, signed updates, monitoring |
| Competitive claims | Repeatable task benchmark, named alternative versions and measured results |

No aggregate completion claim until every required gate has evidence. Local tests do not establish cloud operation, cross-platform support or production security. No provider accounts, paid compute, code-signing certificates or hosted services are created implicitly.
