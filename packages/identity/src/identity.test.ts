import { it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CredentialVault } from './vault';
import { verifyIdentity } from './oidc';
it('fails closed when OS encryption is unavailable', async () => {
  const vault = new CredentialVault(
    path.join(await mkdtemp(path.join(tmpdir(), 'sand-vault-')), 'vault'),
    {
      available: async () => false,
      encrypt: async () => {
        throw new Error('must not encrypt');
      },
      decrypt: async () => '',
    },
  );
  await expect(vault.set('provider', 'sensitive')).rejects.toMatchObject({
    code: 'KEYCHAIN_UNAVAILABLE',
  });
});
it('serializes credential updates and never writes plaintext (test-only reversible cipher)', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'sand-vault-')), 'vault');
  const vault = new CredentialVault(file, {
    available: async () => true,
    encrypt: async (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0xaa)),
    decrypt: async (b) => Buffer.from(b.map((x) => x ^ 0xaa)).toString(),
  });
  await Promise.all([vault.set('a', 'canary-alpha'), vault.set('b', 'canary-beta')]);
  expect(await vault.get('a')).toBe('canary-alpha');
  expect(await vault.get('b')).toBe('canary-beta');
  expect((await readFile(file)).toString()).not.toContain('canary');
  await vault.set('a', undefined);
  expect(await vault.get('a')).toBeUndefined();
});
it('verifies OIDC signature, issuer, audience, expiry and nonce rather than trusting decoded JWTs', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256'),
    jwk = await exportJWK(publicKey),
    config = { issuer: 'https://issuer.example', clientId: 'sand-public' };
  const sign = (options: { issuer?: string; audience?: string; nonce?: string; expiry?: string }) =>
    new SignJWT({ nonce: options.nonce ?? 'expected' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.issuer ?? config.issuer)
      .setAudience(options.audience ?? config.clientId)
      .setSubject('test-user')
      .setIssuedAt()
      .setExpirationTime(options.expiry ?? '5m')
      .sign(privateKey);
  expect(await verifyIdentity(await sign({}), { keys: [jwk] }, config, 'expected')).toMatchObject({
    subject: 'test-user',
  });
  for (const change of [
    { issuer: 'https://attacker.example' },
    { audience: 'other' },
    { nonce: 'replay' },
    { expiry: '-1m' },
  ])
    await expect(
      verifyIdentity(await sign(change), { keys: [jwk] }, config, 'expected'),
    ).rejects.toThrow();
});
