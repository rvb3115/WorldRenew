// Strict SemVer precedence, without coercion or floating-point integer truncation.
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid application version.');
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) throw new Error('Invalid application version.');
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) throw new Error('Invalid prerelease version.');
  return { core: match.slice(1, 4).map(BigInt), pre };
}
export function compareVersions(a, b) {
  a = parseVersion(a); b = parseVersion(b);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
