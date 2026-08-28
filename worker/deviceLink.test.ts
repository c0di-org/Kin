import { beforeEach, describe, expect, it } from "vitest";
import { DeviceLink } from "./index";
import { FakeStorage, fakeCtx, fakeEnv, makeIdentity, signHeaders, signedRequest, type TestIdentity } from "./testing/harness";

/**
 * The object that carries an identity from one of somebody's screens to another.
 *
 * Everything here is about the one property that makes that safe to do at all: the relay is
 * holding the most valuable payload in Kin and must be unable to do anything with it, unable to
 * hand it to anybody who was not told the secret, and unable to hand it out twice.
 */
let storage: FakeStorage;
let link: any;
let owner: TestIdentity;
let stranger: TestIdentity;

const LINK = "abcdefgh12345678";
const path = (tail = "") => `/api/link/${LINK}${tail}`;

/** Whatever a real client would seal — this object never looks inside it. */
const ticket = (o: TestIdentity, over: Record<string, unknown> = {}) => ({
  proof: "the-hash-of-the-secret", iv: "aaaa", blob: "sealed-identity", owner: o.member(), ...over
});

const claim = (proof: string) => link.fetch(new Request(`https://kin.test${path("/claim")}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof })
}));

beforeEach(async () => {
  storage = new FakeStorage();
  link = new DeviceLink(fakeCtx(storage) as any, fakeEnv());
  [owner, stranger] = await Promise.all([makeIdentity("Ada"), makeIdentity("Mallory")]);
});

describe("minting a device link", () => {
  it("stores a sealed bundle and books its expiry", async () => {
    const res = await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner)));
    expect(res.status).toBe(201);
    const record = await storage.get<any>("record");
    expect(record.blob).toBe("sealed-identity");
    expect(record.owner).toBe(owner.deviceId);
    expect(await storage.getAlarm()).toBe(record.expiresAt);
    // Fifteen minutes, not the invite's thirty days: this one carries the keys themselves.
    expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("refuses an unsigned mint, so the relay is not free storage", async () => {
    const res = await link.fetch(new Request(`https://kin.test${path()}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ticket(owner))
    }));
    expect(res.status).toBe(401);
    expect(await storage.get("record")).toBeUndefined();
  });

  it("refuses a mint signed by somebody other than the card it presents", async () => {
    const body = JSON.stringify(ticket(owner));
    const headers = await signHeaders(stranger, "PUT", path(), body);
    const res = await link.fetch(new Request(`https://kin.test${path()}`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body
    }));
    expect(res.status).toBe(401);
  });

  it("refuses to be overwritten once it exists", async () => {
    await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner)));
    const res = await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner, { blob: "swapped" })));
    expect(res.status).toBe(409);
    expect((await storage.get<any>("record")).blob).toBe("sealed-identity");
  });

  it("refuses a bundle larger than a link is meant to carry", async () => {
    const res = await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner, { blob: "x".repeat(200_000) })));
    expect(res.status).toBe(413);
  });
});

describe("collecting one", () => {
  beforeEach(async () => { await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner))); });

  it("hands the bundle over to whoever presents the proof", async () => {
    const res = await claim("the-hash-of-the-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ iv: "aaaa", blob: "sealed-identity" });
  });

  it("refuses the wrong proof — knowing where it is stored is not knowing how to open it", async () => {
    const res = await claim("guessed");
    expect(res.status).toBe(403);
    expect((await claim("the-hash-of-the-secret")).status).toBe(200);
  });

  it("gives up entirely after five wrong proofs", async () => {
    for (let i = 0; i < 5; i++) expect((await claim(`try-${i}`)).status).toBe(403);
    // Not merely refused — gone, so a guessing run cannot be resumed against the same object.
    expect(await storage.get("record")).toBeUndefined();
    expect((await claim("the-hash-of-the-secret")).status).toBe(404);
  });

  it("is collectable once, with a grace window for a reply that never arrived", async () => {
    expect((await claim("the-hash-of-the-secret")).status).toBe(200);
    // Straight away is the laptop asking again on bad wifi, and that is not a second device.
    expect((await claim("the-hash-of-the-secret")).status).toBe(200);

    const record = await storage.get<any>("record");
    await storage.put("record", { ...record, claimedAt: Date.now() - 5 * 60_000 });
    expect((await claim("the-hash-of-the-secret")).status).toBe(410);
  });

  it("is gone once it has expired, however good the proof", async () => {
    const record = await storage.get<any>("record");
    await storage.put("record", { ...record, expiresAt: Date.now() - 1 });
    expect((await claim("the-hash-of-the-secret")).status).toBe(404);
  });

  it("wipes itself when the alarm goes off", async () => {
    await link.alarm();
    expect(await storage.get("record")).toBeUndefined();
  });
});

describe("looking in on a link you minted", () => {
  beforeEach(async () => { await link.fetch(await signedRequest(owner, "PUT", path(), ticket(owner))); });

  it("says whether it has been collected yet", async () => {
    expect(await (await link.fetch(await signedRequest(owner, "GET", path()))).json())
      .toMatchObject({ claimed: false });
    await claim("the-hash-of-the-secret");
    expect(await (await link.fetch(await signedRequest(owner, "GET", path()))).json())
      .toMatchObject({ claimed: true });
  });

  it("answers only the device that minted it", async () => {
    expect((await link.fetch(await signedRequest(stranger, "GET", path()))).status).toBe(401);
    expect((await link.fetch(await signedRequest(stranger, "DELETE", path()))).status).toBe(401);
    expect(await storage.get("record")).toBeDefined();
  });

  it("can be called off before anybody collects it", async () => {
    expect((await link.fetch(await signedRequest(owner, "DELETE", path()))).status).toBe(200);
    expect(await storage.get("record")).toBeUndefined();
    expect((await claim("the-hash-of-the-secret")).status).toBe(404);
  });
});
