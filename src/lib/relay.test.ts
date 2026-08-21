import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRoomMember, createRoom, downloadEncryptedFile, history, roomMembers, uploadEncryptedFile, websocketUrl } from "./relay";
import { generateIdentity, publicMember, sha256, unb64 } from "./crypto";
import type { LocalIdentity } from "./types";

const enc = new TextEncoder();

/** Re-derive the canonical string the relay reconstructs, and check the signature over it. */
async function verifySignature(id: LocalIdentity, headers: Headers, method: string, path: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", id.signPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const canonical = [method, path, headers.get("X-Kin-Time"), headers.get("X-Kin-Nonce"), headers.get("X-Kin-Body")].join("\n");
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(headers.get("X-Kin-Signature")!), enc.encode(canonical));
}

let calls: { url: string; init: RequestInit; headers: Headers }[];
let me: LocalIdentity;

beforeEach(async () => {
  me = await generateIdentity("Alice");
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, headers: new Headers(init.headers as HeadersInit) });
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("signed relay requests", () => {
  it("signs room creation, which the relay now requires", async () => {
    const peer = publicMember(await generateIdentity("Bob"));
    await createRoom(me, "room-1", "group", "The Hollands", [publicMember(me), peer]);
    const [call] = calls;
    expect(call.url).toBe("/api/rooms/room-1");
    expect(call.init.method).toBe("PUT");
    expect(await verifySignature(me, call.headers, "PUT", "/api/rooms/room-1")).toBe(true);
  });

  it("commits to a hash of the exact body it sends", async () => {
    const peer = publicMember(await generateIdentity("Bob"));
    await addRoomMember(me, "room-1", peer);
    const [call] = calls;
    expect(call.headers.get("X-Kin-Body")).toBe(await sha256(call.init.body as string));
    expect(JSON.parse(call.init.body as string)).toMatchObject({ deviceId: peer.deviceId });
  });

  it("sends no body on a GET, and signs the hash of the empty string", async () => {
    await history(me, "room-1");
    const [call] = calls;
    expect(call.init.body).toBeUndefined();
    expect(call.headers.get("X-Kin-Body")).toBe(await sha256(""));
    expect(await verifySignature(me, call.headers, "GET", "/api/rooms/room-1/history")).toBe(true);
  });

  it("percent-encodes a room id into the path it signs", async () => {
    await roomMembers(me, "room/../other");
    const [call] = calls;
    const path = "/api/rooms/room%2F..%2Fother/members";
    expect(call.url).toBe(path);
    expect(await verifySignature(me, call.headers, "GET", path)).toBe(true);
  });

  it("signs an upload against the ciphertext digest rather than the request body", async () => {
    const ciphertext = crypto.getRandomValues(new Uint8Array(128));
    const digest = await sha256(ciphertext);
    await uploadEncryptedFile(me, "room-1", "file-1", ciphertext, digest);
    const [call] = calls;
    expect(call.init.method).toBe("PUT");
    expect(call.init.body).toBe(ciphertext);
    expect(call.headers.get("X-Kin-Body")).toBe(digest);
    expect(await verifySignature(me, call.headers, "PUT", "/api/rooms/room-1/files/file-1")).toBe(true);
  });

  it("signs a download with no body at all", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init, headers: new Headers(init.headers as HeadersInit) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    await downloadEncryptedFile(me, "room-1", "file-1");
    const [call] = calls;
    expect(call.headers.get("X-Kin-Body")).toBe(await sha256(""));
    expect(await verifySignature(me, call.headers, "GET", "/api/rooms/room-1/files/file-1")).toBe(true);
  });

  it("throws the relay's message rather than swallowing a rejection", async () => {
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    await expect(history(me, "room-1")).rejects.toThrow("Unauthorized");
  });
});

describe("websocketUrl", () => {
  beforeEach(() => vi.stubGlobal("location", { origin: "https://kin.example" }));

  it("carries the signature in the query, over the same canonical string", async () => {
    const url = new URL(await websocketUrl(me, "room-1"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/rooms/room-1/ws");
    expect(url.searchParams.get("device")).toBe(me.deviceId);
    expect(url.searchParams.get("body")).toBe(await sha256(""));

    const headers = new Headers({
      "X-Kin-Time": url.searchParams.get("time")!,
      "X-Kin-Nonce": url.searchParams.get("nonce")!,
      "X-Kin-Body": url.searchParams.get("body")!,
      "X-Kin-Signature": url.searchParams.get("sig")!
    });
    expect(await verifySignature(me, headers, "GET", "/api/rooms/room-1/ws")).toBe(true);
  });

  it("gives every connection a fresh nonce, so a reconnect is not a replay", async () => {
    const first = new URL(await websocketUrl(me, "room-1"));
    const second = new URL(await websocketUrl(me, "room-1"));
    expect(first.searchParams.get("nonce")).not.toBe(second.searchParams.get("nonce"));
  });
});
