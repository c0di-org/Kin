import type { ChatMessage, ChatPayload, CipherEnvelope, Conversation, PublicMember } from "./types";
import { decryptPayload, verifyEnvelope } from "./crypto";
import { knownSenders } from "./roster";
import { previewLabel } from "./media";

/** A message that verified and decrypted, alongside the roster entry that signed it. */
export type OpenedMessage = { message: ChatMessage; sender: PublicMember };

export const firstName = (s: string): string => s.trim().split(/\s+/)[0] ?? s;

/**
 * Verify and decrypt one envelope against a roster we already hold.
 *
 * Null covers three different "not ours": a sender who is not in this conversation, a signature
 * that does not check out, and a payload we hold no key for. None of them is an error worth
 * surfacing — on a shared relay all three are things other people's traffic does.
 */
export async function openEnvelope(conv: Conversation, env: CipherEnvelope): Promise<OpenedMessage | null> {
  // Past members count: somebody leaving does not unsay what they said, and a history replay that
  // only knew the current roster would quietly drop every message they ever sent.
  const sender = knownSenders(conv).find(m => m.deviceId === env.senderDeviceId);
  if (!sender || !(await verifyEnvelope(env, sender))) return null;
  try {
    const payload = await decryptPayload(env, conv.key);
    return {
      sender,
      message: {
        id: env.id, conversationId: conv.id, senderDeviceId: env.senderDeviceId,
        createdAt: env.createdAt, payload, status: "delivered"
      }
    };
  } catch { return null; }
}

/** Open a batch, dropping anything already stored, oldest first. */
export async function openEnvelopes(
  conv: Conversation,
  envelopes: CipherEnvelope[],
  known: Set<string>
): Promise<OpenedMessage[]> {
  const fresh = envelopes.filter(e => !known.has(e.id)).sort((a, b) => a.createdAt - b.createdAt);
  const opened = await Promise.all(fresh.map(env => openEnvelope(conv, env)));
  return opened.flatMap(x => x ? [x] : []);
}

/** Fold new messages into what a conversation is already showing, newest last, no duplicates. */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function previewOf(payload: ChatPayload): string {
  if (payload.type === "text") return payload.text ?? "";
  return payload.attachment ? previewLabel(payload.attachment) : "";
}

/**
 * Which messages have been taken back, folded out of the event stream the same way reactions are.
 *
 * A delete is only honoured from the person who sent the message: the payload is signed, so the
 * relay cannot forge one, but nothing stops a family member from broadcasting a delete naming
 * somebody else's message. A target we are not holding is ignored rather than trusted, since
 * there is no sender to check it against.
 */
export function deletedIds(messages: ChatMessage[]): Set<string> {
  const senderOf = new Map(messages.map(m => [m.id, m.senderDeviceId]));
  const deleted = new Set<string>();
  for (const m of messages) {
    const ev = m.payload.event;
    if (m.payload.type !== "event" || ev?.kind !== "delete") continue;
    if (senderOf.get(ev.targetId) === m.senderDeviceId) deleted.add(ev.targetId);
  }
  return deleted;
}

/** A deleted message with its contents actually gone, rather than merely not drawn. */
export function redact(m: ChatMessage): ChatMessage {
  return { ...m, payload: { type: "text" }, deletedAt: m.deletedAt ?? Date.now() };
}

/**
 * What a batch of newly-opened messages does to a conversation's summary row.
 *
 * Events — edits, reactions, deletions — deliberately never become the preview line or bump the
 * unread count; they are bookkeeping about messages, not messages. Returns null when the batch
 * held nothing worth showing, so callers can skip the write entirely.
 */
export function summarize(
  conv: Conversation,
  opened: OpenedMessage[],
  context: { myDeviceId: string; activeAndVisible: boolean }
): Conversation | null {
  const visible = opened.filter(o => o.message.payload.type !== "event");
  const last = visible[visible.length - 1];
  if (!last) return null;

  const missed = context.activeAndVisible ? 0 : visible.filter(o =>
    o.message.senderDeviceId !== context.myDeviceId && o.message.createdAt > (conv.lastReadAt ?? 0)).length;
  const mine = last.message.senderDeviceId === context.myDeviceId;

  return {
    ...conv,
    lastMessageAt: Math.max(conv.lastMessageAt ?? 0, last.message.createdAt),
    unread: (conv.unread ?? 0) + missed,
    lastPreview: previewOf(last.message.payload),
    lastPreviewSender: mine ? "You" : firstName(last.sender.displayName)
  };
}

/**
 * How long to wait before reconnecting a socket, given how many attempts have already failed.
 *
 * A flat retry means every room in the family reconnects in lockstep after a blip, and keeps
 * hammering at the same interval if the relay is genuinely down. Backs off to a minute, and
 * spreads attempts across half that window so one device is not a synchronised herd.
 */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(1000 * 2 ** Math.min(attempt, 6), 60_000);
  return ceiling / 2 + random() * (ceiling / 2);
}
