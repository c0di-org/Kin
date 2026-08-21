/** RFC 8291 / RFC 8292 Web Push sender using Web Crypto + fetch (Workers-safe). */
import { deriveEcdhBits, exportRaw, generateKeyPair } from "./webcrypto";

export type PushSubscriptionJSON = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const encoder = new TextEncoder();

function asBuf(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return value as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", asBuf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: asBuf(salt), info: asBuf(info) }, key, length * 8);
  return new Uint8Array(bits);
}

async function importEcdhPrivate(uncompressedPublic: Uint8Array, privateRaw: Uint8Array): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(uncompressedPublic.subarray(1, 33)),
    y: bytesToB64url(uncompressedPublic.subarray(33, 65)),
    d: bytesToB64url(privateRaw),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

async function importEcdsaPrivate(uncompressedPublic: Uint8Array, privateRaw: Uint8Array): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(uncompressedPublic.subarray(1, 33)),
    y: bytesToB64url(uncompressedPublic.subarray(33, 65)),
    d: bytesToB64url(privateRaw),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export type EncryptOverrides = {
  salt?: Uint8Array;
  senderPublic?: Uint8Array;
  senderPrivate?: Uint8Array;
};

export async function encryptPushPayload(userPublicKey: Uint8Array, userAuth: Uint8Array, plaintext: Uint8Array, overrides: EncryptOverrides = {}): Promise<Uint8Array<ArrayBuffer>> {
  const sender = overrides.senderPrivate && overrides.senderPublic
    ? { publicKey: overrides.senderPublic, privateKey: await importEcdhPrivate(overrides.senderPublic, overrides.senderPrivate) }
    : await (async () => {
      const pair = await generateKeyPair({ name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
      return { publicKey: new Uint8Array(await exportRaw(pair.publicKey)), privateKey: pair.privateKey };
    })();

  const uaPublic = await crypto.subtle.importKey("raw", asBuf(userPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await deriveEcdhBits(uaPublic, sender.privateKey, 256));
  const keyInfo = concat(encoder.encode("WebPush: info"), new Uint8Array([0]), userPublicKey, sender.publicKey);
  const ikm = await hkdf(ecdhSecret, userAuth, keyInfo, 32);
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  const padded = concat(plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));
  const header = new Uint8Array(16 + 4 + 1 + sender.publicKey.byteLength);
  header.set(salt, 0);
  header[16] = 0;
  header[17] = 0;
  header[18] = 16;
  header[19] = 0; // record size 4096
  header[20] = sender.publicKey.byteLength;
  header.set(sender.publicKey, 21);
  return concat(header, ciphertext);
}

async function vapidJwt(audience: string, vapid: VapidKeys): Promise<string> {
  const publicKey = b64urlToBytes(vapid.publicKey);
  const privateKey = await importEcdsaPrivate(publicKey, b64urlToBytes(vapid.privateKey));
  const encode = (value: unknown) => bytesToB64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(unsigned)));
  return `${unsigned}.${bytesToB64url(signature)}`;
}

export async function sendPushNotification(
  subscription: PushSubscriptionJSON,
  payload: string | Uint8Array,
  vapid: VapidKeys,
  options?: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high" }
): Promise<Response> {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  const body = await encryptPushPayload(
    b64urlToBytes(subscription.keys.p256dh),
    b64urlToBytes(subscription.keys.auth),
    typeof payload === "string" ? encoder.encode(payload) : payload
  );
  const jwt = await vapidJwt(new URL(subscription.endpoint).origin, vapid);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: String(options?.ttl ?? 7 * 24 * 60 * 60),
      Urgency: options?.urgency ?? "high",
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`
    },
    body
  });
}
