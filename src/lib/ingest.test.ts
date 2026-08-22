import { describe, expect, it, vi } from "vitest";
import { deletedIds, mergeMessages, openEnvelope, openEnvelopes, previewOf, reconnectDelay, redact, summarize } from "./ingest";
import { encryptPayload, generateIdentity, publicMember, randomKey, signEnvelope } from "./crypto";
import type { AttachmentPayload, ChatMessage, Conversation, LocalIdentity } from "./types";

async function fixture() {
  const me = await generateIdentity("Alice");
  const peer = await generateIdentity("Bob");
  const key = randomKey();
  const conv: Conversation = {
    id: "room-1", kind: "group", title: "Family", key,
    members: [publicMember(me), publicMember(peer)], createdAt: 0
  };
  // createdAt is folded into the AES-GCM additional data, so it has to be set before sealing
  // rather than patched afterwards — rewriting it later is exactly what decryption refuses.
  const sealed = async (from: LocalIdentity, text: string, createdAt?: number) => {
    const clock = createdAt === undefined ? null : vi.spyOn(Date, "now").mockReturnValue(createdAt);
    try {
      return await signEnvelope(from, await encryptPayload(conv.id, key, from.deviceId, { type: "text", text }));
    } finally { clock?.mockRestore(); }
  };
  return { me, peer, conv, key, sealed };
}

describe("openEnvelope", () => {
  it("opens a message from a member of the conversation", async () => {
    const { peer, conv, sealed } = await fixture();
    const opened = await openEnvelope(conv, await sealed(peer, "hello"));
    expect(opened?.message.payload).toEqual({ type: "text", text: "hello" });
    expect(opened?.sender.deviceId).toBe(peer.deviceId);
    expect(opened?.message.status).toBe("delivered");
  });

  it("refuses a sender who is not on the roster", async () => {
    const { conv, sealed } = await fixture();
    const stranger = await generateIdentity("Mallory");
    expect(await openEnvelope(conv, await sealed(stranger, "let me in"))).toBeNull();
  });

  it("refuses a member's envelope whose signature does not check out", async () => {
    const { peer, conv, sealed } = await fixture();
    const env = await sealed(peer, "hello");
    expect(await openEnvelope(conv, { ...env, ciphertext: env.ciphertext.slice(0, -4) + "AAAA" })).toBeNull();
  });

  it("refuses a payload sealed under a different conversation key", async () => {
    const { peer, conv } = await fixture();
    const foreign = await signEnvelope(peer, await encryptPayload(conv.id, randomKey(), peer.deviceId, { type: "text", text: "?" }));
    expect(await openEnvelope(conv, foreign)).toBeNull();
  });
});

describe("openEnvelopes", () => {
  it("drops what we already have and returns the rest oldest first", async () => {
    const { peer, conv, sealed } = await fixture();
    const a = await sealed(peer, "first", 1000);
    const b = await sealed(peer, "second", 2000);
    const c = await sealed(peer, "third", 3000);
    const opened = await openEnvelopes(conv, [c, a, b], new Set([b.id]));
    expect(opened.map(o => o.message.payload.text)).toEqual(["first", "third"]);
  });

  it("returns nothing when the whole batch is already stored", async () => {
    const { peer, conv, sealed } = await fixture();
    const env = await sealed(peer, "seen it");
    expect(await openEnvelopes(conv, [env], new Set([env.id]))).toEqual([]);
  });

  it("keeps the good messages when one in the batch is unopenable", async () => {
    const { peer, conv, sealed } = await fixture();
    const stranger = await generateIdentity("Mallory");
    const good = await sealed(peer, "fine", 1000);
    const bad = await signEnvelope(stranger, await encryptPayload(conv.id, conv.key, stranger.deviceId, { type: "text", text: "no" }));
    const opened = await openEnvelopes(conv, [good, bad], new Set());
    expect(opened.map(o => o.message.payload.text)).toEqual(["fine"]);
  });
});

describe("mergeMessages", () => {
  const msg = (id: string, createdAt: number, status?: ChatMessage["status"]): ChatMessage =>
    ({ id, conversationId: "room-1", senderDeviceId: "d", createdAt, payload: { type: "text", text: id }, status });

  it("keeps everything in time order", () => {
    const merged = mergeMessages([msg("a", 3)], [msg("b", 1), msg("c", 2)]);
    expect(merged.map(m => m.id)).toEqual(["b", "c", "a"]);
  });

  it("replaces a message rather than duplicating it", () => {
    const merged = mergeMessages([msg("a", 1, "sending")], [msg("a", 1, "read")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("read");
  });

  it("returns the original array untouched when nothing came in", () => {
    const existing = [msg("a", 1)];
    expect(mergeMessages(existing, [])).toBe(existing);
  });
});

describe("previewOf", () => {
  const attachment = (over: Partial<AttachmentPayload> = {}): AttachmentPayload =>
    ({ fileId: "f", name: "photo.jpg", mime: "image/jpeg", size: 1, iv: "", key: "", sha256: "", ...over });

  it("uses the text of a text message", () => expect(previewOf({ type: "text", text: "hi" })).toBe("hi"));
  it("labels a photo", () => expect(previewOf({ type: "file", attachment: attachment() })).toBe("📷 Photo"));
  it("labels a voice note", () => expect(previewOf({ type: "file", attachment: attachment({ mime: "audio/webm" }) })).toBe("🎤 Voice note"));
  it("labels a doodle", () => expect(previewOf({ type: "file", attachment: attachment({ name: "doodle-1", mime: "image/png" }) })).toBe("🖍️ Doodle"));
  it("is empty for a message with neither", () => expect(previewOf({ type: "event" })).toBe(""));
});

describe("summarize", () => {
  const conv: Conversation = { id: "room-1", kind: "group", title: "Family", key: "k", members: [], createdAt: 0 };
  const opened = (id: string, deviceId: string, createdAt: number, text = id, type: "text" | "event" = "text") => ({
    sender: { deviceId, displayName: "Bob Holland", avatarSeed: "e:b", dhPublicJwk: {}, signPublicJwk: {} },
    message: { id, conversationId: "room-1", senderDeviceId: deviceId, createdAt, payload: { type, text } }
  } as any);

  it("takes its preview from the newest visible message", () => {
    const next = summarize(conv, [opened("a", "them", 1, "older"), opened("b", "them", 2, "newest")],
      { myDeviceId: "me", activeAndVisible: false });
    expect(next?.lastPreview).toBe("newest");
    expect(next?.lastMessageAt).toBe(2);
  });

  it("counts unread messages from other people", () => {
    const next = summarize(conv, [opened("a", "them", 1), opened("b", "them", 2), opened("c", "me", 3)],
      { myDeviceId: "me", activeAndVisible: false });
    expect(next?.unread).toBe(2);
  });

  it("counts nothing while the conversation is open in front of you", () => {
    const next = summarize(conv, [opened("a", "them", 1)], { myDeviceId: "me", activeAndVisible: true });
    expect(next?.unread).toBe(0);
  });

  it("does not re-count messages older than the last read", () => {
    const next = summarize({ ...conv, lastReadAt: 5 }, [opened("a", "them", 1), opened("b", "them", 9)],
      { myDeviceId: "me", activeAndVisible: false });
    expect(next?.unread).toBe(1);
  });

  it("adds to an existing unread count rather than replacing it", () => {
    const next = summarize({ ...conv, unread: 3 }, [opened("a", "them", 1)], { myDeviceId: "me", activeAndVisible: false });
    expect(next?.unread).toBe(4);
  });

  it("credits your own message to You, by first name otherwise", () => {
    expect(summarize(conv, [opened("a", "me", 1)], { myDeviceId: "me", activeAndVisible: false })?.lastPreviewSender).toBe("You");
    expect(summarize(conv, [opened("a", "them", 1)], { myDeviceId: "me", activeAndVisible: false })?.lastPreviewSender).toBe("Bob");
  });

  it("ignores events entirely — a reaction is not a new message", () => {
    expect(summarize(conv, [opened("a", "them", 1, "x", "event")], { myDeviceId: "me", activeAndVisible: false })).toBeNull();
  });

  it("summarises around events mixed into a batch", () => {
    const next = summarize(conv, [opened("a", "them", 1, "real"), opened("b", "them", 2, "x", "event")],
      { myDeviceId: "me", activeAndVisible: false });
    expect(next?.lastPreview).toBe("real");
    expect(next?.unread).toBe(1);
  });

  it("never moves lastMessageAt backwards", () => {
    const next = summarize({ ...conv, lastMessageAt: 100 }, [opened("a", "them", 1)], { myDeviceId: "me", activeAndVisible: false });
    expect(next?.lastMessageAt).toBe(100);
  });
});

describe("reconnectDelay", () => {
  it("grows with each failed attempt", () => {
    const mid = (attempt: number) => reconnectDelay(attempt, () => 0.5);
    expect(mid(0)).toBeLessThan(mid(1));
    expect(mid(1)).toBeLessThan(mid(2));
  });

  it("never waits longer than a minute, however many times it has failed", () => {
    for (const attempt of [6, 10, 100]) expect(reconnectDelay(attempt, () => 1)).toBeLessThanOrEqual(60_000);
  });

  it("always waits at least half the ceiling, so a retry is never instant", () => {
    expect(reconnectDelay(0, () => 0)).toBe(500);
  });

  it("spreads attempts out instead of firing them together", () => {
    expect(reconnectDelay(3, () => 0)).not.toBe(reconnectDelay(3, () => 0.99));
  });
});

describe("deletedIds", () => {
  const msg = (id: string, from: string, payload: ChatMessage["payload"]): ChatMessage =>
    ({ id, conversationId: "room-1", senderDeviceId: from, createdAt: 1, payload });
  const del = (id: string, from: string, targetId: string): ChatMessage =>
    msg(id, from, { type: "event", event: { kind: "delete", targetId } });

  it("marks a message its own sender took back", () => {
    const ids = deletedIds([msg("m1", "alice", { type: "text", text: "oops" }), del("e1", "alice", "m1")]);
    expect([...ids]).toEqual(["m1"]);
  });

  it("refuses a delete naming somebody else's message", () => {
    // The envelope is signed, so the relay cannot forge this — but nothing stops a member of the
    // family from broadcasting it, and honouring it would let anyone silence anyone.
    const ids = deletedIds([msg("m1", "alice", { type: "text", text: "mine" }), del("e1", "bob", "m1")]);
    expect(ids.size).toBe(0);
  });

  it("ignores a delete for a message it is not holding", () => {
    expect(deletedIds([del("e1", "alice", "long-gone")]).size).toBe(0);
  });

  it("ignores reaction events", () => {
    const react = msg("e1", "alice", { type: "event", event: { kind: "reaction", targetId: "m1", value: "❤️" } });
    expect(deletedIds([msg("m1", "alice", { type: "text", text: "hi" }), react]).size).toBe(0);
  });
});

describe("redact", () => {
  it("drops the contents rather than only the rendering", () => {
    const att = { fileId: "f1", name: "secret.png", mime: "image/png", size: 10, iv: "i", key: "k", sha256: "s" };
    const redacted = redact({ id: "m1", conversationId: "room-1", senderDeviceId: "alice", createdAt: 1, payload: { type: "file", attachment: att } });
    expect(redacted.payload).toEqual({ type: "text" });
    expect(redacted.deletedAt).toBeGreaterThan(0);
  });

  it("keeps the first deletion time when applied twice", () => {
    const once = redact({ id: "m1", conversationId: "room-1", senderDeviceId: "alice", createdAt: 1, payload: { type: "text", text: "x" } });
    expect(redact(once).deletedAt).toBe(once.deletedAt);
  });
});
