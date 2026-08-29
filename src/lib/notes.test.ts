import { describe, expect, it, vi } from "vitest";
import { generateIdentity, publicMember, selfNotesRoom, selfRoom } from "./crypto";
import { ensureNotesRoom, isNotes, keepable, keptCopy, NOTES_TITLE } from "./notes";
import type { ChatMessage, Conversation } from "./types";

const relay = vi.hoisted(() => ({ createRoom: vi.fn() }));
vi.mock("./relay", () => ({ createRoom: relay.createRoom }));

const me = await generateIdentity("Ada");
const someoneElse = await generateIdentity("Bo");

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1", conversationId: "c1", senderDeviceId: me.deviceId, createdAt: 1_000,
  payload: { type: "text", text: "the wifi password is hunter2" }, ...over
});

describe("the room a person keeps for themselves", () => {
  it("is derived, so every screen of the same person arrives at the same one", async () => {
    const phone = await selfNotesRoom(me);
    const laptop = await selfNotesRoom(me);
    expect(phone).toEqual(laptop);
  });

  it("is nobody else's, id or key", async () => {
    const mine = await selfNotesRoom(me);
    const theirs = await selfNotesRoom(someoneElse);
    expect(mine.id).not.toBe(theirs.id);
    expect(mine.key).not.toBe(theirs.key);
  });

  // The load-bearing one. The sync room prunes every envelope but the newest snapshot each time
  // it is read, so a notepad sharing that room would be swept away by the next device sync.
  it("is not the room the devices sync through — neither the id nor the key", async () => {
    const notes = await selfNotesRoom(me);
    const sync = await selfRoom(me);
    expect(notes.id).not.toBe(sync.id);
    expect(notes.key).not.toBe(sync.key);
  });
});

describe("making sure it is there", () => {
  it("makes one, kept, with only its owner in it", async () => {
    relay.createRoom.mockResolvedValueOnce(undefined);
    const { conversation, reachedRelay } = await ensureNotesRoom(me, []);
    expect(conversation).toMatchObject({ title: NOTES_TITLE, kind: "group", keep: true, self: true });
    expect(conversation.members.map(m => m.deviceId)).toEqual([me.deviceId]);
    expect(conversation.id).toBe((await selfNotesRoom(me)).id);
    expect(reachedRelay).toBe(true);
    expect(isNotes(conversation)).toBe(true);
  });

  it("folds onto the row that is already there, so a used notepad keeps what is in it", async () => {
    relay.createRoom.mockResolvedValueOnce(undefined);
    const { id } = await selfNotesRoom(me);
    const held: Conversation = {
      id, kind: "group", title: NOTES_TITLE, key: "old", members: [publicMember(me)],
      createdAt: 500, self: true, lastMessageAt: 900, lastPreview: "milk", unread: 0
    };
    const { conversation } = await ensureNotesRoom(me, [held]);
    expect(conversation.createdAt).toBe(500);
    expect(conversation.lastPreview).toBe("milk");
    expect(conversation.key).toBe((await selfNotesRoom(me)).key);
  });

  it("never carries a role or a removal, which would lock the composer for good", async () => {
    relay.createRoom.mockResolvedValueOnce(undefined);
    const { id } = await selfNotesRoom(me);
    const stale: Conversation = {
      id, kind: "group", title: NOTES_TITLE, key: "old", members: [publicMember(me)],
      createdAt: 500, removedAt: 700, role: "viewer"
    };
    const { conversation } = await ensureNotesRoom(me, [stale]);
    expect(conversation.removedAt).toBeUndefined();
    expect(conversation.role).toBeUndefined();
  });

  it("still hands back the row when the relay cannot be reached, and says so", async () => {
    relay.createRoom.mockRejectedValueOnce(new Error("offline"));
    const { conversation, reachedRelay } = await ensureNotesRoom(me, []);
    expect(conversation.self).toBe(true);
    expect(reachedRelay).toBe(false);
  });
});

describe("keeping a copy of something", () => {
  it("takes the text and where it came from, and nothing else", () => {
    const copy = keptCopy(message(), "Beach Trip");
    expect(copy).toEqual({
      kind: "payload",
      payload: { type: "text", text: "the wifi password is hunter2", kept: { from: "Beach Trip" } }
    });
  });

  // A reply pointing at a message in another room would draw as "Message not loaded" for ever.
  it("drops a reply, which names a message the other room does not hold", () => {
    const copy = keptCopy(message({ payload: { type: "text", text: "hi", replyTo: "elsewhere" } }), "Family");
    expect(copy?.kind).toBe("payload");
    expect(copy && copy.kind === "payload" && copy.payload.replyTo).toBeUndefined();
  });

  it("keeps a list as the list, without the ticking", () => {
    const list = { title: "Packing", items: [{ id: "i1", text: "socks" }] };
    const copy = keptCopy(message({ payload: { type: "list", list } }), "Trip");
    expect(copy).toMatchObject({ kind: "payload", payload: { type: "list", list } });
    // A copy, not the same array: ticking in one room must not reach into the other.
    expect(copy && copy.kind === "payload" && copy.payload.list?.items).not.toBe(list.items);
  });

  // The relay files an encrypted file under the room it was uploaded to, so a payload pointing
  // back at the old room would be a photo that fell off the relay in a week.
  it("hands an attachment back to be re-sent rather than copying the payload", () => {
    const attachment = { fileId: "f1", name: "beach.jpg", mime: "image/jpeg", size: 10, iv: "i", key: "k", sha256: "s" };
    const copy = keptCopy(message({ payload: { type: "file", attachment } }), "Beach Trip");
    expect(copy).toEqual({ kind: "attachment", attachment, from: "Beach Trip" });
  });

  it("refuses a message that has been taken back, and anything that is not a message", () => {
    expect(keptCopy(message(), "Family", true)).toBeNull();
    expect(keptCopy(message({ deletedAt: 5 }), "Family")).toBeNull();
    expect(keptCopy(message({ payload: { type: "event", event: { kind: "reaction", targetId: "m0", value: "❤️" } } }), "Family")).toBeNull();
    expect(keptCopy(message({ payload: { type: "text", text: "   " } }), "Family")).toBeNull();
  });

  it("agrees with what the action bar asks before it offers the button", () => {
    expect(keepable(message(), false)).toBe(true);
    expect(keepable(message(), true)).toBe(false);
  });
});
