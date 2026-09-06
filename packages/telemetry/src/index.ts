import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

/** Metadata-only instrumentation. No request bodies, headers, prompts, tool arguments or exception text. */
export function startTelemetry(serviceName: string): NodeSDK | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('UNSAFE_TELEMETRY_ENDPOINT');
  const sdk = new NodeSDK({ serviceName, traceExporter: new OTLPTraceExporter({ url: endpoint }), instrumentations: [] });
  sdk.start();
  return sdk;
}
