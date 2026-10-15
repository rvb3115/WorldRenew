export class WorldError extends Error {
  constructor(code, message) { super(message); this.name = 'WorldError'; this.code = code; }
}
export function requireThat(condition, code, message) {
  if (!condition) throw new WorldError(code, message);
}
