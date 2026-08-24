/** Opaque, unguessable participant token used as a bearer secret in personal links. */
export function newToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A 32-bit seed suitable for the solver PRNG. */
export function newSeed(): number {
  return Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]! / 2);
}
