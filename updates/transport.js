import https from 'node:https';
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export function trustedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) throw new Error('Update URL is not trusted HTTPS.');
  return url;
}
// TLS verification is explicit, including when the caller's environment disables Node's default.
export async function openHTTPS(value, { signal, get = https.get, redirects = 0 } = {}) {
  const url = trustedURL(value);
  const response = await new Promise((resolve, reject) => {
    const req = get(url, { rejectUnauthorized: true, signal, headers: { 'User-Agent': 'WorldRenew-Updater', Accept: 'application/vnd.github+json' } }, resolve);
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Update request timed out.')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (redirects >= 5 || !response.headers.location) throw new Error('Invalid update redirect.');
    return openHTTPS(new URL(response.headers.location, url).href, { signal, get, redirects: redirects + 1 });
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`Update server returned HTTP ${response.statusCode}. Try again later.`); }
  return response;
}
export async function readHTTPS(url, limit, { signal, open = openHTTPS } = {}) {
  const stream = await open(url, { signal });
  const parts = []; let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > limit) throw new Error('Update response exceeds its size limit.');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } finally { stream.destroy(); }
}
