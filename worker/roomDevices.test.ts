import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRoom } from "./index";
import {
  fakeCtx, fakeSocket, newFixture, roomPath as url, signedRequest, signEnvelope,
  type Fixture, type TestIdentity
} from "./testing/harness";
import * as webpush from "./webpush";

/**
 * One identity, two screens.
 *
 * A linked device is the same member on another browser: same keys, same roster row, same device
 * id. Everything the room does that used to say "device" and mean "screen" has to be revisited
 * here, because those two words stopped being the same word.
 */
let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

const envelope = (from: TestIdentity, id: string, ciphertext = "cipher") => signEnvelope(from, {
  kind: "message", id, conversationId: "family-room-1", senderDeviceId: from.deviceId,
  createdAt: Date.now(), expiresAt: Date.now() + 60_000, iv: "aaaa", ciphertext
});

const post = (room: any, env: unknown, session?: string) => room.fetch(new Request(`https://kin.test${url("/messages")}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(session ? { "X-Kin-Session": session } : {}) },
  body: JSON.stringify(env)
}));

const subscription = (n: number) => ({ endpoint: `https://push.test/${n}`, keys: { p256dh: "p", auth: "a" } });

describe("a message reaches the sender's other screens", () => {
  it("skips the socket that sent it, and nothing else", async () => {
    await f.seed();
    const pool: unknown[] = [];
    const phone = fakeSocket(f.alice.deviceId, pool, "phone");
    const laptop = fakeSocket(f.alice.deviceId, pool, "laptop");
    const bob = fakeSocket(f.bob.deviceId, pool);
    const room = new ConversationRoom(fakeCtx(f.storage, pool) as any, f.env);

    await post(room, await envelope(f.alice, "m1", "hello-from-the-phone"), "phone");

    expect(phone.sent.join("")).not.toContain("hello-from-the-phone");
    // The laptop is the same person and already on the roster, so the old device-wide skip cut it
    // out of every message its owner sent — the one case linking exists to make work.
    expect(laptop.sent.join("")).toContain("hello-from-the-phone");
    expect(bob.sent.join("")).toContain("hello-from-the-phone");
  });

  it("falls back to skipping the whole device when no session is named", async () => {
    await f.seed();
    const pool: unknown[] = [];
    const phone = fakeSocket(f.alice.deviceId, pool, "phone");
    const bob = fakeSocket(f.bob.deviceId, pool);
    const room = new ConversationRoom(fakeCtx(f.storage, pool) as any, f.env);

    await post(room, await envelope(f.alice, "m2", "from-an-older-client"));
    expect(phone.sent.join("")).not.toContain("from-an-older-client");
    expect(bob.sent.join("")).toContain("from-an-older-client");
  });

  it("still keeps typing to itself: those are named by device on purpose", async () => {
    await f.seed();
    const pool: unknown[] = [];
    const phone = fakeSocket(f.alice.deviceId, pool, "phone");
    const laptop = fakeSocket(f.alice.deviceId, pool, "laptop");
    const bob = fakeSocket(f.bob.deviceId, pool);
    const room = new ConversationRoom(fakeCtx(f.storage, pool) as any, f.env);

    await room.webSocketMessage(phone as any, JSON.stringify({ kind: "typing", active: true }));
    expect(bob.sent.join("")).toContain("typing");
    // You are not typing at yourself, on either of your screens.
    expect(phone.sent).toHaveLength(0);
    expect(laptop.sent).toHaveLength(0);
  });
});

describe("notifications when one identity has two browsers", () => {
  it("keeps a row per endpoint instead of one per device", async () => {
    await f.seed();
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(1)));
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(2)));
    // One key each. Before this, the laptop registering quietly turned the phone's pushes off.
    expect(f.storage.keys(`push:${f.bob.deviceId}`)).toHaveLength(2);
  });

  it("retires the unslotted row a device wrote before it could have two", async () => {
    await f.seed();
    await f.storage.put(`push:${f.bob.deviceId}`, subscription(0));
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(1)));
    expect(await f.storage.get(`push:${f.bob.deviceId}`)).toBeUndefined();
    expect(f.storage.keys(`push:${f.bob.deviceId}:`)).toHaveLength(1);
  });

  it("lets the oldest endpoint go rather than accumulating dead ones", async () => {
    await f.seed();
    for (let i = 0; i < 10; i++) {
      await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(i)));
    }
    expect(f.storage.keys(`push:${f.bob.deviceId}:`)).toHaveLength(8);
  });

  it("pushes to everyone but the sender — including the sender's other screen", async () => {
    await f.seed();
    const sent = vi.spyOn(webpush, "sendPushNotification").mockResolvedValue({ status: 201, ok: true } as any);
    f.env.VAPID_PUBLIC_KEY = "pub"; f.env.VAPID_PRIVATE_KEY = "priv";
    await f.room.fetch(await signedRequest(f.alice, "POST", url("/push"), subscription(1)));
    await f.room.fetch(await signedRequest(f.alice, "POST", url("/push"), subscription(2)));
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(3)));

    await post(f.room, await envelope(f.alice, "m3"));
    await new Promise(r => setTimeout(r, 0));

    // Alice sent it: neither her phone nor her laptop wants to be told about it.
    const endpoints = sent.mock.calls.map(c => (c[0] as any).endpoint);
    expect(endpoints).toEqual(["https://push.test/3"]);
    sent.mockRestore();
  });

  it("takes every endpoint of an evicted device, not just the first", async () => {
    await f.seed();
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(1)));
    await f.room.fetch(await signedRequest(f.bob, "POST", url("/push"), subscription(2)));
    await f.storage.put(`push:${f.bob.deviceId}`, subscription(0));

    await f.room.fetch(await signedRequest(f.alice, "DELETE", url(`/members/${f.bob.deviceId}`)));
    // A lost phone that kept receiving notifications is precisely what an eviction is for.
    expect(f.storage.keys(`push:${f.bob.deviceId}`)).toHaveLength(0);
  });
});

describe("the room a person's own screens keep", () => {
  it("takes one member, kept, and lets that member post and read it back", async () => {
    // The sync room is an ordinary room with a single member: nothing about it is special to the
    // relay, which is the point — it holds ciphertext about a membership it already knew.
    const self = "self-room-abc";
    const create = await signedRequest(f.alice, "PUT", url("", self), {
      kind: "group", title: "Kin", members: [f.alice.member()], keep: true
    });
    const room = f.env.ROOMS.get(self);
    expect((await room.fetch(create)).status).toBe(201);

    const snapshot = await signEnvelope(f.alice, {
      kind: "message", id: "s1", conversationId: self, senderDeviceId: f.alice.deviceId,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, iv: "aaaa", ciphertext: "sealed-room-list"
    });
    await room.fetch(new Request(`https://kin.test${url("/messages", self)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot)
    }));

    const history = await (await room.fetch(await signedRequest(f.alice, "GET", url("/history", self)))).json() as any[];
    expect(history).toHaveLength(1);
    expect(history[0].ciphertext).toBe("sealed-room-list");
    // Kept, so a laptop opened once a fortnight still finds a picture waiting for it: the
    // retention sweep runs — nonces expire in every room — and takes nothing of the snapshot.
    const store = f.env.ROOMS.storages.get(self)!;
    store.fireAlarm();
    await room.alarm();
    expect(store.keys("msg:")).toHaveLength(1);
  });

  it("refuses to tell anybody else it exists", async () => {
    const self = "self-room-abc";
    await f.env.ROOMS.get(self).fetch(await signedRequest(f.alice, "PUT", url("", self), {
      kind: "group", title: "Kin", members: [f.alice.member()], keep: true
    }));
    const res = await f.env.ROOMS.get(self).fetch(await signedRequest(f.mallory, "GET", url("/history", self)));
    expect(res.status).toBe(401);
  });
});
