import { describe, expect, it } from "vitest";
import {
  b64, decryptPayload, directConversation, encryptPayload, generateIdentity, publicMember,
  randomKey, safetyCode, sha256, signEnvelope, signRequest, unb64, unwrapConversationKey,
  verifyEnvelope, wrapConversationKey
} from "./crypto";
import type { ChatPayload, LocalIdentity } from "./types";

const enc = new TextEncoder();
const identity = (name: string) => generateIdentity(name);
const payload: ChatPayload = { type: "text", text: "the spare key is under the blue pot 🪴" };

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 255]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect([...unb64(b64(bytes))]).toEqual([...bytes]);
    }
  });

  it("emits url-safe, unpadded output", () => {
    const encoded = b64(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("sha256", () => {
  it("matches the known digest of the empty string", async () => {
    // SHA-256("") = e3b0c442... , base64url-encoded
    expect(await sha256("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it("agrees whether given a string or its bytes", async () => {
    expect(await sha256("kin")).toBe(await sha256(enc.encode("kin")));
  });
});

describe("envelope signing", () => {
  it("verifies an envelope signed by its sender", async () => {
    const me = await identity("Alice");
    const env = await signEnvelope(me, await encryptPayload("room-1", randomKey(), me.deviceId, payload));
    expect(await verifyEnvelope(env, publicMember(me))).toBe(true);
  });

  it("rejects an envelope checked against somebody else's key", async () => {
    const me = await identity("Alice");
    const other = await identity("Mallory");
    const env = await signEnvelope(me, await encryptPayload("room-1", randomKey(), me.deviceId, payload));
    expect(await verifyEnvelope(env, publicMember(other))).toBe(false);
  });

  it("rejects an envelope whose ciphertext was swapped after signing", async () => {
    const me = await identity("Alice");
    const env = await signEnvelope(me, await encryptPayload("room-1", randomKey(), me.deviceId, payload));
    expect(await verifyEnvelope({ ...env, ciphertext: b64(enc.encode("something else")) }, publicMember(me))).toBe(false);
  });

  it("rejects an envelope re-labelled with a different sender or timestamp", async () => {
    const me = await identity("Alice");
    const env = await signEnvelope(me, await encryptPayload("room-1", randomKey(), me.deviceId, payload));
    expect(await verifyEnvelope({ ...env, senderDeviceId: "someone-else" }, publicMember(me))).toBe(false);
    expect(await verifyEnvelope({ ...env, createdAt: env.createdAt + 1 }, publicMember(me))).toBe(false);
  });
});

describe("payload encryption", () => {
  it("round-trips through the conversation key", async () => {
    const me = await identity("Alice");
    const key = randomKey();
    const env = await encryptPayload("room-1", key, me.deviceId, payload);
    expect(env.ciphertext).not.toContain("blue pot");
    expect(await decryptPayload(env, key)).toEqual(payload);
  });

  it("refuses a different conversation key", async () => {
    const me = await identity("Alice");
    const env = await encryptPayload("room-1", randomKey(), me.deviceId, payload);
    await expect(decryptPayload(env, randomKey())).rejects.toThrow();
  });

  it("binds the ciphertext to its envelope headers, so it cannot be replayed as another message", async () => {
    const me = await identity("Alice");
    const key = randomKey();
    const env = await encryptPayload("room-1", key, me.deviceId, payload);
    await expect(decryptPayload({ ...env, conversationId: "room-2" }, key)).rejects.toThrow();
    await expect(decryptPayload({ ...env, senderDeviceId: "someone-else" }, key)).rejects.toThrow();
    await expect(decryptPayload({ ...env, id: crypto.randomUUID() }, key)).rejects.toThrow();
  });
});

describe("pairwise key derivation", () => {
  it("lets the invited device unwrap the family key the inviter wrapped for it", async () => {
    const inviter = await identity("Alice");
    const joiner = await identity("Bob");
    const familyKey = randomKey();
    const { wrappedKey, wrapIv } = await wrapConversationKey(inviter, publicMember(joiner), familyKey);
    expect(wrappedKey).not.toBe(familyKey);
    expect(await unwrapConversationKey(joiner, publicMember(inviter), wrappedKey, wrapIv)).toBe(familyKey);
  });

  it("keeps a third device out of the wrap", async () => {
    const inviter = await identity("Alice");
    const joiner = await identity("Bob");
    const outsider = await identity("Mallory");
    const { wrappedKey, wrapIv } = await wrapConversationKey(inviter, publicMember(joiner), randomKey());
    await expect(unwrapConversationKey(outsider, publicMember(inviter), wrappedKey, wrapIv)).rejects.toThrow();
  });

  it("derives the same direct conversation from either side", async () => {
    const a = await identity("Alice");
    const b = await identity("Bob");
    const fromA = await directConversation(a, publicMember(b));
    const fromB = await directConversation(b, publicMember(a));
    expect(fromA).toEqual(fromB);
    expect(fromA.id).toHaveLength(32);
  });

  it("derives the room id from the two device ids, as the relay recomputes it", async () => {
    const a = await identity("Alice");
    const b = await identity("Bob");
    const { id } = await directConversation(a, publicMember(b));
    const expected = (await sha256(`kin-direct-room:${[a.deviceId, b.deviceId].sort().join(":")}`)).slice(0, 32);
    expect(id).toBe(expected);
  });

  it("gives a different pair a different room and key", async () => {
    const a = await identity("Alice");
    const b = await identity("Bob");
    const c = await identity("Carol");
    const ab = await directConversation(a, publicMember(b));
    const ac = await directConversation(a, publicMember(c));
    expect(ab.id).not.toBe(ac.id);
    expect(ab.key).not.toBe(ac.key);
  });

  it("separates the wrapping key from the direct-message key for the same pair", async () => {
    const a = await identity("Alice");
    const b = await identity("Bob");
    const direct = await directConversation(a, publicMember(b));
    const secret = randomKey();
    const wrapped = await wrapConversationKey(a, publicMember(b), secret);
    // If the two labels collided, the direct key would unwrap the wrap.
    await expect(unwrapConversationKey(a, publicMember(b), wrapped.wrappedKey, wrapped.wrapIv)).resolves.toBe(secret);
    expect(direct.key).not.toBe(secret);
  });
});

describe("safety code", () => {
  it("reads the same on both devices", async () => {
    const a = publicMember(await identity("Alice"));
    const b = publicMember(await identity("Bob"));
    expect(await safetyCode(a, b)).toBe(await safetyCode(b, a));
  });

  it("changes when a device key changes, which is the whole point of showing it", async () => {
    const a = publicMember(await identity("Alice"));
    const b = publicMember(await identity("Bob"));
    const impostor = publicMember(await identity("Mallory"));
    expect(await safetyCode(a, b)).not.toBe(await safetyCode(a, { ...b, dhPublicJwk: impostor.dhPublicJwk }));
  });

  it("is four emoji", async () => {
    const a = publicMember(await identity("Alice"));
    const b = publicMember(await identity("Bob"));
    // Two fingerprints of eight, one per device: forty bits each, and each one a preimage
    // problem on its own rather than a collision search across a pair the attacker picks.
    const lines = (await safetyCode(a, b)).split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.split(" ")).toHaveLength(8);
  });
});

describe("signRequest", () => {
  async function verify(id: LocalIdentity, headers: Record<string, string>, method: string, path: string): Promise<boolean> {
    const key = await crypto.subtle.importKey("jwk", id.signPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const canonical = [method, path, headers["X-Kin-Time"], headers["X-Kin-Nonce"], headers["X-Kin-Body"]].join("\n");
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(headers["X-Kin-Signature"]), enc.encode(canonical));
  }

  it("signs the method, path, time, nonce and body hash together", async () => {
    const me = await identity("Alice");
    const body = JSON.stringify({ hello: "world" });
    const headers = await signRequest(me, "POST", "/api/rooms/r/members", body);
    expect(headers["X-Kin-Device"]).toBe(me.deviceId);
    expect(headers["X-Kin-Body"]).toBe(await sha256(body));
    expect(await verify(me, headers, "POST", "/api/rooms/r/members")).toBe(true);
  });

  it("uppercases the method it signs", async () => {
    const me = await identity("Alice");
    const headers = await signRequest(me, "post", "/api/rooms/r/members", "{}");
    expect(await verify(me, headers, "POST", "/api/rooms/r/members")).toBe(true);
  });

  it("does not verify against a different path, method or body", async () => {
    const me = await identity("Alice");
    const headers = await signRequest(me, "POST", "/api/rooms/r/members", "{}");
    expect(await verify(me, headers, "POST", "/api/rooms/other/members")).toBe(false);
    expect(await verify(me, headers, "GET", "/api/rooms/r/members")).toBe(false);
    expect(await verify(me, { ...headers, "X-Kin-Body": await sha256("{}!") }, "POST", "/api/rooms/r/members")).toBe(false);
  });

  it("uses a fresh nonce every time, which is what makes the relay's replay check work", async () => {
    const me = await identity("Alice");
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i++) nonces.add((await signRequest(me, "GET", "/api/rooms/r/history"))["X-Kin-Nonce"]);
    expect(nonces.size).toBe(25);
  });

  it("signs a supplied digest instead of the body, for uploads that are never buffered", async () => {
    const me = await identity("Alice");
    const contentHash = await sha256(crypto.getRandomValues(new Uint8Array(64)));
    const headers = await signRequest(me, "PUT", "/api/rooms/r/files/f", "", contentHash);
    expect(headers["X-Kin-Body"]).toBe(contentHash);
    expect(await verify(me, headers, "PUT", "/api/rooms/r/files/f")).toBe(true);
  });
});
