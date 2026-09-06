# Provider registry — batch 01

Adapters implement **real model discovery**, not inference. OpenAI, Anthropic, Gemini, OpenRouter and Ollama use their actual model-list endpoints. No model names/prices are seeded. Production client uses a fixed-origin broker with DNS classification + address pinning, TLS certificate hostname validation, rejected redirects, JSON MIME validation, 8 MiB response and 20 s request limits. This is not yet a general web/browser egress gateway.

Configuration belongs only to the trusted worker environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, SAND_OLLAMA_ORIGIN (exact http://127.0.0.1:port). Missing configuration is unconfigured. Optional SAND_OPENROUTER_PUBLIC_DISCOVERY=1 accesses the public catalog without an inference credential; status never claims inference is ready.

Unknown metadata remains null. OpenRouter catalog pricing is kept as decimal per-token strings, with source/observedAt and basis catalog-lowest-listed-price. It is not a final bill or necessarily the exact provider route price. OpenAI/Ollama list APIs do not supply token prices; no invented $0. Pricing ingest/override history, full current capability schemas, regional/retention policy, health measurements, inference/stream/tool adapters, usage reconciliation and routing remain future work.

Tests: registry.test.ts uses transport fixtures only in unit tests. registry.contract.test.ts makes real API requests only when SAND_LIVE_REGISTRY_TESTS=1 and provider config is present. Unconfigured real tests explicitly skip. Public OpenRouter discovery proves network/normalization, not authenticated inference, tool calling, cancellation billing or cloud provider readiness.

Primary endpoint sources checked 2026-09-07:

- [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list)
- [Anthropic models](https://platform.claude.com/docs/en/api/models/list)
- [Gemini models](https://ai.google.dev/api/models)
- [OpenRouter models and pricing schema](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [Ollama list models](https://docs.ollama.com/api/tags)
