import { createPublicKey, verify } from 'node:crypto';
import { parseVersion } from './version.js';

export function validateConfig(config) {
  if (!config || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? '') || !Object.keys(config.publicKeys ?? {}).length) return false;
  for (const key of Object.values(config.publicKeys)) if (createPublicKey(key).asymmetricKeyType !== 'ed25519') throw new Error('Release keys must be Ed25519 public keys.');
  return true;
}
export function assetURL(repository, tag, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid release asset name.');
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
}
export function verifyManifest(envelope, config, { tag, platform, arch, now = Date.now() }) {
  if (!validateConfig(config)) throw new Error('Trusted release source is not configured.');
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 500000 || typeof envelope.signature !== 'string' || envelope.signature.length > 100 || !Object.hasOwn(config.publicKeys, envelope.keyId)) throw new Error('Missing trusted release signature.');
  const payload = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  if (payload.toString('base64') !== envelope.payload || signature.length !== 64 || signature.toString('base64') !== envelope.signature || !verify(null, payload, config.publicKeys[envelope.keyId], signature)) throw new Error('Release signature verification failed.');
  const m = JSON.parse(payload.toString('utf8'));
  const version = parseVersion(m.version);
  const published = Date.parse(m.publishedAt), expires = Date.parse(m.expiresAt);
  if (m.schemaVersion !== 1 || m.repository !== config.repository || m.tag !== tag || m.version !== tag.replace(/^v/, '') || !['stable', 'beta'].includes(m.channel) || (m.channel === 'stable' && version.pre.length) || (m.channel === 'beta' && version.pre[0] !== 'beta')) throw new Error('Release identity or channel mismatch.');
  if (!Number.isFinite(published) || !Number.isFinite(expires) || published > now + 300000 || expires <= now || expires <= published || expires - published > 31 * 86400000) throw new Error('Release metadata is expired or has invalid dates.');
  if (typeof m.notes !== 'string' || m.notes.length > 50000 || !Array.isArray(m.packages) || m.packages.length > 20) throw new Error('Invalid release metadata.');
  const packages = m.packages.filter(p => p.platform === platform && p.arch === arch);
  if (packages.length !== 1) throw new Error('No unique package for this platform and architecture.');
  const p = packages[0];
  if (!Number.isSafeInteger(p.size) || p.size <= 0 || p.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(p.sha256) || !['zip', 'dmg', 'exe', 'msix', 'AppImage', 'deb', 'rpm'].includes(p.format) || !p.name.endsWith(`.${p.format}`)) throw new Error('Invalid package size, checksum or format.');
  return { ...m, package: { ...p, url: assetURL(config.repository, tag, p.name) } };
}
