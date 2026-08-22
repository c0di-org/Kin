import { describe, expect, it } from "vitest";
import { deriveChannelKey, generateIdentity, inviteSecret, openChannelMeta, openInvite, randomKey, sealChannelMeta, sealInvite } from "./crypto";
import { anonymousProfile, canPost, inviteCodeFor, inviteLink, isFullMember, parseInviteLink, spaceTree } from "./spaces";
import type { Conversation } from "./types";

describe("channel keys", () => {
  it("give every member of a space the same key from the channel id alone", async () => {
    const spaceKey = randomKey();
    const onAlicesPhone = await deriveChannelKey(spaceKey, "japan-trip");
    const onBobsPhone = await deriveChannelKey(spaceKey, "japan-trip");
    expect(onAlicesPhone).toBe(onBobsPhone);
  });

  it("give different channels different keys", async () => {
    const spaceKey = randomKey();
    expect(await deriveChannelKey(spaceKey, "japan")).not.toBe(await deriveChannelKey(spaceKey, "homework"));
  });

  it("give the same channel id in another space a different key", async () => {
    expect(await deriveChannelKey(randomKey(), "japan")).not.toBe(await deriveChannelKey(randomKey(), "japan"));
  });

  it("does not hand back the space key itself", async () => {
    const spaceKey = randomKey();
    expect(await deriveChannelKey(spaceKey, "japan")).not.toBe(spaceKey);
  });
});

describe("the channel directory", () => {
  it("round-trips a name the relay never sees in the clear", async () => {
    const spaceKey = randomKey();
    const sealed = await sealChannelMeta(spaceKey, { title: "Japan trip", emoji: "🗾" });
    expect(sealed.blob).not.toContain("Japan");
    expect(await openChannelMeta(spaceKey, sealed.blob, sealed.iv)).toEqual({ title: "Japan trip", emoji: "🗾" });
  });

  it("is unreadable to somebody holding a different space key", async () => {
    const sealed = await sealChannelMeta(randomKey(), { title: "Homework", emoji: "📚" });
    await expect(openChannelMeta(randomKey(), sealed.blob, sealed.iv)).rejects.toThrow();
  });
});

describe("invite secrets", () => {
  it("carries the room key through a link and back out again", async () => {
    const roomKey = randomKey();
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    const sealed = await sealInvite(code, secret, roomKey);
    const opened = await openInvite(code, secret, sealed.wrappedKey, sealed.iv);
    expect(opened.roomKey).toBe(roomKey);
    expect(opened.proof).toBe(sealed.proof);
  });

  it("will not open with the wrong secret, which is what the relay holds nothing of", async () => {
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    const sealed = await sealInvite(code, secret, randomKey());
    await expect(openInvite(code, inviteSecret(), sealed.wrappedKey, sealed.iv)).rejects.toThrow();
  });

  it("hides the secret behind both the code and the proof", async () => {
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    const { proof } = await sealInvite(code, secret, randomKey());
    expect(code).not.toContain(secret);
    expect(proof).not.toContain(secret);
    expect(proof).not.toBe(code);
  });

  it("names a different object for every invite", async () => {
    expect(await inviteCodeFor(inviteSecret())).not.toBe(await inviteCodeFor(inviteSecret()));
  });
});

describe("invite links", () => {
  it("puts the secret in the fragment, where it stays out of the request", async () => {
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    const link = inviteLink("https://kin.c0di.com", code, secret);
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash).toContain(code);
  });

  it("round-trips", async () => {
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    expect(parseInviteLink(inviteLink("https://kin.c0di.com", code, secret))).toEqual({ code, secret });
  });

  it("reads a bare fragment as well as a whole url", async () => {
    const secret = inviteSecret();
    const code = await inviteCodeFor(secret);
    expect(parseInviteLink(`join=${code}.${encodeURIComponent(secret)}`)).toEqual({ code, secret });
  });

  it("refuses anything that is not one", () => {
    expect(parseInviteLink("https://kin.c0di.com/")).toBeNull();
    expect(parseInviteLink("#join=onlyacode")).toBeNull();
    expect(parseInviteLink("#join=.secret")).toBeNull();
    expect(parseInviteLink("#join=short.tooshort")).toBeNull();
  });

  it("survives a secret whose base64 ends in padding-ish characters", async () => {
    // b64url of 32 random bytes runs to 43 characters and can contain - and _, which have to
    // come back out of the URL exactly as they went in or the key will not open.
    for (let i = 0; i < 40; i++) {
      const secret = inviteSecret();
      const code = await inviteCodeFor(secret);
      expect(parseInviteLink(inviteLink("https://kin.c0di.com", code, secret))?.secret).toBe(secret);
    }
  });
});

describe("arriving anonymously", () => {
  it("still gives somebody a name you could address", () => {
    const profile = anonymousProfile();
    expect(profile.displayName).toMatch(/^Guest \w+$/);
    expect(profile.avatarSeed.startsWith("e:")).toBe(true);
  });
});

describe("identities across rooms", () => {
  it("lets one device be known differently in two places without changing its keys", async () => {
    const id = await generateIdentity("Cass");
    const atHome = { ...id, displayName: "Cass" };
    const asGuest = { ...id, displayName: "Guest Otter" };
    expect(atHome.signPublicJwk).toEqual(asGuest.signPublicJwk);
    expect(atHome.displayName).not.toBe(asGuest.displayName);
  });
});

describe("arranging what a device holds", () => {
  const group = (over: Partial<Conversation>): Conversation => ({
    id: "x", kind: "group", title: "T", key: "k", members: [], createdAt: 0, ...over
  } as Conversation);

  it("leaves a group with no channels as one flat row", () => {
    const tree = spaceTree([group({ id: "fam", title: "Family" })]);
    expect(tree.spaces).toHaveLength(1);
    expect(tree.spaces[0].channels).toEqual([]);
  });

  it("files channels under the space they name", () => {
    const tree = spaceTree([
      group({ id: "fam" }),
      group({ id: "japan", spaceId: "fam" }),
      group({ id: "homework", spaceId: "fam" })
    ]);
    expect(tree.spaces).toHaveLength(1);
    expect(tree.spaces[0].channels.map(c => c.id).sort()).toEqual(["homework", "japan"]);
  });

  it("adds up unread across a space and everything in it", () => {
    const tree = spaceTree([
      group({ id: "fam", unread: 1 }),
      group({ id: "japan", spaceId: "fam", unread: 3 }),
      group({ id: "homework", spaceId: "fam", unread: 2 })
    ]);
    expect(tree.spaces[0].unread).toBe(6);
  });

  it("keeps a channel whose space this device never joined, rather than losing it", () => {
    const tree = spaceTree([group({ id: "japan", spaceId: "somebody-elses-space" })]);
    expect(tree.spaces).toEqual([]);
    expect(tree.orphans.map(c => c.id)).toEqual(["japan"]);
  });

  it("sorts spaces by the most recent thing anywhere inside them", () => {
    const tree = spaceTree([
      group({ id: "quiet", lastMessageAt: 500 }),
      group({ id: "busy", lastMessageAt: 100 }),
      group({ id: "chatter", spaceId: "busy", lastMessageAt: 900 })
    ]);
    expect(tree.spaces.map(s => s.space.id)).toEqual(["busy", "quiet"]);
  });

  it("keeps direct chats out of the space list entirely", () => {
    const tree = spaceTree([group({ id: "fam" }), group({ id: "dm", kind: "direct" })]);
    expect(tree.spaces.map(s => s.space.id)).toEqual(["fam"]);
    expect(tree.directs.map(c => c.id)).toEqual(["dm"]);
  });
});

describe("what a role allows", () => {
  const conv = (role?: string) => ({ id: "x", kind: "group", title: "T", key: "k", members: [], createdAt: 0, role } as Conversation);

  it("treats a conversation with no role at all as a full member's", () => {
    expect(isFullMember(conv())).toBe(true);
    expect(canPost(conv())).toBe(true);
  });

  it("stops a guest inviting, but not posting", () => {
    expect(isFullMember(conv("guest"))).toBe(false);
    expect(canPost(conv("guest"))).toBe(true);
  });

  it("stops a viewer posting", () => {
    expect(canPost(conv("viewer"))).toBe(false);
  });
});
