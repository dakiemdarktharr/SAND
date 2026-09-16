import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { EgressBroker } from '../../tools/src/egress.js';
import { CredentialVault } from './vault.js';
import { StudioError } from '../../studio/src/schema.js';
export interface OidcConfig {
  issuer: string;
  clientId: string;
  port: number;
}
interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}
interface StoredSession {
  issuer: string;
  subject: string;
  expiresAt: number;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  revocationEndpoint?: string;
  clientId: string;
}
export async function verifyIdentity(
  idToken: string,
  jwks: JSONWebKeySet,
  config: Pick<OidcConfig, 'issuer' | 'clientId'>,
  nonce: string,
) {
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ['RS256', 'ES256', 'PS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    maxTokenAge: '10m',
    clockTolerance: 5,
  });
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    ((payload.azp || (Array.isArray(payload.aud) && payload.aud.length > 1)) &&
      payload.azp !== config.clientId)
  )
    throw new StudioError('OIDC_CLAIMS_INVALID', 'OIDC nonce/authorized party không hợp lệ.');
  return { subject: payload.sub, expiresAt: payload.exp! };
}
export class DesktopOidc {
  private pending = false;
  constructor(
    private vault: CredentialVault,
    private config: OidcConfig | undefined,
    private openBrowser: (url: string) => Promise<void>,
    private network = new EgressBroker(),
  ) {}
  private async metadata() {
    const c = this.config;
    if (!c)
      throw new StudioError(
        'OIDC_UNCONFIGURED',
        'Cấu hình SAND_OIDC_ISSUER, SAND_OIDC_CLIENT_ID và redirect URI loopback.',
      );
    const issuer = new URL(c.issuer);
    if (
      issuer.protocol !== 'https:' ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      !Number.isInteger(c.port) ||
      c.port < 1024 ||
      c.port > 65535
    )
      throw new StudioError('OIDC_CONFIGURATION', 'OIDC issuer/port không hợp lệ.');
    const response = await this.network.fetch(
      c.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
      {},
      [issuer.origin],
    );
    if (!response.ok)
      throw new StudioError('OIDC_DISCOVERY_FAILED', 'Không tải được OIDC metadata.');
    const data = (await response.json()) as Metadata;
    if (data.issuer !== c.issuer || !data.code_challenge_methods_supported?.includes('S256'))
      throw new StudioError(
        'OIDC_CONFIGURATION',
        'Issuer phải khớp chính xác và hỗ trợ PKCE S256.',
      );
    for (const endpoint of [
      data.authorization_endpoint,
      data.token_endpoint,
      data.jwks_uri,
      data.revocation_endpoint,
    ].filter(Boolean)) {
      const target = new URL(endpoint!);
      if (target.origin !== issuer.origin || target.username || target.password || target.hash)
        throw new StudioError(
          'OIDC_ENDPOINT_DENIED',
          'Preview yêu cầu mọi OIDC endpoint cùng origin issuer.',
        );
    }
    return data;
  }
  async status() {
    if (!this.config) return { configured: false, signedIn: false };
    const raw = await this.vault.get('oidc.session');
    if (!raw) return { configured: true, signedIn: false };
    const session = JSON.parse(raw) as StoredSession;
    return {
      configured: true,
      signedIn:
        session.issuer === this.config.issuer &&
        session.clientId === this.config.clientId &&
        session.expiresAt * 1000 > Date.now(),
      issuer: session.issuer,
      subject: session.subject,
      expiresAt: session.expiresAt,
    };
  }
  async login() {
    if (this.pending) throw new StudioError('OIDC_BUSY', 'Đăng nhập đang chờ trong trình duyệt.');
    if (!(await this.vault.available()))
      throw new StudioError('KEYCHAIN_UNAVAILABLE', 'Đăng nhập yêu cầu OS secret storage.');
    this.pending = true;
    try {
      const metadata = await this.metadata(),
        config = this.config!,
        origin = new URL(config.issuer).origin;
      const verifier = randomBytes(32).toString('base64url'),
        state = randomBytes(32).toString('base64url'),
        nonce = randomBytes(32).toString('base64url');
      const redirect = 'http://127.0.0.1:' + config.port + '/callback';
      const authorization = new URL(metadata.authorization_endpoint);
      authorization.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        scope: 'openid profile',
        redirect_uri: redirect,
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      const code = await new Promise<string>((resolve, reject) => {
        let used = false;
        const server = createServer((req, res) => {
          res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'text/plain');
          const url = new URL(req.url ?? '/', redirect);
          if (
            used ||
            req.method !== 'GET' ||
            req.headers.host !== '127.0.0.1:' + config.port ||
            url.origin !== new URL(redirect).origin ||
            url.pathname !== '/callback' ||
            url.searchParams.getAll('state').length !== 1 ||
            url.searchParams.get('state') !== state ||
            url.searchParams.getAll('code').length !== 1
          ) {
            res.writeHead(400);
            res.end('Invalid callback');
            return;
          }
          used = true;
          res.end('SAND received the authorization response. Return to the desktop.');
          cleanup();
          resolve(url.searchParams.get('code')!);
        });
        const timer = setTimeout(() => {
          cleanup();
          reject(new StudioError('OIDC_TIMEOUT', 'Đăng nhập hết hạn sau 3 phút.'));
        }, 180000);
        const cleanup = () => {
          clearTimeout(timer);
          server.close();
          server.closeAllConnections();
        };
        server.once('error', () => {
          cleanup();
          reject(new StudioError('OIDC_CALLBACK_UNAVAILABLE', 'Loopback port đang được sử dụng.'));
        });
        server.listen(config.port, '127.0.0.1', () => {
          void this.openBrowser(authorization.href).catch(() => {
            cleanup();
            reject(new StudioError('OIDC_BROWSER_FAILED', 'Không mở được system browser.'));
          });
        });
      });
      const response = await this.network.fetch(
        metadata.token_endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            redirect_uri: redirect,
            code,
            code_verifier: verifier,
          }),
        },
        [origin],
      );
      if (!response.ok)
        throw new StudioError('OIDC_EXCHANGE_FAILED', 'OIDC code exchange thất bại.');
      const tokens = (await response.json()) as Record<string, unknown>;
      if (
        typeof tokens.id_token !== 'string' ||
        typeof tokens.access_token !== 'string' ||
        String(tokens.token_type).toLowerCase() !== 'bearer'
      )
        throw new StudioError('OIDC_TOKEN_INVALID', 'OIDC token response không hợp lệ.');
      const keys = await this.network.fetch(metadata.jwks_uri, {}, [origin]);
      if (!keys.ok) throw new StudioError('OIDC_JWKS_FAILED', 'Không tải được khóa xác minh.');
      const identity = await verifyIdentity(
        tokens.id_token,
        (await keys.json()) as JSONWebKeySet,
        config,
        nonce,
      );
      const stored: StoredSession = {
        issuer: config.issuer,
        subject: identity.subject,
        expiresAt: Math.min(
          identity.expiresAt,
          typeof tokens.expires_in === 'number'
            ? Math.floor(Date.now() / 1000) + tokens.expires_in
            : identity.expiresAt,
        ),
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        clientId: config.clientId,
        ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}),
        ...(metadata.revocation_endpoint
          ? { revocationEndpoint: metadata.revocation_endpoint }
          : {}),
      };
      await this.vault.set('oidc.session', JSON.stringify(stored));
      return this.status();
    } finally {
      this.pending = false;
    }
  }
  async logout() {
    const raw = await this.vault.get('oidc.session');
    let revoked = false;
    if (raw) {
      const stored = JSON.parse(raw) as StoredSession;
      if (stored.revocationEndpoint) {
        try {
          const response = await this.network.fetch(
            stored.revocationEndpoint,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: stored.refreshToken ?? stored.accessToken,
                client_id: stored.clientId,
                token_type_hint: stored.refreshToken ? 'refresh_token' : 'access_token',
              }),
            },
            [new URL(stored.issuer).origin],
          );
          revoked = response.ok;
        } catch {
          revoked = false;
        }
      }
      await this.vault.set('oidc.session', undefined);
    }
    return {
      signedIn: false,
      revoked,
      reason: revoked
        ? 'provider_revocation_confirmed'
        : 'local_session_removed; provider_revocation_not_confirmed',
    };
  }
}
