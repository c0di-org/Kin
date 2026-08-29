import { publicMember, selfNotesRoom } from "./crypto";
import { createRoom } from "./relay";
import type { ChatMessage, ChatPayload, Conversation, LocalIdentity } from "./types";

/**
 * Just me — the room a person sends to themselves.
 *
 * Every messenger grows one of these, usually by accident: somebody opens a chat with their own
 * number and uses it as a notepad. Kin has a better reason for it than habit. An identity here
 * can be open on a phone and a laptop at once, and the two are the *same* member — so a room
 * with one member in it is not a lonely group, it is the shortest path between somebody's own
 * screens. A link copied on the laptop is on the phone before it has been put down.
 *
 * Three rules keep it from becoming a second messenger inside the first:
 *
 * 1. **Derived, never created.** The id and the key fall out of the identity's own private key,
 *    so every screen of a person arrives at the same room without being told about it, and
 *    nothing has to travel between them for it to exist. It is not carried in the device
 *    snapshot for the same reason a channel key is not: what can be computed is not sent.
 * 2. **Exactly one copy of anything.** The sender writes its own message locally before the
 *    relay ever sees it, and the ingest path skips any envelope whose id is already on disk —
 *    so a note appears once on the screen that wrote it and once on the screen that did not.
 *    See `keptCopy` for the other half of that: keeping a message makes one copy of it, in here,
 *    and leaves the original exactly as it was.
 * 3. **Quiet.** Your own notes are never unread and never a badge — the relay skips every push
 *    endpoint belonging to the sender, and every endpoint here belongs to the sender. A note
 *    arriving from your other screen is worth a dot, and a dot is all it gets.
 */
export const NOTES_TITLE = "Just me";
export const NOTES_EMOJI = "🔖";

/** Is this the room somebody keeps for themselves? */
export function isNotes(c: Conversation | null | undefined): boolean {
  return !!c?.self;
}

/**
 * This person's own room, as this device should hold it.
 *
 * Idempotent on both sides. Locally it folds onto whatever row is already there, so a room that
 * has been used keeps its history, its preview and its unread state; on the relay `createRoom`
 * hands back the room it already made rather than making a second one. Kept, because a notepad
 * that quietly emptied itself every seven days would be worse than no notepad.
 *
 * The relay half is allowed to fail — a device that is offline still gets the row, and the
 * messages it writes sit as failed until the room exists and the flush pushes them out.
 */
export async function ensureNotesRoom(
  identity: LocalIdentity,
  existing: Conversation[]
): Promise<{ conversation: Conversation; reachedRelay: boolean }> {
  const { id, key } = await selfNotesRoom(identity);
  const held = existing.find(c => c.id === id);
  const me = publicMember(identity);
  const conversation: Conversation = {
    ...(held ?? { createdAt: Date.now() }),
    id,
    kind: "group",
    title: NOTES_TITLE,
    emoji: NOTES_EMOJI,
    key,
    members: [me],
    keep: true,
    self: true
  };
  // Never a "removed" or a role: there is nobody here to be let in by, or thrown out by. A stale
  // one of either from an older row would put the composer into its read-only state for good.
  delete conversation.removedAt;
  delete conversation.role;
  delete conversation.spaceId;
  let reachedRelay = true;
  try { await createRoom(identity, id, "group", NOTES_TITLE, [me], { keep: true }); }
  catch { reachedRelay = false; }
  return { conversation, reachedRelay };
}

/**
 * What a message looks like once it has been kept.
 *
 * The one thing this must not do is produce a second message anywhere but here. So it takes the
 * payload apart rather than copying it: the text or the list, plus a note of where it came from,
 * and deliberately *not* `replyTo` — a reply pointing at a message in another room would draw as
 * "Message not loaded" forever. An attachment is not copied at all; it is handed back for the
 * caller to re-send from the bytes on this device, because the relay files an encrypted file
 * under the room it was uploaded to and would refuse to hand it over to another one.
 *
 * Null for anything with nothing to keep: an event, a message already taken back, an empty line.
 */
export function keptCopy(m: ChatMessage, from: string, deleted = false):
  | { kind: "payload"; payload: ChatPayload }
  | { kind: "attachment"; attachment: NonNullable<ChatPayload["attachment"]>; from: string }
  | null {
  if (deleted || m.deletedAt) return null;
  const kept = { from };
  if (m.payload.type === "text" && m.payload.text?.trim()) {
    return { kind: "payload", payload: { type: "text", text: m.payload.text, kept } };
  }
  if (m.payload.type === "list" && m.payload.list) {
    // A fresh copy of the lines, and none of the ticks: what is kept is the list, not the
    // shopping trip. Folding happens per room, so the ids may stay as they are.
    return { kind: "payload", payload: { type: "list", list: { ...m.payload.list, items: [...m.payload.list.items] }, kept } };
  }
  if (m.payload.type === "file" && m.payload.attachment) {
    return { kind: "attachment", attachment: m.payload.attachment, from };
  }
  return null;
}

/** Can this message be kept at all? What the action bar asks before it offers the button. */
export function keepable(m: ChatMessage, deleted: boolean): boolean {
  return !!keptCopy(m, "", deleted);
}
