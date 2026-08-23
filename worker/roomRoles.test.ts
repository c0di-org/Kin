import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom } from "./index";
import {
  fakeCtx, fakeSocket, newFixture, roomPath as url, sha256b64, signedRequest, signEnvelope, signHeaders,
  type Fixture, type TestIdentity
} from "./testing/harness";

let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

/** Alice and Bob are family; whoever is passed here arrived on a link with that standing. */
async function withRole(who: TestIdentity, role: "guest" | "viewer"): Promise<void> {
  await f.seed("group", [f.alice, f.bob]);
  await f.storage.put(`member:${who.deviceId}`, { ...who.member(), role });
}

const envelope = (from: TestIdentity, id: string, ciphertext = "cipher") => signEnvelope(from, {
  kind: "message", id, conversationId: "family-room-1", senderDeviceId: from.deviceId,
  createdAt: Date.now(), expiresAt: Date.now() + 60_000, iv: "aaaa", ciphertext
});

const post = (room: any, env: unknown) => room.fetch(new Request(`https://kin.test${url("/messages")}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env)
}));

async function upload(who: TestIdentity, fileId: string, size = 1024, room: any = f.room): Promise<Response> {
  const bytes = new Uint8Array(size).fill(7);
  const path = url(`/files/${fileId}`);
  const headers = await signHeaders(who, "PUT", path, "", await sha256b64(bytes));
  return room.fetch(new Request(`https://kin.test${path}`, {
    method: "PUT", headers: { ...headers, "Content-Length": String(size) }, body: bytes
  }));
}

describe("what a link guest or viewer may not do", () => {
  it("refuses a guest evicting somebody else", async () => {
    await withRole(f.mallory, "guest");
    const res = await f.room.fetch(await signedRequest(f.mallory, "DELETE", url(`/members/${f.alice.deviceId}`)));
    expect(res.status).toBe(403);
    expect(await f.storage.get(`member:${f.alice.deviceId}`)).toBeDefined();
  });

  it("refuses a viewer evicting somebody else", async () => {
    await withRole(f.mallory, "viewer");
    expect((await f.room.fetch(await signedRequest(f.mallory, "DELETE", url(`/members/${f.alice.deviceId}`)))).status).toBe(403);
  });

  it("still lets a guest leave, because being let out is nobody's to withhold", async () => {
    await withRole(f.mallory, "guest");
    const res = await f.room.fetch(await signedRequest(f.mallory, "DELETE", url(`/members/${f.mallory.deviceId}`)));
    expect(res.status).toBe(200);
    expect(await f.storage.get(`member:${f.mallory.deviceId}`)).toBeUndefined();
  });

  it("refuses a guest enrolling a device, which is minting an invite by another route", async () => {
    await withRole(f.mallory, "guest");
    const outsider = (await newFixture(ConversationRoom)).mallory;
    const res = await f.room.fetch(await signedRequest(f.mallory, "POST", url("/members"), outsider.member()));
    expect(res.status).toBe(403);
    expect(await f.storage.get(`member:${outsider.deviceId}`)).toBeUndefined();
    // and so the device it was trying to let in still cannot read the room
    expect((await f.room.fetch(await signedRequest(outsider, "GET", url("/history")))).status).toBe(401);
  });

  it("lets a full member enrol one, which is what pairing is", async () => {
    await f.seed();
    const joiner = (await newFixture(ConversationRoom)).mallory;
    expect((await f.room.fetch(await signedRequest(f.alice, "POST", url("/members"), joiner.member()))).status).toBe(200);
    expect(await f.storage.get(`member:${joiner.deviceId}`)).toBeDefined();
  });

  it("never lets a new card name its own standing", async () => {
    await f.seed();
    const joiner = (await newFixture(ConversationRoom)).mallory;
    await f.room.fetch(await signedRequest(f.alice, "POST", url("/members"), { ...joiner.member(), role: "viewer" }));
    expect(await f.storage.get<any>(`member:${joiner.deviceId}`)).not.toHaveProperty("role");
  });

  it("refuses a viewer's upload, so read-only cannot cost an album its space", async () => {
    await withRole(f.mallory, "viewer");
    expect((await upload(f.mallory, "f1")).status).toBe(403);
  });

  it("allows a guest's upload, because a guest may post and a photo is a post", async () => {
    await withRole(f.mallory, "guest");
    expect((await upload(f.mallory, "f1")).status).toBe(201);
  });

  it("still refuses a viewer's envelope", async () => {
    await withRole(f.mallory, "viewer");
    expect((await post(f.room, await envelope(f.mallory, "m1"))).status).toBe(401);
  });

  it("trims a founding member card instead of storing whatever the creator wrote", async () => {
    const long = "x".repeat(400);
    const res = await f.room.fetch(await signedRequest(f.alice, "PUT", url(""), {
      kind: "group", title: "Family", members: [{ ...f.alice.member(), displayName: long, role: "viewer" }]
    }));
    expect(res.status).toBe(201);
    const stored = await f.storage.get<any>(`member:${f.alice.deviceId}`);
    expect(stored.displayName).toHaveLength(64);
    expect(stored).not.toHaveProperty("role");
  });
});

describe("a timestamp that is not a number", () => {
  /** Sign the canonical the relay will rebuild, whatever nonsense is in the time header. */
  async function signedWithTime(who: TestIdentity, method: string, path: string, time: string) {
    const bodyHash = await sha256b64("");
    const headers = await signHeaders(who, method, path, "", bodyHash);
    const canonical = [method, path, time, headers["X-Kin-Nonce"], bodyHash].join("\n");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, who.signPrivate, new TextEncoder().encode(canonical));
    let raw = ""; for (const b of new Uint8Array(sig)) raw += String.fromCharCode(b);
    return new Request(`https://kin.test${path}`, {
      method,
      headers: { ...headers, "X-Kin-Time": time, "X-Kin-Signature": btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") }
    });
  }

  it("is refused, rather than sliding past a skew check NaN always loses", async () => {
    await f.seed();
    // Math.abs(Date.now() - NaN) > MAX_SKEW is false, so an unparsed compare waves this through.
    expect(Math.abs(Date.now() - Number("not-a-time")) > 5 * 60_000).toBe(false);
    const res = await f.room.fetch(await signedWithTime(f.alice, "GET", url("/members"), "not-a-time"));
    expect(res.status).toBe(401);
    expect(f.storage.keys("nonce:")).toHaveLength(0);
  });

  it("leaves retention still able to schedule itself", async () => {
    await f.seed();
    await f.room.fetch(await signedWithTime(f.alice, "GET", url("/members"), "not-a-time"));
    await post(f.room, await envelope(f.alice, "m1"));
    // A NaN nonce expiry used to make `next` NaN, so the handler stopped rescheduling and the
    // room's messages never expired again.
    f.storage.fireAlarm();
    await f.room.alarm();
    expect(await f.storage.getAlarm()).toEqual(expect.any(Number));
    expect(await f.storage.getAlarm()).not.toBeNaN();
  });
});

describe("eviction cuts the socket, not only the roster row", () => {
  it("stops delivering to a device that has been removed", async () => {
    await f.seed();
    const pool: unknown[] = [];
    const bob = fakeSocket(f.bob.deviceId, pool);
    const alice = fakeSocket(f.alice.deviceId, pool);
    const room = new ConversationRoom(fakeCtx(f.storage, pool) as any, f.env);

    await room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    expect(bob.closed).toBe(true);

    bob.sent.length = 0;
    await post(room, await envelope(f.alice, "after", "not-for-bob"));
    // The roster row went, but the hibernating socket used to outlive it and keep delivering —
    // which is exactly the lost phone the eviction was for.
    expect(bob.sent.join("")).not.toContain("not-for-bob");
    expect(alice.closed).toBe(false);
  });
});

describe("deleting from the relay, so a kept room can be emptied", () => {
  it("lets the sender take an envelope back and gives the count back", async () => {
    await f.seed();
    await f.storage.put("meta", { id: "family-room-1", kind: "group", title: "Album", createdAt: Date.now(), keep: true });
    await post(f.room, await envelope(f.alice, "m1"));
    expect(await f.storage.get("keptMessages")).toBe(1);

    const res = await f.room.fetch(await signedRequest(f.alice, "DELETE", url("/messages/m1")));
    expect(res.status).toBe(200);
    expect(f.storage.keys("msg:")).toHaveLength(0);
    expect(f.storage.keys("msgkey:")).toHaveLength(0);
    expect(await f.storage.get("keptMessages")).toBe(0);
  });

  it("refuses a delete naming somebody else's message", async () => {
    await f.seed();
    await post(f.room, await envelope(f.alice, "m1"));
    expect((await f.room.fetch(await signedRequest(f.bob, "DELETE", url("/messages/m1")))).status).toBe(403);
    expect(f.storage.keys("msg:")).toHaveLength(1);
  });

  it("gives an album its bytes back when a file goes", async () => {
    await f.seed();
    await f.storage.put("meta", { id: "family-room-1", kind: "group", title: "Album", createdAt: Date.now(), keep: true });
    expect((await upload(f.alice, "f1", 2048)).status).toBe(201);
    expect(await f.storage.get("keptBytes")).toBe(2048);

    const res = await f.room.fetch(await signedRequest(f.alice, "DELETE", url("/files/f1")));
    expect(res.status).toBe(200);
    // The counter only ever climbed before, so an album that filled up once stayed full for good.
    expect(await f.storage.get("keptBytes")).toBe(0);
    expect(f.env.ATTACHMENTS.objects.has("rooms/family-room-1/f1")).toBe(false);
    expect(f.storage.keys("filekey:")).toHaveLength(0);
  });

  it("lets a guest delete only what they uploaded", async () => {
    await withRole(f.mallory, "guest");
    await upload(f.alice, "hers");
    await upload(f.mallory, "his");
    expect((await f.room.fetch(await signedRequest(f.mallory, "DELETE", url("/files/hers")))).status).toBe(403);
    expect((await f.room.fetch(await signedRequest(f.mallory, "DELETE", url("/files/his")))).status).toBe(200);
  });
});
