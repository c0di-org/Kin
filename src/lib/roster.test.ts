import { describe, expect, it } from "vitest";
import { applyRoster, mergeMembers, sameDeviceKeys } from "./roster";
import type { Conversation, PublicMember } from "./types";

const member = (deviceId: string, displayName: string, seed: string): PublicMember => ({
  deviceId, displayName, avatarSeed: `e:${displayName[0]}`,
  dhPublicJwk: { kty: "EC", crv: "P-256", x: `dh-x-${seed}`, y: `dh-y-${seed}` },
  signPublicJwk: { kty: "EC", crv: "P-256", x: `sig-x-${seed}`, y: `sig-y-${seed}` }
});

const alice = member("a", "Alice", "a");
const bob = member("b", "Bob", "b");

describe("sameDeviceKeys", () => {
  it("matches a member against itself", () => expect(sameDeviceKeys(alice, alice)).toBe(true));
  it("ignores name and avatar", () => expect(sameDeviceKeys(alice, { ...alice, displayName: "Al", avatarSeed: "e:🐸" })).toBe(true));
  it("catches a swapped signing key", () => expect(sameDeviceKeys(alice, { ...alice, signPublicJwk: bob.signPublicJwk })).toBe(false));
  it("catches a swapped DH key", () => expect(sameDeviceKeys(alice, { ...alice, dhPublicJwk: bob.dhPublicJwk })).toBe(false));
});

describe("mergeMembers", () => {
  it("accepts a rename from the member themselves", () => {
    const { members, refused } = mergeMembers([alice, bob], [{ ...bob, displayName: "Bobby", avatarSeed: "e:🐻" }]);
    expect(refused).toEqual([]);
    expect(members.find(m => m.deviceId === "b")).toMatchObject({ displayName: "Bobby", avatarSeed: "e:🐻" });
  });

  it("adds someone new", () => {
    const carol = member("c", "Carol", "c");
    const { members, refused } = mergeMembers([alice], [carol]);
    expect(refused).toEqual([]);
    expect(members.map(m => m.deviceId).sort()).toEqual(["a", "c"]);
  });

  it("refuses a key change and keeps the keys we already trust", () => {
    const impostor = { ...alice, signPublicJwk: bob.signPublicJwk };
    const { members, refused } = mergeMembers([alice, bob], [impostor]);
    expect(refused.map(m => m.deviceId)).toEqual(["a"]);
    expect(members.find(m => m.deviceId === "a")!.signPublicJwk).toEqual(alice.signPublicJwk);
  });

  it("refuses the key change but still takes the honest updates alongside it", () => {
    const impostor = { ...alice, dhPublicJwk: bob.dhPublicJwk };
    const { members, refused } = mergeMembers([alice, bob], [impostor, { ...bob, displayName: "Bobby" }]);
    expect(refused.map(m => m.deviceId)).toEqual(["a"]);
    expect(members.find(m => m.deviceId === "a")!.displayName).toBe("Alice");
    expect(members.find(m => m.deviceId === "b")!.displayName).toBe("Bobby");
  });
});

describe("applyRoster", () => {
  const conv: Conversation = { id: "r", kind: "group", title: "Family", key: "k", members: [alice, bob], createdAt: 0 };

  it("leaves a clean conversation without a warning flag", () => {
    const { conversation, refused } = applyRoster(conv, [{ ...bob, displayName: "Bobby" }]);
    expect(refused).toEqual([]);
    expect(conversation.keyAlerts).toBeUndefined();
  });

  it("records a standing warning that survives later clean updates", () => {
    const first = applyRoster(conv, [{ ...alice, signPublicJwk: bob.signPublicJwk }]);
    expect(first.conversation.keyAlerts).toEqual(["a"]);
    const second = applyRoster(first.conversation, [{ ...bob, displayName: "Bobby" }]);
    expect(second.conversation.keyAlerts).toEqual(["a"]);
  });
});
