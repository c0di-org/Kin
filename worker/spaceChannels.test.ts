import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom } from "./index";
import { newFixture, roomPath as url, signedRequest, signEnvelope, type Fixture } from "./testing/harness";

const SPACE = "the-space";
const CHANNEL = "channel-room-1";

let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

const channelPath = (tail = "") => url(tail, CHANNEL);

function envelope(from: { deviceId: string }, roomId: string, over: Record<string, unknown> = {}) {
  const createdAt = Date.now();
  return {
    kind: "message", id: crypto.randomUUID(), conversationId: roomId,
    senderDeviceId: from.deviceId, createdAt, expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000,
    iv: "aXY", ciphertext: "Y2lwaGVy", ...over
  };
}

describe("creating a channel", () => {
  it("lets a space member open one, recording which space it belongs to", async () => {
    await f.seedRoom(SPACE, [f.alice, f.bob]);
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.alice, "PUT", channelPath(), {
      kind: "group", title: "Japan trip", members: [f.alice.member()], spaceId: SPACE
    }));
    expect(res.status).toBe(201);
    expect((await res.json() as any).spaceId).toBe(SPACE);
  });

  it("refuses somebody who is not in the space they name", async () => {
    await f.seedRoom(SPACE, [f.alice]);
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.mallory, "PUT", channelPath(), {
      kind: "group", title: "Sneaking in", members: [f.mallory.member()], spaceId: SPACE
    }));
    expect(res.status).toBe(403);
  });

  it("refuses a guest of the space, who may read channels but not make them", async () => {
    await f.seedRoom(SPACE, []);
    await f.env.ROOMS.storages.get(SPACE)!.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "guest" });
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.bob, "PUT", channelPath(), {
      kind: "group", title: "Nope", members: [f.bob.member()], spaceId: SPACE
    }));
    expect(res.status).toBe(403);
  });

  it("refuses a space that is itself", async () => {
    const room = f.env.ROOMS.get("ouroboros");
    const res = await room.fetch(await signedRequest(f.alice, "PUT", url("", "ouroboros"), {
      kind: "group", title: "Ouroboros", members: [f.alice.member()], spaceId: "ouroboros"
    }));
    expect(res.status).toBe(403);
  });
});

describe("walking into a channel", () => {
  beforeEach(async () => {
    await f.seedRoom(SPACE, [f.alice, f.bob]);
    await f.seedRoom(CHANNEL, [f.alice], { spaceId: SPACE });
  });

  it("lets a member of the space in without anybody adding them", async () => {
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.bob, "POST", channelPath("/join"), f.bob.member()));
    expect(res.status).toBe(200);
    expect(await f.env.ROOMS.storages.get(CHANNEL)!.get(`member:${f.bob.deviceId}`)).toBeTruthy();
  });

  it("keeps a stranger out", async () => {
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.mallory, "POST", channelPath("/join"), f.mallory.member()));
    expect(res.status).toBe(403);
  });

  it("carries the standing they hold in the space rather than the one they claim", async () => {
    await f.env.ROOMS.storages.get(SPACE)!.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "guest" });
    const channel = f.env.ROOMS.get(CHANNEL);
    await channel.fetch(await signedRequest(f.bob, "POST", channelPath("/join"), { ...f.bob.member(), role: "member" }));
    const stored = await f.env.ROOMS.storages.get(CHANNEL)!.get<any>(`member:${f.bob.deviceId}`);
    expect(stored.role).toBe("guest");
  });

  it("refuses to let anyone walk into a room that is not a channel", async () => {
    await f.seed();
    const res = await f.room.fetch(await signedRequest(f.mallory, "POST", url("/join"), f.mallory.member()));
    expect(res.status).toBe(403);
  });

  it("refuses a join signed by somebody other than the card it carries", async () => {
    const channel = f.env.ROOMS.get(CHANNEL);
    const res = await channel.fetch(await signedRequest(f.alice, "POST", channelPath("/join"), f.bob.member()));
    expect(res.status).toBe(401);
  });
});

describe("the channel directory", () => {
  beforeEach(async () => { await f.seed(); });

  it("stores a name the relay cannot read, and hands it back to members", async () => {
    const record = { id: "japan", blob: "c2VhbGVk", iv: "aXY" };
    expect((await f.room.fetch(await signedRequest(f.alice, "POST", url("/channels"), record))).status).toBe(200);
    const res = await f.room.fetch(await signedRequest(f.bob, "GET", url("/channels")));
    const listed = await res.json() as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0].blob).toBe("c2VhbGVk");
  });

  it("outlives the message stream, which is the whole reason it is not a message", async () => {
    await f.room.fetch(await signedRequest(f.alice, "POST", url("/channels"), { id: "japan", blob: "c2VhbGVk", iv: "aXY" }));
    // Everything the room would ever expire, expired.
    for (const key of f.storage.keys("msg:")) await f.storage.delete(key);
    await f.room.alarm();
    const res = await f.room.fetch(await signedRequest(f.bob, "GET", url("/channels")));
    expect(await res.json() as any[]).toHaveLength(1);
  });

  it("keeps a stranger out", async () => {
    const res = await f.room.fetch(await signedRequest(f.mallory, "GET", url("/channels")));
    expect(res.status).toBe(401);
  });

  it("refuses a guest trying to rearrange the space", async () => {
    await f.storage.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "guest" });
    const res = await f.room.fetch(await signedRequest(f.bob, "POST", url("/channels"), { id: "x", blob: "b", iv: "i" }));
    expect(res.status).toBe(403);
  });

  it("removes one on request", async () => {
    await f.room.fetch(await signedRequest(f.alice, "POST", url("/channels"), { id: "japan", blob: "b", iv: "i" }));
    await f.room.fetch(await signedRequest(f.alice, "DELETE", url("/channels/japan")));
    const res = await f.room.fetch(await signedRequest(f.alice, "GET", url("/channels")));
    expect(await res.json() as any[]).toHaveLength(0);
  });
});

describe("what a viewer may do", () => {
  beforeEach(async () => {
    await f.seed();
    await f.storage.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "viewer" });
  });

  it("refuses their messages at the relay, not only in the composer", async () => {
    const env = await signEnvelope(f.bob, envelope(f.bob, "family-room-1"));
    const res = await f.room.fetch(new Request(`https://kin.test${url("/messages")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env)
    }));
    expect(res.status).toBe(401);
    expect(f.storage.keys("msg:")).toEqual([]);
  });

  it("still lets them read what they were invited to see", async () => {
    const res = await f.room.fetch(await signedRequest(f.bob, "GET", url("/history")));
    expect(res.status).toBe(200);
  });

  it("does not stop a full member posting", async () => {
    const env = await signEnvelope(f.alice, envelope(f.alice, "family-room-1"));
    const res = await f.room.fetch(new Request(`https://kin.test${url("/messages")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env)
    }));
    expect(res.status).toBe(202);
  });
});

describe("a room that keeps things", () => {
  beforeEach(async () => {
    await f.storage.put("meta", { id: "family-room-1", kind: "group", title: "Japan photos", createdAt: Date.now(), keep: true });
    for (const m of [f.alice, f.bob]) await f.storage.put(`member:${m.deviceId}`, m.member());
  });

  async function post(over: Record<string, unknown> = {}): Promise<Response> {
    const env = await signEnvelope(f.alice, envelope(f.alice, "family-room-1", over));
    return f.room.fetch(new Request(`https://kin.test${url("/messages")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env)
    }));
  }

  it("books no sweep at all, rather than one far in the future", async () => {
    expect((await post()).status).toBe(202);
    expect(await f.storage.getAlarm()).toBeNull();
  });

  it("still shows a message whose own week has run out", async () => {
    await post({ expiresAt: Date.now() - 1 });
    const res = await f.room.fetch(await signedRequest(f.bob, "GET", url("/history")));
    expect(await res.json() as any[]).toHaveLength(1);
  });

  it("holds attachments outside the sweep, so the album survives the week", async () => {
    const bytes = new TextEncoder().encode("photo");
    const { sha256b64, signHeaders } = await import("./testing/harness");
    const path = url("/files/photo1");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64(bytes));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, {
      method: "PUT", headers: { ...headers, "Content-Length": String(bytes.byteLength) }, body: bytes
    }));
    expect(res.status).toBe(201);
    expect(f.storage.keys("file:")).toEqual([]);
    expect(f.storage.keys("kept:")).toHaveLength(1);

    await f.room.alarm();
    expect(f.env.ATTACHMENTS.objects.size).toBe(1);
  });

  it("refuses an upload once the album is full", async () => {
    await f.storage.put("keptBytes", 2 * 1024 * 1024 * 1024);
    const bytes = new TextEncoder().encode("photo");
    const { sha256b64, signHeaders } = await import("./testing/harness");
    const path = url("/files/photo2");
    const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64(bytes));
    const res = await f.room.fetch(new Request(`https://kin.test${path}`, {
      method: "PUT", headers: { ...headers, "Content-Length": String(bytes.byteLength) }, body: bytes
    }));
    expect(res.status).toBe(507);
  });
});
