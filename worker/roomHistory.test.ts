import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom } from "./index";
import { newFixture, ROOM, roomPath as url, signedRequest, type Fixture } from "./testing/harness";

let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

async function seedMessages(count: number, expiresAt = Date.now() + 86_400_000) {
  const base = Date.now() - count * 1000;
  for (let i = 0; i < count; i++) {
    const createdAt = base + i * 1000;
    await f.storage.put(`msg:${String(createdAt).padStart(16, "0")}:m${i}`, {
      kind: "message", id: `m${i}`, conversationId: ROOM, senderDeviceId: f.alice.deviceId,
      createdAt, expiresAt, iv: "iv", ciphertext: `c${i}`, signature: "sig"
    });
  }
}

const fetchHistory = async () =>
  await (await f.room.fetch(await signedRequest(f.alice, "GET", url("/history")))).json() as { id: string; createdAt: number }[];

describe("history", () => {
  it("returns everything when the room is under the limit, oldest first", async () => {
    await f.seed();
    await seedMessages(5);
    expect((await fetchHistory()).map(r => r.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("returns the newest messages, not the oldest, once the room is over the limit", async () => {
    await f.seed();
    await seedMessages(450);
    const rows = await fetchHistory();
    expect(rows.length).toBe(400);
    expect(rows[0].id).toBe("m50");
    expect(rows[rows.length - 1].id).toBe("m449");
  });

  it("hands them back in ascending order, because clients ingest oldest first", async () => {
    await f.seed();
    await seedMessages(450);
    const stamps = (await fetchHistory()).map(r => r.createdAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it("drops expired envelopes", async () => {
    await f.seed();
    await seedMessages(3, 1);
    expect(await fetchHistory()).toEqual([]);
  });
});
