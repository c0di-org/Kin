import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom } from "./index";
import { newFixture, roomPath as url, sha256b64, signHeaders, type Fixture } from "./testing/harness";

const WEEK = 7 * 24 * 60 * 60 * 1000;

let f: Fixture;
beforeEach(async () => { f = await newFixture(ConversationRoom); });

async function upload(fileId: string, text = "ciphertext"): Promise<Response> {
  const path = url(`/files/${fileId}`);
  const bytes = new TextEncoder().encode(text);
  const headers = await signHeaders(f.alice, "PUT", path, "", await sha256b64(bytes));
  return f.room.fetch(new Request(`https://kin.test${path}`, {
    method: "PUT", headers: { ...headers, "Content-Length": String(bytes.byteLength) }, body: bytes
  }));
}

/** Wind every recorded retention deadline into the past, as if a week had gone by. */
async function ageOutAttachments() {
  for (const key of f.storage.keys("file:")) {
    const record = await f.storage.get<any>(key);
    await f.storage.delete(key);
    await f.storage.put(`file:${String(1).padStart(16, "0")}:${record.fileId}`, { ...record, expiresAt: 1 });
  }
}

describe("attachment retention", () => {
  it("records a seven-day deadline for every upload", async () => {
    await f.seed();
    expect((await upload("photo1")).status).toBe(201);
    const records = f.storage.keys("file:");
    expect(records.length).toBe(1);
    const record = await f.storage.get<any>(records[0]);
    expect(record.key).toBe(`rooms/family-room-1/photo1`);
    expect(record.expiresAt).toBeGreaterThan(Date.now() + WEEK - 60_000);
    expect(record.expiresAt).toBeLessThanOrEqual(Date.now() + WEEK);
  });

  it("deletes expired attachments from the bucket on the sweep", async () => {
    await f.seed();
    await upload("photo1");
    await upload("photo2");
    expect(f.env.ATTACHMENTS.objects.size).toBe(2);

    await ageOutAttachments();
    await f.room.alarm();

    expect(f.env.ATTACHMENTS.objects.size).toBe(0);
    expect(f.storage.keys("file:")).toEqual([]);
  });

  it("leaves attachments that have not expired yet", async () => {
    await f.seed();
    await upload("photo1");
    await f.room.alarm();
    expect(f.env.ATTACHMENTS.objects.size).toBe(1);
    expect(f.storage.keys("file:").length).toBe(1);
  });

  it("keeps the records when the bucket delete fails, so the next sweep retries", async () => {
    await f.seed();
    await upload("photo1");
    await ageOutAttachments();
    f.env.ATTACHMENTS.delete = async () => { throw new Error("R2 unavailable"); };

    await f.room.alarm();
    expect(f.storage.keys("file:").length).toBe(1);
    expect(f.env.ATTACHMENTS.objects.size).toBe(1);
  });

  it("schedules the sweep even when a room holds only attachments", async () => {
    await f.seed();
    expect(await f.storage.getAlarm()).toBeNull();
    await upload("photo1");
    expect(await f.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});
