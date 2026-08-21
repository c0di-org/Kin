/**
 * Typed wrappers over the WebCrypto calls that `@cloudflare/workers-types` describes more loosely
 * than the runtime behaves.
 *
 * `generateKey` is typed as `CryptoKey | CryptoKeyPair` rather than overloaded on its algorithm,
 * and `exportKey` as `ArrayBuffer | JsonWebKey` rather than on its format, so both need narrowing
 * at every call site. ECDH's peer field is spelled `$public` in those types while the runtime
 * reads `public` — so that one must stay a cast and must never be renamed to match the types.
 *
 * Holding them here writes each cast once, next to the reason for it, instead of scattering them
 * through code that should read like the spec it implements.
 */

type GenerateAlgorithm = Parameters<typeof crypto.subtle.generateKey>[0];
type KeyUsages = Parameters<typeof crypto.subtle.generateKey>[2];
type DeriveAlgorithm = Parameters<typeof crypto.subtle.deriveBits>[0];

export async function generateKeyPair(algorithm: GenerateAlgorithm, usages: KeyUsages): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(algorithm, true, usages) as CryptoKeyPair;
}

export async function exportRaw(key: CryptoKey): Promise<ArrayBuffer> {
  return await crypto.subtle.exportKey("raw", key) as ArrayBuffer;
}

export async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey("jwk", key) as JsonWebKey;
}

/** ECDH bit derivation. The algorithm object is cast because its runtime shape uses `public`. */
export function deriveEcdhBits(peerPublicKey: CryptoKey, privateKey: CryptoKey, bits: number): Promise<ArrayBuffer> {
  const algorithm = { name: "ECDH", public: peerPublicKey } as unknown as DeriveAlgorithm;
  return crypto.subtle.deriveBits(algorithm, privateKey, bits);
}
