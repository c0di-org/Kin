import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom } from "./index";
import {
  directRoomId, newFixture, roomPath as url, sha256b64, signedRequest, signEnvelope, signHeaders,
  type Fixture
} from "./testing/harness";

let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

describe("signed request authentication", () => {
  it("accepts a correctly signed request from a member", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.alice, "GET", url("/members")));
    expect(res.status).toBe(200);
    expect((await res.json() as unknown[]).length).toBe(2);
  });

  it("rejects a request signed by a non-member", async () => {
    await f.seed();
    expect((await f.room.fetch(await signedRequest(f.mallory, "GET", url("/members")))).status).toBe(401);
  });

  it("rejects a body that does not match the signed X-Kin-Body hash", async () => {
    await f.seed();
    // Sign a harmless body, then swap in a different one. Re-signing only the *claimed* hash
    // leaves every signed POST body unauthenticated, so this must not verify.
    const headers = await signHeaders(f.bob, "POST", url("/members"), JSON.stringify({ hello: "world" }));
    const tampered = JSON.stringify({ ...f.alice.member(), signPublicJwk: f.mallory.signPublicJwk });
    const res = await f.room.fetch(new Request(`https://kin.test${url("/members")}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: tampered
    }));
    expect(res.status).toBe(401);
    expect(await f.storage.get<any>(`member:${f.alice.deviceId}`)).toMatchObject({ signPublicJwk: f.alice.signPublicJwk });
  });

  it("rejects a replayed signed request", async () => {
    await f.seed();
    const req = await signedRequest(f.alice, "GET", url("/members"));
    expect((await f.room.fetch(req.clone())).status).toBe(200);
    expect((await f.room.fetch(req.clone())).status).toBe(401);
  });

  it("rejects a stale timestamp", async () => {
    await f.seed();
    const path = url("/members");
    const headers = await signHeaders(f.alice, "GET", path, "", undefined, Date.now() - 10 * 60_000);
    expect((await f.room.fetch(new Request(`https://kin.test${path}`, { headers }))).status).toBe(401);
  });

  it("expires spent nonces on the sweep so signing stays possible forever", async () => {
    await f.seed();
    expect(f.storage.keys("nonce:").length).toBe(0);
    await f.room.fetch(await signedRequest(f.alice, "GET", url("/members")));
    expect(f.storage.keys("nonce:").length).toBe(1);
    const key = f.storage.keys("nonce:")[0];
    await f.storage.put(key, 1);
    await f.room.alarm();
    expect(f.storage.keys("nonce:").length).toBe(0);
  });
});

describe("member roster authorization", () => {
  it("lets a member update their own display card", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.bob, "POST", url("/members"), { ...f.bob.member(), displayName: "Bobby" }));
    expect(res.status).toBe(200);
    expect(await f.storage.get<any>(`member:${f.bob.deviceId}`)).toMatchObject({ displayName: "Bobby" });
  });

  it("refuses to let one member overwrite another member's signing key", async () => {
    await f.seed();
    const impostor = { ...f.alice.member(), signPublicJwk: f.mallory.signPublicJwk };
    const res = await f.room.fetch(await signedRequest(f.bob, "POST", url("/members"), impostor));
    expect(res.status).toBe(403);
    expect(await f.storage.get<any>(`member:${f.alice.deviceId}`)).toMatchObject({ signPublicJwk: f.alice.signPublicJwk });
  });

  it("refuses to let a member rename someone else, even leaving keys alone", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.bob, "POST", url("/members"), { ...f.alice.member(), displayName: "Not Alice" }));
    expect(res.status).toBe(403);
    expect(await f.storage.get<any>(`member:${f.alice.deviceId}`)).toMatchObject({ displayName: "Alice" });
  });

  it("refuses to let a member rotate their own keys out from under the roster", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.bob, "POST", url("/members"), { ...f.bob.member(), signPublicJwk: f.mallory.signPublicJwk }));
    expect(res.status).toBe(403);
    expect(await f.storage.get<any>(`member:${f.bob.deviceId}`)).toMatchObject({ signPublicJwk: f.bob.signPublicJwk });
  });

  it("still lets a member introduce someone new, which is how pairing works", async () => {
    await f.seed("group", [f.alice]);
    const res = await f.room.fetch(await signedRequest(f.alice, "POST", url("/members"), f.bob.member()));
    expect(res.status).toBe(200);
    expect(await f.storage.get(`member:${f.bob.deviceId}`)).toBeTruthy();
  });
});

describe("room creation", () => {
  const group = (f: Fixture) => ({ kind: "group" as const, title: "Family", members: [f.alice.member(), f.bob.member()] });

  it("rejects an unsigned room creation", async () => {
    const res = await f.room.fetch(new Request(`https://kin.test${url()}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(group(f))
    }));
    expect(res.status).toBe(401);
    expect(await f.storage.get("meta")).toBeUndefined();
  });

  it("accepts a room creation signed by a listed member", async () => {
    expect((await f.room.fetch(await signedRequest(f.alice, "PUT", url(), group(f)))).status).toBe(201);
  });

  it("rejects a room creation signed by someone not in the member list", async () => {
    expect((await f.room.fetch(await signedRequest(f.mallory, "PUT", url(), group(f)))).status).toBe(403);
  });

  it("refuses to let an outsider squat the direct room between two other people", async () => {
    const id = await directRoomId(f.alice.deviceId, f.bob.deviceId);
    const body = { kind: "direct", title: "Alice", members: [f.alice.member(), f.bob.member(), f.mallory.member()] };
    const res = await f.room.fetch(await signedRequest(f.mallory, "PUT", url("", id), body));
    expect(res.status).toBe(403);
    expect(await f.storage.get("meta")).toBeUndefined();
  });

  it("refuses a direct room whose id is not derived from its two members", async () => {
    const body = { kind: "direct", title: "Bob", members: [f.alice.member(), f.bob.member()] };
    expect((await f.room.fetch(await signedRequest(f.alice, "PUT", url("", "not-a-derived-id"), body))).status).toBe(403);
  });

  it("hands an existing room back to a member who re-creates it", async () => {
    const body = group(f);
    await f.room.fetch(await signedRequest(f.alice, "PUT", url(), body));
    const again = await f.room.fetch(await signedRequest(f.bob, "PUT", url(), body));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ title: "Family" });
  });

  it("will not confirm an existing room to someone who is not in it", async () => {
    await f.room.fetch(await signedRequest(f.alice, "PUT", url(), group(f)));
    // Mallory lists herself to get past the signature check, but she is not on the roster.
    const res = await f.room.fetch(await signedRequest(f.mallory, "PUT", url(), {
      kind: "group", title: "Family", members: [f.mallory.member()]
    }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Family");
  });

  it("accepts the direct room its two participants derive", async () => {
    const id = await directRoomId(f.alice.deviceId, f.bob.deviceId);
    const body = { kind: "direct", title: "Bob", members: [f.alice.member(), f.bob.member()] };
    expect((await f.room.fetch(await signedRequest(f.alice, "PUT", url("", id), body))).status).toBe(201);
  });
});

describe("attachment uploads", () => {
  const streamOf = (megabytes: number) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < megabytes; i++) controller.enqueue(new Uint8Array(1024 * 1024));
      controller.close();
    }
  });

  it("caps an upload that arrives without a Content-Length", async () => {
    await f.seed();
    const path = url("/files/bigfile");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64("streamed"));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, { method: "PUT", headers, body: streamOf(30), duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(f.env.ATTACHMENTS.objects.size).toBe(0);
  });

  it("rejects an upload that declares an oversize Content-Length", async () => {
    await f.seed();
    const path = url("/files/declared");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64("whatever"));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, {
      method: "PUT",
      headers: { ...headers, "Content-Length": String(40 * 1024 * 1024) },
      body: streamOf(1), duplex: "half"
    } as RequestInit));
    expect(res.status).toBe(413);
    expect(f.env.ATTACHMENTS.objects.size).toBe(0);
  });

  it("rejects bytes that disagree with the signed digest", async () => {
    await f.seed();
    const path = url("/files/swapped");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64("the file I signed"));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, {
      method: "PUT", headers, body: new TextEncoder().encode("a different file entirely")
    }));
    expect(res.status).toBe(400);
    expect(f.env.ATTACHMENTS.objects.size).toBe(0);
  });

  it("stores an upload whose bytes match the signed digest", async () => {
    await f.seed();
    const path = url("/files/photo1");
    const bytes = new TextEncoder().encode("ciphertext");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64(bytes));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, { method: "PUT", headers, body: bytes }));
    expect(res.status).toBe(201);
    expect(f.env.ATTACHMENTS.objects.size).toBe(1);
  });
});

describe("envelopes", () => {
  it("accepts a properly signed envelope and rejects a forged one", async () => {
    await f.seed();
    const now = Date.now();
    const base = {
      kind: "message", id: crypto.randomUUID(), conversationId: "family-room-1", senderDeviceId: f.alice.deviceId,
      createdAt: now, expiresAt: now + 86_400_000, iv: "aXY", ciphertext: "Y3Q"
    };
    const post = (envelope: unknown) => f.room.fetch(new Request(`https://kin.test${url("/messages")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope)
    }));
    expect((await post(await signEnvelope(f.alice, base))).status).toBe(202);
    expect((await post(await signEnvelope(f.mallory, { ...base, id: crypto.randomUUID() }))).status).toBe(401);
  });
});

describe("removing a member", () => {
  it("evicts the device and its push subscription", async () => {
    await f.seed();
    await f.storage.put(`push:${f.bob.deviceId}`, { endpoint: "https://push.test/1", keys: { p256dh: "p", auth: "a" } });
    const res = await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    expect(res.status).toBe(200);
    expect(await f.storage.get(`member:${f.bob.deviceId}`)).toBeUndefined();
    expect(await f.storage.get(`push:${f.bob.deviceId}`)).toBeUndefined();
  });

  it("stops the removed device reaching the room at all", async () => {
    await f.seed();
    await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    expect((await f.room.fetch(await signedRequest(f.bob, "GET", url("/history")))).status).toBe(401);
    expect((await f.room.fetch(await signedRequest(f.bob, "GET", url("/members")))).status).toBe(401);
  });

  it("lets a member remove themselves, which is how leaving works", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.bob, "DELETE", url(`/members/${f.bob.deviceId}`)));
    expect(res.status).toBe(200);
    expect(await f.storage.get(`member:${f.bob.deviceId}`)).toBeUndefined();
  });

  it("refuses a request from someone who is not in the room", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.mallory, "DELETE", url(`/members/${f.alice.deviceId}`)));
    expect(res.status).toBe(401);
    expect(await f.storage.get(`member:${f.alice.deviceId}`)).toBeDefined();
  });

  it("closes the room when its last member leaves", async () => {
    await f.seed();
    await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    const res = await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.alice.deviceId}`)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closed: true });
    // Refusing instead stranded a group that was made and never shared: nobody could leave it,
    // and there was no other way to be rid of it.
    expect(await f.storage.get("meta")).toBeUndefined();
    expect(f.storage.keys()).toHaveLength(0);
  });

  it("takes a closed room's attachments out of the bucket with it", async () => {
    await f.seed("group", [f.alice]);
    await f.storage.put("kept:f1", { fileId: "f1", key: "rooms/r/f1", expiresAt: 0, bytes: 10 });
    await f.env.ATTACHMENTS.objects.set("rooms/r/f1", new Uint8Array(10));
    await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.alice.deviceId}`)));
    expect(f.env.ATTACHMENTS.objects.has("rooms/r/f1")).toBe(false);
  });

  it("is idempotent for a device that has already gone", async () => {
    await f.seed();
    await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    expect((await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)))).status).toBe(200);
  });
});

describe("renaming a room", () => {
  it("moves the plaintext title a push notification is built from", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.alice, "PATCH", url(""), { title: "Beach Trip" }));
    expect(res.status).toBe(200);
    expect(await f.storage.get("meta")).toMatchObject({ title: "Beach Trip" });
  });

  it("leaves everything else about the room alone", async () => {
    await f.seed();
    await f.storage.put("meta", { ...(await f.storage.get("meta") as object), keep: true, spaceId: "space-1" });
    await f.room.fetch(await signedRequest(f.alice, "PATCH", url(""), { title: "Album" }));
    expect(await f.storage.get("meta")).toMatchObject({ title: "Album", keep: true, spaceId: "space-1" });
  });

  it("refuses a guest, who was let in rather than handed the place", async () => {
    await f.seed();
    await f.storage.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "guest" });
    const res = await f.room.fetch(await signedRequest(f.bob, "PATCH", url(""), { title: "Mine now" }));
    expect(res.status).toBe(403);
    expect(await f.storage.get("meta")).toMatchObject({ title: "Family" });
  });

  it("refuses somebody who is not in the room at all", async () => {
    await f.seed();
    expect((await f.room.fetch(await signedRequest(f.mallory, "PATCH", url(""), { title: "Mine now" }))).status).toBe(401);
  });

  it("refuses an empty name, rather than leaving a room with none", async () => {
    await f.seed();
    expect((await f.room.fetch(await signedRequest(f.alice, "PATCH", url(""), { title: "   " }))).status).toBe(400);
  });
});
