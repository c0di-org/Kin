import { describe, expect, it } from "vitest";
import { generateIdentity, linkCodeFor, linkProof, linkSecret, openLink, publicMember, sealLink, selfRoom } from "./crypto";
import { applySnapshot, buildSnapshot, deviceLinkUrl, parseDeviceLink, roomFromSnapshot, snapshotRoom, snapshotSignature, worthPublishing } from "./devices";
import type { Conversation, LocalIdentity, PublicMember } from "./types";

const me = await generateIdentity("Ada");
const other = await generateIdentity("Bo");
const bo = publicMember(other);

function group(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, kind: "group", title: id, key: "kkkk", members: [publicMember(me)],
    createdAt: 1_000, ...over
  };
}
function direct(id: string, peer: PublicMember = bo, over: Partial<Conversation> = {}): Conversation {
  return { id, kind: "direct", title: peer.displayName, key: "kkkk", members: [publicMember(me), peer], createdAt: 1_000, ...over };
}
const context = { home: null as string | null, gone: {} as Record<string, number>, profileAt: 0 };
const snapshotOf = (rooms: Conversation[], over: Partial<ReturnType<typeof buildSnapshot>> = {}) =>
  ({ ...buildSnapshot(me, rooms, context), ...over });

describe("what a room looks like on the way across", () => {
  it("carries everything a second screen needs, and no roster it can pull for itself", () => {
    const row = snapshotRoom(group("g1", { emoji: "🏡", color: "sea", keep: true, role: "guest", spaceId: "s1", metaAt: 9 }), me.deviceId);
    expect(row).toMatchObject({ id: "g1", key: "kkkk", emoji: "🏡", color: "sea", keep: true, role: "guest", spaceId: "s1", metaAt: 9 });
    // A group's members arrive from the relay the moment the room connects, so sending them here
    // would be sending something already on its way, on the one payload with a size limit.
    expect(row).not.toHaveProperty("members");
    expect(row).not.toHaveProperty("peer");
  });

  it("carries the other person on a direct chat, which has no roster to pull", () => {
    const row = snapshotRoom(direct("d1"), me.deviceId);
    expect(row.peer?.deviceId).toBe(bo.deviceId);
    expect(roomFromSnapshot(row, me).members.map(m => m.deviceId)).toEqual([me.deviceId, bo.deviceId]);
  });

  it("round-trips a room through a snapshot unchanged in everything that matters", () => {
    const original = group("g1", { emoji: "🎒", keep: true, metaAt: 4 });
    const back = roomFromSnapshot(snapshotRoom(original, me.deviceId), me);
    expect(back).toMatchObject({ id: "g1", title: "g1", key: "kkkk", emoji: "🎒", keep: true, metaAt: 4, createdAt: 1_000 });
  });
});

describe("the room a person keeps for themselves", () => {
  // It falls out of the identity's own private key, so a screen holding the identity already
  // holds the room. Sending it would be sending a key the other side computed for itself.
  it("is not described to the other screen, because the other screen derives it", () => {
    const snapshot = snapshotOf([group("g1"), group("mine", { self: true })]);
    expect(snapshot.rooms.map(r => r.id)).toEqual(["g1"]);
  });

  // A room in the list is a room the tombstone rules apply to, and a notepad that could be taken
  // off one screen by something said on another is a notepad with a way to lose things.
  it("is never removed by a snapshot that does not mention it", () => {
    const mine = group("mine", { self: true });
    const snapshot = { ...snapshotOf([group("g1")]), gone: { mine: 9_999 } };
    const { remove } = applySnapshot(me, [group("g1"), mine], snapshot, { home: null, profileAt: 0 });
    expect(remove).toEqual([]);
  });
});

describe("folding another screen's picture into this one", () => {
  it("adds what this device has not got", () => {
    const { add, remove } = applySnapshot(me, [group("g1")], snapshotOf([group("g1"), group("g2")]), { home: null, profileAt: 0 });
    expect(add.map(c => c.id)).toEqual(["g2"]);
    expect(remove).toEqual([]);
  });

  it("never removes a room just because the other screen did not mention it", () => {
    // The rule the whole arrangement rests on: a laptop shut for a fortnight cannot take away the
    // group its owner joined on Tuesday simply by having an older list.
    const { add, remove } = applySnapshot(me, [group("g1"), group("g2")], snapshotOf([group("g1")]), { home: null, profileAt: 0 });
    expect(add).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("removes a room that was explicitly left, after this copy of it began", () => {
    const snapshot = snapshotOf([], { gone: { g1: 5_000 } });
    const { remove } = applySnapshot(me, [group("g1")], snapshot, { home: null, profileAt: 0 });
    expect(remove).toEqual(["g1"]);
  });

  it("keeps a room left last week and joined again since", () => {
    const snapshot = snapshotOf([], { gone: { g1: 5_000 } });
    const { remove } = applySnapshot(me, [group("g1", { createdAt: 9_000 })], snapshot, { home: null, profileAt: 0 });
    expect(remove).toEqual([]);
  });

  it("does not re-add a room the picture both lists and buries", () => {
    const snapshot = snapshotOf([group("g1")], { gone: { g1: 5_000 } });
    expect(applySnapshot(me, [], snapshot, { home: null, profileAt: 0 }).add).toEqual([]);
  });

  it("adopts a newer name, and refuses an older one", () => {
    const fresh = snapshotOf([], { profile: { displayName: "Ada L", avatarSeed: "e:🦊", at: 500 } });
    expect(applySnapshot(me, [], fresh, { home: null, profileAt: 100 }).profile).toMatchObject({ displayName: "Ada L" });
    expect(applySnapshot(me, [], fresh, { home: null, profileAt: 900 }).profile).toBeNull();
  });

  it("takes a landing room only when this screen has never chosen one", () => {
    const snapshot = snapshotOf([group("g1")], { home: "g1" });
    expect(applySnapshot(me, [], snapshot, { home: null, profileAt: 0 }).home).toBe("g1");
    // Which room a screen opens into is a decision about that screen: a phone and a laptop are
    // held differently, and one is not entitled to overrule the other.
    expect(applySnapshot(me, [], snapshot, { home: "g2", profileAt: 0 }).home).toBeNull();
  });
});

describe("deciding whether there is anything to publish", () => {
  it("ignores the moment a picture was taken, and notices what is in it", () => {
    const a = snapshotOf([group("g1")]);
    const b = { ...snapshotOf([group("g1")]), at: a.at + 10_000 };
    expect(snapshotSignature(a)).toBe(snapshotSignature(b));
    expect(snapshotSignature(a)).not.toBe(snapshotSignature(snapshotOf([group("g1"), group("g2")])));
  });

  it("notices a rename, a recolour and a fresh key", () => {
    const base = snapshotSignature(snapshotOf([group("g1")]));
    expect(snapshotSignature(snapshotOf([group("g1", { title: "Beach Trip" })]))).not.toBe(base);
    expect(snapshotSignature(snapshotOf([group("g1", { color: "sea" })]))).not.toBe(base);
    expect(snapshotSignature(snapshotOf([group("g1", { key: "other" })]))).not.toBe(base);
  });

  it("does not depend on what order the rooms came back in", () => {
    expect(snapshotSignature(snapshotOf([group("g1"), group("g2")])))
      .toBe(snapshotSignature(snapshotOf([group("g2"), group("g1")])));
  });
});

describe("holding back a picture that would do harm", () => {
  it("publishes anything with rooms in it", () => {
    expect(worthPublishing(snapshotOf([group("g1")]), 4)).toBe(true);
  });

  it("publishes an empty list when there was nothing there before", () => {
    expect(worthPublishing(snapshotOf([]), 0)).toBe(true);
  });

  it("refuses an empty list over one with rooms in it", () => {
    // A browser that evicted its storage, or a database cleared under a running app, would
    // otherwise take every group off every other screen until each noticed and put it back.
    expect(worthPublishing(snapshotOf([]), 3)).toBe(false);
  });

  it("allows an empty list that can account for itself", () => {
    // Somebody who has genuinely left everything has a tombstone for each room they left.
    expect(worthPublishing(snapshotOf([], { gone: { g1: 5_000 } }), 3)).toBe(true);
  });
});

describe("the room a person's own screens keep", () => {
  it("is the same room and key on both, and nowhere near anybody else's", async () => {
    const mine = await selfRoom(me);
    expect(await selfRoom({ ...me } as LocalIdentity)).toEqual(mine);
    expect((await selfRoom(other)).id).not.toBe(mine.id);
    // Derived from the private key, so knowing somebody's device id — which every one of their
    // family does — is not knowing where to look, let alone how to read it.
    expect(mine.id).not.toContain(me.deviceId);
  });
});

describe("the link that carries an identity", () => {
  it("seals a bundle that only the secret opens", async () => {
    const secret = linkSecret();
    const code = await linkCodeFor(secret);
    const sealed = await sealLink(code, secret, { hello: "there" });
    expect(sealed.blob).not.toContain("hello");
    expect((await openLink<{ hello: string }>(code, secret, sealed.blob, sealed.iv)).value).toEqual({ hello: "there" });
    await expect(openLink(code, linkSecret(), sealed.blob, sealed.iv)).rejects.toThrow();
  });

  it("hands the relay a proof it cannot walk back to the secret", async () => {
    const secret = linkSecret();
    const code = await linkCodeFor(secret);
    const { proof } = await sealLink(code, secret, null);
    expect(proof).toBe(await linkProof(code, secret));
    expect(proof).not.toContain(secret);
    expect(code).not.toContain(secret);
  });

  it("puts the secret in the fragment, where browsers leave it alone", async () => {
    const secret = linkSecret();
    const code = await linkCodeFor(secret);
    const url = deviceLinkUrl("https://kin.test", code, secret);
    expect(new URL(url).search).toBe("");
    expect(parseDeviceLink(new URL(url).hash)).toEqual({ code, secret });
  });

  it("refuses anything that is not one", () => {
    expect(parseDeviceLink("#join=abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(parseDeviceLink("#link=short.aaa")).toBeNull();
    expect(parseDeviceLink("#link=abcdefgh")).toBeNull();
    expect(parseDeviceLink("")).toBeNull();
  });
});
