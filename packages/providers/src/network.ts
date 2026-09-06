import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { ProviderError, type JsonTransport } from './types';

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && !address.toLowerCase().startsWith('2') && !address.toLowerCase().startsWith('3')) return false;
  return family === 4 ? !blocked4.check(address, 'ipv4') : !blocked6.check(address, 'ipv6');
}
export const cloudHosts = new Set(['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'openrouter.ai']);
export function validateDestination(value: string, localOrigin?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('NETWORK_DESTINATION_DENIED'); }
  if (url.username || url.password || url.hash) throw new ProviderError('NETWORK_DESTINATION_DENIED');
  if (url.protocol === 'https:' && cloudHosts.has(url.hostname) && (!url.port || url.port === '443')) return url;
  if (localOrigin && url.origin === localOrigin && url.protocol === 'http:' && url.hostname === '127.0.0.1') return url;
  throw new ProviderError('NETWORK_DESTINATION_DENIED');
}
export function retryAfter(value: string | string[] | undefined, now = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(300_000, Math.max(0, delay)) : null;
}
/** Fixed-origin registry broker. No general URL-fetch endpoint is exposed to renderer or agent. */
export class RegistryNetworkBroker implements JsonTransport {
  constructor(private readonly localOrigin?: string) {}
  async get(value: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = validateDestination(value, this.localOrigin);
    if (signal?.aborted) throw new ProviderError('CANCELLED');
    const local = url.protocol === 'http:';
    let address = { address: '127.0.0.1', family: 4 };
    if (!local) {
      let results;
      try { results = await lookup(url.hostname, { all: true }); }
      catch { throw new ProviderError('DNS_UNAVAILABLE', true); }
      if (!results.length || results.some(item => !isPublicAddress(item.address))) throw new ProviderError('NETWORK_PRIVATE_ADDRESS_DENIED');
      address = results[0]!;
    }
    if (signal?.aborted) throw new ProviderError('CANCELLED');
    return new Promise((resolve, reject) => {
      const request = (local ? httpRequest : httpsRequest)(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal,
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          const code = status >= 300 && status < 400 ? 'REDIRECT_DENIED'
            : status === 401 || status === 403 ? 'AUTHENTICATION_FAILED'
            : status === 429 ? 'RATE_LIMITED'
            : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_REJECTED';
          reject(new ProviderError(code, status === 429 || status >= 500, retryAfter(response.headers['retry-after'])));
          return;
        }
        const contentType = response.headers['content-type']?.split(';')[0]?.trim();
        if (contentType !== 'application/json') {
          response.destroy();
          reject(new ProviderError('INVALID_CONTENT_TYPE'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 8 * 1024 * 1024) {
            response.destroy();
            reject(new ProviderError('OUTPUT_LIMIT_EXCEEDED'));
          } else chunks.push(chunk);
        });
        response.on('error', () => reject(new ProviderError('RESPONSE_INTERRUPTED', true)));
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
          catch { reject(new ProviderError('INVALID_PROVIDER_RESPONSE')); }
        });
      });
      const deadline = setTimeout(() => request.destroy(new Error('deadline')), 20_000);
      request.on('close', () => clearTimeout(deadline));
      request.on('error', () => reject(new ProviderError(signal?.aborted ? 'CANCELLED' : 'NETWORK_UNAVAILABLE', !signal?.aborted)));
      request.end();
    });
  }
}
