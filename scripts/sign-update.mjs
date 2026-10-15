// Run in the release environment with an externally stored Ed25519 private key.
import fs from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { verifyManifest } from '../updates/manifest.js';
const [input, keyFile, keyId, output] = process.argv.slice(2);
if (!input || !keyFile || !keyId || !output) throw new Error('Usage: node scripts/sign-update.mjs manifest.json /secure/key.pem key-id worldrenew-update.json');
const payload = fs.readFileSync(input), manifest = JSON.parse(payload);
const key = createPrivateKey(fs.readFileSync(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required.');
const envelope = { keyId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
const config = { repository: manifest.repository, publicKeys: { [keyId]: createPublicKey(key).export({ type: 'spki', format: 'pem' }) } };
if (!Array.isArray(manifest.packages) || !manifest.packages.length) throw new Error('At least one package is required.');
for (const p of manifest.packages) verifyManifest(envelope, config, { tag: manifest.tag, platform: p.platform, arch: p.arch });
fs.writeFileSync(output, JSON.stringify(envelope, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Signed release metadata: ${output}`);
