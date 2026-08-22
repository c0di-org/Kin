import { beforeEach, describe, expect, it } from "vitest";
import { ConversationRoom, InviteTicket } from "./index";
import { FakeStorage, fakeCtx, newFixture, signedRequest, type Fixture, type TestIdentity } from "./testing/harness";

const CODE = "invite-code-abcdefgh";
const PROOF = "proof-of-the-secret";
const HOUR = 60 * 60 * 1000;

let f: Fixture;
let invite: any;
let inviteStorage: FakeStorage;

beforeEach(async () => {
  f = await newFixture(ConversationRoom);
  await f.seed();
  inviteStorage = new FakeStorage();
  invite = new InviteTicket(fakeCtx(inviteStorage), f.env);
});

const path = (tail = "") => `/api/invite/${CODE}${tail}`;

function ticket(inviter: TestIdentity, over: Record<string, unknown> = {}) {
  return {
    proof: PROOF,
    room: { id: "family-room-1", kind: "group", title: "Family" },
    inviter: inviter.member(),
    role: "guest",
    wrappedKey: "sealed-room-key",
    iv: "twelve-bytes",
    expiresAt: Date.now() + HOUR,
    maxUses: 1,
    ...over
  };
}

async function create(inviter: TestIdentity, over: Record<string, unknown> = {}): Promise<Response> {
  return invite.fetch(await signedRequest(inviter, "PUT", path(), ticket(inviter, over)));
}

async function redeem(joiner: TestIdentity, proof = PROOF): Promise<Response> {
  return invite.fetch(await signedRequest(joiner, "POST", path("/redeem"), { proof, member: joiner.member() }));
}

describe("minting an invite", () => {
  it("takes a room member's link and stores a key it cannot open", async () => {
    expect((await create(f.alice)).status).toBe(201);
    const record = await inviteStorage.get<any>("record");
    expect(record.wrappedKey).toBe("sealed-room-key");
    expect(record.uses).toBe(0);
  });

  it("refuses somebody who is not in the room they are inviting to", async () => {
    const res = await create(f.mallory);
    expect(res.status).toBe(403);
  });

  it("refuses a guest, so a link cannot quietly reproduce itself", async () => {
    await f.storage.put(`member:${f.bob.deviceId}`, { ...f.bob.member(), role: "guest" });
    expect((await create(f.bob)).status).toBe(403);
  });

  it("refuses an unsigned ticket", async () => {
    const res = await invite.fetch(new Request(`https://kin.test${path()}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ticket(f.alice))
    }));
    expect(res.status).toBe(401);
  });

  it("caps how far out an invite may be dated", async () => {
    await create(f.alice, { expiresAt: Date.now() + 365 * 24 * HOUR });
    const record = await inviteStorage.get<any>("record");
    expect(record.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 24 * HOUR);
  });

  it("tells the room about the link, so its members can find it later", async () => {
    await create(f.alice);
    const noted = await f.storage.get<any>(`invite:${CODE}`);
    expect(noted.role).toBe("guest");
  });
});

describe("redeeming an invite", () => {
  it("puts the holder of the secret into the room as a guest", async () => {
    await create(f.alice);
    expect((await redeem(f.mallory)).status).toBe(200);
    const member = await f.storage.get<any>(`member:${f.mallory.deviceId}`);
    expect(member.role).toBe("guest");
  });

  it("refuses somebody who has the code but not the secret behind it", async () => {
    await create(f.alice);
    const res = await redeem(f.mallory, "guessed-proof");
    expect(res.status).toBe(403);
    expect(await f.storage.get(`member:${f.mallory.deviceId}`)).toBeUndefined();
  });

  it("spends a one-use invite once, and refuses the next person", async () => {
    await create(f.alice);
    expect((await redeem(f.mallory)).status).toBe(200);
    const carol = await (await import("./testing/harness")).makeIdentity("Carol");
    expect((await redeem(carol)).status).toBe(410);
  });

  it("does not spend a use when the same device opens the link twice", async () => {
    await create(f.alice);
    await redeem(f.mallory);
    expect((await redeem(f.mallory)).status).toBe(200);
    const record = await inviteStorage.get<any>("record");
    expect(record.uses).toBe(1);
  });

  it("refuses once the invite has expired", async () => {
    await create(f.alice);
    const record = await inviteStorage.get<any>("record");
    await inviteStorage.put("record", { ...record, expiresAt: Date.now() - 1 });
    expect((await redeem(f.mallory)).status).toBe(410);
  });

  it("refuses once the invite has been revoked", async () => {
    await create(f.alice, { maxUses: null });
    await invite.fetch(await signedRequest(f.bob, "POST", path("/revoke"), { member: f.bob.member() }));
    expect((await redeem(f.mallory)).status).toBe(410);
  });

  it("will not let a redeemer swap the keys of somebody already in the room", async () => {
    await create(f.alice, { maxUses: null });
    const impostor = { ...f.bob.member(), signPublicJwk: f.mallory.signPublicJwk, dhPublicJwk: f.mallory.dhPublicJwk };
    // Signed by Mallory's key while claiming Bob's device id — which is exactly what the room's
    // key-immutability rule exists to catch, reached here through the one door that skips the roster.
    const res = await invite.fetch(await signedRequest(
      { ...f.mallory, deviceId: f.bob.deviceId } as TestIdentity,
      "POST", path("/redeem"), { proof: PROOF, member: impostor }
    ));
    expect(res.status).toBe(409);
    const bob = await f.storage.get<any>(`member:${f.bob.deviceId}`);
    expect(bob.signPublicJwk).toEqual(f.bob.signPublicJwk);
  });

  it("leaves a full member's standing alone when they open a guest link", async () => {
    await create(f.alice, { maxUses: null });
    expect((await redeem(f.bob)).status).toBe(200);
    const bob = await f.storage.get<any>(`member:${f.bob.deviceId}`);
    expect(bob.role).toBeUndefined();
  });
});

describe("previewing an invite", () => {
  it("shows what the link opens onto without handing over the proof", async () => {
    await create(f.alice);
    const res = await invite.fetch(new Request(`https://kin.test${path()}`));
    expect(res.status).toBe(200);
    const preview = await res.json() as any;
    expect(preview.room.title).toBe("Family");
    expect(preview.wrappedKey).toBe("sealed-room-key");
    expect(preview.remaining).toBe(1);
    expect(preview.proof).toBeUndefined();
  });

  it("says an expired link is gone rather than describing it", async () => {
    await create(f.alice);
    const record = await inviteStorage.get<any>("record");
    await inviteStorage.put("record", { ...record, expiresAt: Date.now() - 1 });
    expect((await invite.fetch(new Request(`https://kin.test${path()}`))).status).toBe(410);
  });
});

describe("revoking an invite", () => {
  it("lets any member kill a link, not only whoever made it", async () => {
    await create(f.alice, { maxUses: null });
    const res = await invite.fetch(await signedRequest(f.bob, "POST", path("/revoke"), { member: f.bob.member() }));
    expect(res.status).toBe(200);
    expect((await f.storage.get<any>(`invite:${CODE}`)).revoked).toBe(true);
  });

  it("refuses a stranger", async () => {
    await create(f.alice, { maxUses: null });
    const res = await invite.fetch(await signedRequest(f.mallory, "POST", path("/revoke"), { member: f.mallory.member() }));
    expect(res.status).toBe(403);
  });
});
