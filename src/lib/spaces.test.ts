import { describe, expect, it } from "vitest";
import { deriveChannelKey, generateIdentity, inviteSecret, openChannelMeta, openInvite, randomKey, sealChannelMeta, sealInvite } from "./crypto";
import { anonymousProfile, inviteCodeFor, inviteLink, parseInviteLink } from "./spaces";

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
