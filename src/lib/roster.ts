import type { Conversation, PublicMember } from "./types";

function sameJwk(a: JsonWebKey | undefined, b: JsonWebKey | undefined): boolean {
  if (!a || !b) return false;
  return a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;
}

export function sameDeviceKeys(a: PublicMember, b: PublicMember): boolean {
  return sameJwk(a.signPublicJwk, b.signPublicJwk) && sameJwk(a.dhPublicJwk, b.dhPublicJwk);
}

/**
 * Fold a roster update into the members we already trust.
 *
 * Names and avatars are theirs to change. Device keys are not: a device that needs new keys gets
 * a new deviceId, so a key change on someone we already know is somebody swapping themselves in
 * as that person — and adopting it would make their forged messages verify. The relay refuses
 * these writes too, so one reaching us means the relay itself is lying, which is exactly the case
 * the client must not depend on the relay to catch.
 *
 * Returns the merged roster plus the members whose keys we refused, so the UI can say so.
 */
export function mergeMembers(known: PublicMember[], incoming: PublicMember[]): { members: PublicMember[]; refused: PublicMember[] } {
  const byId = new Map(known.map(m => [m.deviceId, m]));
  const refused: PublicMember[] = [];
  for (const next of incoming) {
    const prev = byId.get(next.deviceId);
    if (!prev) { byId.set(next.deviceId, next); continue; }
    if (!sameDeviceKeys(prev, next)) { refused.push(prev); continue; }
    byId.set(next.deviceId, { ...prev, displayName: next.displayName, avatarSeed: next.avatarSeed });
  }
  return { members: [...byId.values()], refused };
}

/**
 * Merge a roster into a conversation, carrying forward any standing key warnings.
 *
 * `authoritative` marks a full roster pull rather than a single member card arriving over the
 * socket: it is the complete list, so anyone missing from it has been removed, and a device that
 * was offline when that happened has no other way to find out. A member whose keys we refused is
 * kept regardless — dropping them would quietly retire the warning about them.
 */
export function applyRoster(
  conv: Conversation,
  incoming: PublicMember[],
  { authoritative = false }: { authoritative?: boolean } = {}
): { conversation: Conversation; refused: PublicMember[] } {
  const { members, refused } = mergeMembers(conv.members, incoming);
  const alerts = new Set([...(conv.keyAlerts ?? []), ...refused.map(m => m.deviceId)]);
  const listed = new Set(incoming.map(m => m.deviceId));
  const stays = (m: PublicMember): boolean => listed.has(m.deviceId) || alerts.has(m.deviceId);
  const kept = authoritative && conv.kind === "group" ? members.filter(stays) : members;
  const left = authoritative && conv.kind === "group" ? members.filter(m => !stays(m)) : [];
  return {
    conversation: {
      ...conv,
      members: kept,
      ...(alerts.size ? { keyAlerts: [...alerts] } : {}),
      ...rememberDeparted(conv, left)
    },
    refused
  };
}

/**
 * Set somebody's card aside when they come off the roster, rather than letting go of it.
 *
 * The roster arrives from the relay and nobody signs it, so dropping a card on its say-so hands
 * the relay a way to make a person's whole history unverifiable — and therefore invisible —
 * without ever touching a message. Keeping the key costs one row and closes that off entirely.
 */
export function rememberDeparted(conv: Conversation, left: PublicMember[]): { pastMembers?: PublicMember[] } {
  if (!left.length) return conv.pastMembers ? { pastMembers: conv.pastMembers } : {};
  const byId = new Map((conv.pastMembers ?? []).map(m => [m.deviceId, m]));
  for (const m of left) if (!byId.has(m.deviceId)) byId.set(m.deviceId, m);
  return { pastMembers: [...byId.values()] };
}

/** Everyone whose signature we will still check: the room as it is, plus the room as it was. */
export function knownSenders(conv: Conversation): PublicMember[] {
  return [...conv.members, ...(conv.pastMembers ?? [])];
}
