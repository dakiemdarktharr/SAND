# Governed tools — runnable preview

Use Node 24.x and npm 11. From a clean checkout:

~~~sh
npm ci
npm run setup:desktop
npm run dev
~~~

Run Ollama separately; install a model you have chosen. SAND does not download models or call a paid fallback. This machine has qwen2.5-coder:7b and llama3:latest. Those names are test observations, not the model registry's source of truth.

## Desktop walkthrough

1. Find models in Studio; choose roles and models, or keep the two-specialist template.
2. Select **Chọn repository cho agent** to grant a repository through the native folder picker.
3. On an agent node enable only the tools it needs. For the observed Qwen installation choose **Ollama JSON có schema kiểm tra**: the model advertises tools but its native parser returned JSON as text. JSON mode is explicitly selected and constrained/validated; ordinary model prose is never executed.
4. For a read demo enable **repo_read**, instruct it to read a non-sensitive file and summarize. Start the workflow.
5. Inspect exact arguments, argument hash and manifest binding in the tool inbox. Until you approve, no call runs. Denial cancels downstream execution.
6. Close the desktop while waiting, reopen it and explicitly select the same repository. Open the run from history and approve. A changed root identity or MCP manifest invalidates the binding.
7. Review the model's output, inspect authoritative tool receipts, verify the timeline and export the report. Model narration can be wrong even when a tool succeeded.

Screenshots and counts: [verification report](reports/governed-preview.md).

## Terminal demos

~~~sh
npm run demo:tools     # actual Ollama -> approved repo read -> restore -> audit -> report
npm run demo:edit      # actual Ollama -> approved recoverable write in a new generated directory
npm run demo:research  # actual HTTPS example.com retrieval through DNS-pinned broker
npm run demo:mcp       # actual stdio MCP utility subprocess, requested by actual Ollama
npm run demo:studio    # 2 actual local models, 3 calls, review, restore, report
npm run demo           # independent PGlite/HTTP/WS persistence demo; no inference
~~~

Each tool demo creates a NEW .runtime/governed-demo-* directory with summary.json, audit.jsonl and report.md. It approves only its exact predefined non-sensitive call, explicitly as part of the demo. It does not auto-approve tools in the desktop. It fails if the model never requests the tool or changes the expected arguments. Reopen in these CLI demos means reopening the databases; the Electron E2E separately tests closing/relaunching the whole process. Model summaries are not a quality benchmark.

Optional PowerShell selection:

~~~powershell
$env:SAND_TOOL_MODEL = 'your-installed-model'
~~~

No credential is required for local inference.

## MCP configuration

Choose a JSON file through **Kết nối & bảo mật → Kết nối MCP từ file**. Inspect and accept the native server consent dialog. An example for the included real text-statistics server (substitute absolute paths):

~~~json
{"id":"utility","transport":"stdio","command":"C:/path/to/node.exe","args":["--import","file:///C:/path/to/SAND/node_modules/tsx/dist/loader.mjs","C:/path/to/SAND/services/mcp-utility/main.ts"]}
~~~

Or an actual public server:

~~~json
{"id":"research","transport":"http","url":"https://your-mcp-server.example/mcp"}
~~~

The example hostname is a configuration placeholder, never a production fallback. Stdio servers have OS-user authority and are NOT sandboxed. Child environment is reduced; provider credentials are not forwarded. Remote endpoints require public HTTPS, no redirect, <=2 MB response, 45 s network deadline, 30 s tool timeout. Both JSON and SSE responses are protocol-tested against an actual local test server; the private-address transport exception is test-only. Remote OAuth is **not implemented**: authenticated remote servers fail visibly rather than borrowing another service's token. Manifest is checked again before each tool call; changed tools/schema require reconnection and a new run.

## Cloud credentials and OIDC

Text inference adapters: OpenAI, OpenRouter, Anthropic, Gemini, Ollama. Native tool loop: Ollama/OpenAI/OpenRouter. JSON tool protocol: Ollama only. Streaming, multimodal and Anthropic/Gemini tool loops are not claimed.

Set the relevant OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY in the trusted desktop launch environment. Never paste a key into the UI, source or workflow. **Lưu từ môi trường** imports it directly in main into credentials.enc using Electron's OS-backed encryption. Renderer receives configured booleans only. Stored credentials override launch environment until removed; removing the stored copy does not remove an environment variable. Windows uses DPAPI: other apps running as the same OS user are outside its protection. Linux basic_text is refused. macOS Keychain behavior requires separate signed-build testing.

OIDC public-client configuration:

~~~powershell
$env:SAND_OIDC_ISSUER = 'https://your-issuer.example'
$env:SAND_OIDC_CLIENT_ID = 'your-public-client-id'
$env:SAND_OIDC_PORT = '43827'
npm start
~~~

Register EXACT redirect URI http://127.0.0.1:43827/callback at your issuer. Use Authorization Code + PKCE S256 and no client secret. This preview requires issuer discovery, authorization, token, JWKS and revocation endpoints on the same HTTPS origin. Login opens the system browser, verifies state/nonce/signature/issuer/audience/expiry and stores tokens only in the vault. Session expiry requires login again; refresh rotation is not implemented. Logout removes local state and reports whether server revocation succeeded. External issuer E2E is unverified. This desktop session is **not wired to backend tenant authorization**; production API startup remains disabled.

## Tests and limits

~~~sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

Live desktop tests in PowerShell:

~~~powershell
$env:SAND_STUDIO_LIVE_TESTS = '1'
npm run test:e2e
~~~

Cloud contracts require SAND_LIVE_INFERENCE_TESTS=1, the credential, and SAND_TEST_OPENAI_MODEL / SAND_TEST_OPENROUTER_MODEL / SAND_TEST_ANTHROPIC_MODEL / SAND_TEST_GEMINI_MODEL. Local contract uses SAND_TEST_OLLAMA_MODEL. Missing configuration skips with a reason. These tests can incur provider charges when explicitly enabled.

Limits: 12 nodes, 3 admitted active runs, 1–4 concurrent agent steps/run, 6 model turns/agent, 24 tool calls/run, bounded context/output. These are local bounds, not organization quotas or dollar budgets. No automatic provider retry/failover. In-flight provider requests may still bill after cancellation. Unknown external tool outcome blocks replay and requires manual reconciliation; do not blindly create another run with the same side effect.

Backup: **Backup workflow & approvals** creates coherent SQLite snapshots plus hashes in a fresh child directory while no requests execute. Restore into a NEW userData directory with SAND closed, keeping both files together and checking manifest hashes. Never overwrite the original userData directory. Credentials, repository files and desktop IPC audit are excluded. This is local backup/restore, not a cloud DR guarantee; snapshots/documents remain plaintext. Incomplete backups without manifest.json must not be restored.

Production Windows packaging command requires code signing: npm run package:win:production. Normal npm run package:win creates an unsigned developer preview. Neither command implements signed auto-update. Full release gates remain open.
