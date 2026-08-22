import type { ChatPayload, CipherEnvelope, LocalIdentity, PublicMember } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Bytes = Uint8Array<ArrayBuffer>;

export function asBytes(value: ArrayBuffer | Uint8Array): Bytes {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return value as Bytes;
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = asBytes(bytes);
  let s = "";
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function unb64(value: string): Bytes {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function sha256(value: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? enc.encode(value) : asBytes(value);
  return b64(await crypto.subtle.digest("SHA-256", bytes));
}

export function randomKey(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomId(): string {
  return crypto.randomUUID();
}

export async function generateIdentity(displayName: string): Promise<LocalIdentity> {
  const dh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    deviceId: crypto.randomUUID(),
    displayName: displayName.trim().slice(0, 32),
    avatarSeed: b64(crypto.getRandomValues(new Uint8Array(8))),
    dhPublicJwk: await crypto.subtle.exportKey("jwk", dh.publicKey),
    dhPrivateJwk: await crypto.subtle.exportKey("jwk", dh.privateKey),
    signPublicJwk: await crypto.subtle.exportKey("jwk", sign.publicKey),
    signPrivateJwk: await crypto.subtle.exportKey("jwk", sign.privateKey)
  };
}

export function publicMember(identity: LocalIdentity): PublicMember {
  const { deviceId, displayName, avatarSeed, dhPublicJwk, signPublicJwk } = identity;
  return { deviceId, displayName, avatarSeed, dhPublicJwk, signPublicJwk };
}

async function importConversationKey(key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64(key), { name: "AES-GCM" }, false, usage);
}

export async function encryptPayload(conversationId: string, key: string, senderDeviceId: string, payload: ChatPayload): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const createdAt = Date.now();
  const id = crypto.randomUUID();
  const aes = await importConversationKey(key, ["encrypt"]);
  const aad = enc.encode(`${conversationId}:${id}:${senderDeviceId}:${createdAt}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, aes, enc.encode(JSON.stringify(payload)));
  return {
    kind: "message",
    id,
    conversationId,
    senderDeviceId,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    signature: ""
  };
}

export async function decryptPayload(envelope: CipherEnvelope, key: string): Promise<ChatPayload> {
  const aes = await importConversationKey(key, ["decrypt"]);
  const aad = enc.encode(`${envelope.conversationId}:${envelope.id}:${envelope.senderDeviceId}:${envelope.createdAt}`);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: aad }, aes, unb64(envelope.ciphertext));
  return JSON.parse(dec.decode(clear)) as ChatPayload;
}

function envelopeText(envelope: Omit<CipherEnvelope, "signature"> | CipherEnvelope): string {
  return [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
}

export async function signEnvelope(identity: LocalIdentity, envelope: CipherEnvelope): Promise<CipherEnvelope> {
  const key = await crypto.subtle.importKey("jwk", identity.signPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(envelopeText(envelope)));
  return { ...envelope, signature: b64(signature) };
}

export async function verifyEnvelope(envelope: CipherEnvelope, member: PublicMember): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", member.signPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(envelope.signature), enc.encode(envelopeText(envelope)));
  } catch { return false; }
}

async function derivePairwiseAes(identity: LocalIdentity, peer: PublicMember, label: string): Promise<CryptoKey> {
  const priv = await crypto.subtle.importKey("jwk", identity.dhPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("jwk", peer.dhPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey", "deriveBits"]);
  const ids = [identity.deviceId, peer.deviceId].sort().join(":");
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`kin:${label}:${ids}`));
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`kin-${label}-v1`) }, material, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function directConversation(identity: LocalIdentity, peer: PublicMember): Promise<{ id: string; key: string }> {
  const key = await derivePairwiseAes(identity, peer, "direct");
  const raw = await crypto.subtle.exportKey("raw", key);
  const ids = [identity.deviceId, peer.deviceId].sort().join(":");
  const id = (await sha256(`kin-direct-room:${ids}`)).slice(0, 32);
  return { id, key: b64(raw) };
}

export async function wrapConversationKey(identity: LocalIdentity, peer: PublicMember, conversationKey: string): Promise<{ wrappedKey: string; wrapIv: string }> {
  const wrapping = await derivePairwiseAes(identity, peer, "wrap");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapping, unb64(conversationKey));
  return { wrappedKey: b64(wrapped), wrapIv: b64(iv) };
}

export async function unwrapConversationKey(identity: LocalIdentity, peer: PublicMember, wrappedKey: string, wrapIv: string): Promise<string> {
  const wrapping = await derivePairwiseAes(identity, peer, "wrap");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrapIv) }, wrapping, unb64(wrappedKey));
  return b64(clear);
}

/** HKDF a 256-bit AES-GCM key out of raw secret bytes, domain-separated by `label`. */
async function deriveAesFrom(secret: Uint8Array, label: string, extractable = true): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", asBytes(secret), "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`kin:${label}`));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`kin-${label}-v1`) },
    material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]
  );
}

/**
 * A channel's key, derived from the key of the space it lives in.
 *
 * This is the whole reason channels are cheap: a space member can compute the key for a channel
 * they have never seen from its id alone, so creating one needs no pairing, no rewrapping and no
 * round trip to anybody else's device. It also means channels inherit the space's trust exactly
 * — everyone in the space can read every channel in it, whether or not they have opened it.
 * Anything that needs a narrower audience than the space is a separate space, not a channel.
 */
export async function deriveChannelKey(spaceKey: string, channelId: string): Promise<string> {
  const key = await deriveAesFrom(unb64(spaceKey), `channel:${channelId}`);
  return b64(await crypto.subtle.exportKey("raw", key));
}

/** Encrypt a channel's name and emoji under the space key, for the relay to hold and not read. */
export async function sealChannelMeta(spaceKey: string, meta: { title: string; emoji: string }): Promise<{ blob: string; iv: string }> {
  const key = await deriveAesFrom(unb64(spaceKey), "channel-directory", false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const blob = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(meta)));
  return { blob: b64(blob), iv: b64(iv) };
}

export async function openChannelMeta(spaceKey: string, blob: string, iv: string): Promise<{ title: string; emoji: string }> {
  const key = await deriveAesFrom(unb64(spaceKey), "channel-directory", false);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(blob));
  return JSON.parse(dec.decode(clear)) as { title: string; emoji: string };
}

/**
 * The two values an invite secret produces, neither of which reveals it.
 *
 * `proof` is what the relay stores and checks at redemption, so that knowing an invite *code* —
 * which the relay does know — is not enough to walk into the room. `key` never leaves the
 * browser: it is what the room key is sealed under, which is what keeps the relay unable to read
 * a room it is handing out invites to.
 */
async function inviteMaterial(code: string, secret: string): Promise<{ proof: string; key: CryptoKey }> {
  const bytes = unb64(secret);
  return {
    proof: await sha256(`kin-invite-proof:${code}:${secret}`),
    key: await deriveAesFrom(bytes, `invite:${code}`, false)
  };
}

export function inviteSecret(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealInvite(code: string, secret: string, roomKey: string): Promise<{ proof: string; wrappedKey: string; iv: string }> {
  const { proof, key } = await inviteMaterial(code, secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, unb64(roomKey));
  return { proof, wrappedKey: b64(wrappedKey), iv: b64(iv) };
}

export async function openInvite(code: string, secret: string, wrappedKey: string, iv: string): Promise<{ proof: string; roomKey: string }> {
  const { proof, key } = await inviteMaterial(code, secret);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(wrappedKey));
  return { proof, roomKey: b64(clear) };
}

const EMOJI = ["🌿","🌙","⭐","🍓","🐳","🦊","🌈","🍋","🪁","🐝","🍀","🫐","🐢","🌸","☀️","🎈","🦋","🍉","🐬","🌻","🥝","🧸","🏕️","🍪"];
export async function safetyCode(a: PublicMember, b: PublicMember): Promise<string> {
  const fingerprints = [JSON.stringify(a.dhPublicJwk), JSON.stringify(b.dhPublicJwk)].sort().join("|");
  const hash = unb64(await sha256(fingerprints));
  return Array.from(hash.slice(0, 4), n => EMOJI[n % EMOJI.length]).join(" ");
}

export async function signRequest(identity: LocalIdentity, method: string, path: string, body = "", bodyHashOverride?: string): Promise<Record<string, string>> {
  const ts = String(Date.now());
  const nonce = b64(crypto.getRandomValues(new Uint8Array(8)));
  const bodyHash = bodyHashOverride ?? await sha256(body);
  const canonical = [method.toUpperCase(), path, ts, nonce, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("jwk", identity.signPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(canonical));
  return {
    "X-Kin-Device": identity.deviceId,
    "X-Kin-Time": ts,
    "X-Kin-Nonce": nonce,
    "X-Kin-Body": bodyHash,
    "X-Kin-Signature": b64(signature)
  };
}

export async function encryptFile(file: File): Promise<{ ciphertext: Bytes; key: string; iv: string; sha256: string }> {
  const key = randomKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await importConversationKey(key, ["encrypt"]);
  const clear = await file.arrayBuffer();
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, clear));
  return { ciphertext: cipher, key, iv: b64(iv), sha256: await sha256(cipher) };
}

export async function decryptFile(ciphertext: ArrayBuffer, key: string, iv: string): Promise<ArrayBuffer> {
  const aes = await importConversationKey(key, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, aes, ciphertext);
}
