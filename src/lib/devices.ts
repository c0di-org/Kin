import {
  linkCodeFor, linkProof, linkSecret, openLink, publicMember, sealLink, selfRoom,
  decryptPayload, encryptPayload, signEnvelope, verifyEnvelope
} from "./crypto";
import {
  claimDeviceLink, createDeviceLink, createRoom, dropEnvelope, history, sendEnvelope
} from "./relay";
import type {
  Conversation, DeviceLinkBundle, DeviceSnapshot, LocalIdentity, SnapshotRoom
} from "./types";

/**
 * One person, two screens.
 *
 * Kin's identity is a device: one key pair, one row on every roster, one derived id behind every
 * direct chat. Making a laptop a second *member* of everything would double every roster, split
 * every private chat in two, and leave a family working out which "Dad" they are talking to — so
 * a linked device is the same member on another screen, holding the same keys.
 *
 * That has a cost and it is not hidden anywhere: the private keys exist in two places, and
 * removing one screen from a room removes both, because the room cannot tell them apart. What it
 * buys is that everything else in Kin — signatures, direct chats, invites, key wrapping — carries
 * on meaning exactly what it meant before, rather than being rebuilt around a notion of "person"
 * that the protocol would then have to defend.
 *
 * Two halves live here. The **link** is the one-off ceremony that gets an identity across. The
 * **snapshot** is the standing arrangement afterwards: a room with one member in it, holding this
 * person's own picture of which rooms they are in, which is how a group made on the phone turns
 * up on the laptop without either of them asking the relay a question it should not answer.
 */

/** How much of a room travels between screens. Not messages: those are already on the relay. */
export function snapshotRoom(room: Conversation, myDeviceId: string): SnapshotRoom {
  const peer = room.kind === "direct" ? room.members.find(m => m.deviceId !== myDeviceId) : undefined;
  return {
    id: room.id,
    kind: room.kind,
    title: room.title,
    key: room.key,
    createdAt: room.createdAt,
    ...(room.emoji ? { emoji: room.emoji } : {}),
    ...(room.spaceId ? { spaceId: room.spaceId } : {}),
    ...(room.color ? { color: room.color } : {}),
    ...(room.keep ? { keep: true } : {}),
    ...(room.role ? { role: room.role } : {}),
    ...(room.metaAt ? { metaAt: room.metaAt } : {}),
    ...(room.profile ? { profile: room.profile } : {}),
    ...(peer ? { peer } : {})
  };
}

/**
 * A room arriving from another screen, as this one will hold it.
 *
 * The roster starts as whoever we already know about — us, and the other end of a direct chat.
 * Every group fills the rest in the moment it connects, because the sync layer pulls a room's
 * roster before it reads a word of its history; carrying the whole membership here would be
 * sending something already on its way, on the one payload with a size limit worth respecting.
 */
export function roomFromSnapshot(row: SnapshotRoom, identity: LocalIdentity): Conversation {
  const me = publicMember(identity);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    key: row.key,
    createdAt: row.createdAt,
    members: row.peer ? [me, row.peer] : [me],
    ...(row.emoji ? { emoji: row.emoji } : {}),
    ...(row.spaceId ? { spaceId: row.spaceId } : {}),
    ...(row.color ? { color: row.color } : {}),
    ...(row.keep ? { keep: true } : {}),
    ...(row.role ? { role: row.role } : {}),
    ...(row.metaAt ? { metaAt: row.metaAt } : {}),
    ...(row.profile ? { profile: row.profile } : {})
  };
}

/**
 * Rooms worth describing to another screen: everything except the one that screen can work out
 * for itself.
 *
 * The room somebody keeps for themselves is derived from their own private key, so a laptop
 * holding the identity already holds the room — sending it would be sending a key it computed
 * ten seconds ago. Leaving it out is not only tidiness: a room in the list is a room the
 * tombstone rules apply to, and a notepad that could be taken off one screen by something said
 * on another is a notepad with a way to lose things.
 */
const travels = (c: Conversation): boolean => !c.self;

export function buildSnapshot(
  identity: LocalIdentity,
  conversations: Conversation[],
  context: { home: string | null; gone: Record<string, number>; profileAt: number }
): DeviceSnapshot {
  return {
    v: 1,
    at: Date.now(),
    profile: { displayName: identity.displayName, avatarSeed: identity.avatarSeed, at: context.profileAt },
    home: context.home,
    rooms: conversations.filter(travels).map(c => snapshotRoom(c, identity.deviceId)),
    gone: context.gone
  };
}

/**
 * What this device should do about another of its own screens having a different list.
 *
 * Additive by default, which is the rule that makes two screens safe to run at once: neither can
 * take a room off the other by failing to mention it, so a laptop that has been shut for a month
 * cannot delete the group its owner joined on Tuesday.
 *
 * Removal is the one thing that has to be said out loud, and dated. A room is only dropped if it
 * is named in `gone` at a moment *after* this device's copy of it began — so leaving a family on
 * the phone takes it off the laptop, while leaving one and being invited back into it does not
 * take away the copy that came with the new invite.
 */
export function applySnapshot(
  identity: LocalIdentity,
  local: Conversation[],
  snapshot: DeviceSnapshot,
  context: { home: string | null; profileAt: number }
): {
  add: Conversation[];
  remove: string[];
  profile: { displayName: string; avatarSeed: string; at: number } | null;
  home: string | null;
} {
  const held = new Set(local.map(c => c.id));
  const listed = new Set(snapshot.rooms.map(r => r.id));
  const gone = snapshot.gone ?? {};

  const add = snapshot.rooms
    .filter(r => !held.has(r.id) && !((gone[r.id] ?? 0) > r.createdAt))
    .map(r => roomFromSnapshot(r, identity));

  const remove = local
    .filter(travels)
    .filter(c => !listed.has(c.id) && (gone[c.id] ?? 0) > c.createdAt)
    .map(c => c.id);

  // A name is one thing about a person rather than one thing about a screen, so it is the one
  // field a snapshot may overwrite — and only when it was decided later than what we hold.
  const profile = snapshot.profile && snapshot.profile.at > context.profileAt
    && (snapshot.profile.displayName !== identity.displayName || snapshot.profile.avatarSeed !== identity.avatarSeed)
    ? snapshot.profile
    : null;

  // Which room to open into is a decision about *this* screen — a phone and a laptop are used
  // differently — so it is taken from the other one only when this one has never made it.
  const home = context.home === null && snapshot.home ? snapshot.home : null;

  return { add, remove, profile, home };
}

/** A signature over everything a snapshot would carry, for deciding whether to publish one. */
export function snapshotSignature(snapshot: DeviceSnapshot): string {
  return JSON.stringify([
    snapshot.profile.displayName, snapshot.profile.avatarSeed, snapshot.profile.at, snapshot.home,
    snapshot.rooms.map(r => [r.id, r.title, r.key, r.emoji ?? "", r.color ?? "", r.role ?? "", r.spaceId ?? ""]).sort(),
    Object.entries(snapshot.gone).sort()
  ]);
}

/**
 * Is this picture worth putting where the other screen will read it?
 *
 * The one shape to be careful of is a picture with nothing in it. Publishing that over a picture
 * with rooms in it takes every group off every other screen until each of them notices and puts
 * it back — and the ways a device ends up holding nothing are mostly accidents: a browser that
 * evicted its storage, a local database cleared under a running app, a half-finished link.
 *
 * Emptiness that was *authored* is different, and says so: somebody who has left everything has
 * a tombstone for each room they left. So an empty list travels when it can account for itself,
 * and is held back when it cannot.
 */
export function worthPublishing(snapshot: DeviceSnapshot, lastKnownRooms: number): boolean {
  if (snapshot.rooms.length || !lastKnownRooms) return true;
  return Object.keys(snapshot.gone ?? {}).length > 0;
}

// ---------- the room a person's screens keep for each other ----------

/**
 * Make sure the sync room exists. Kept, because a picture of somebody's rooms that expired after
 * a week would leave a laptop opened once a fortnight with nothing to read.
 */
async function ensureSelfRoom(identity: LocalIdentity, id: string): Promise<void> {
  // Titled for the relay's benefit and nobody else's: it is the one field on a room the relay
  // holds in the clear, and this room has no notifications to name.
  await createRoom(identity, id, "group", "Kin", [publicMember(identity)], { keep: true });
}

/**
 * Read the newest picture another of this person's screens left.
 *
 * Verified against our own signing key before a byte of it is believed. That check is the whole
 * reason this can be trusted at all: the relay holds the room and could put anything in it, but
 * it cannot sign as us, so a forged room list — a group whose "key" the relay chose — is refused
 * rather than adopted.
 */
export async function pullSnapshot(identity: LocalIdentity): Promise<{ reached: boolean; snapshot: DeviceSnapshot | null }> {
  const { id, key } = await selfRoom(identity);
  let envelopes;
  try { envelopes = await history(identity, id); }
  catch {
    // Either there is no such room yet — this is the first screen, and making it is the answer —
    // or the relay is out of reach, in which case saying so matters: a device that publishes what
    // it holds without having read what its sibling holds is a device that overwrites it.
    try { await ensureSelfRoom(identity, id); } catch { return { reached: false, snapshot: null }; }
    return { reached: true, snapshot: null };
  }
  const me = publicMember(identity);
  const newest = [...envelopes].sort((a, b) => b.createdAt - a.createdAt);
  for (const envelope of newest) {
    if (envelope.senderDeviceId !== identity.deviceId) continue;
    if (!(await verifyEnvelope(envelope, me))) continue;
    try {
      const snapshot = await decryptPayload<DeviceSnapshot>(envelope, key);
      if (snapshot?.v !== 1) continue;
      // Everything behind the one we are keeping is a picture nobody will read again, and this
      // room does not expire — so the tidying has to be somebody's job, and it is this one's.
      void prune(identity, id, envelopes.map(e => e.id), envelope.id);
      return { reached: true, snapshot };
    } catch { /* not ours to open, or written by a version that is not this one */ }
  }
  return { reached: true, snapshot: null };
}

/** Leave a fresh picture, and take the previous ones down. */
export async function publishSnapshot(identity: LocalIdentity, snapshot: DeviceSnapshot): Promise<void> {
  const { id, key } = await selfRoom(identity);
  await ensureSelfRoom(identity, id);
  const envelope = await signEnvelope(identity, await encryptPayload(id, key, identity.deviceId, snapshot));
  await sendEnvelope(id, envelope);
  try { await prune(identity, id, (await history(identity, id)).map(e => e.id), envelope.id); }
  catch { /* the next pull tidies up instead */ }
}

async function prune(identity: LocalIdentity, roomId: string, ids: string[], keep: string): Promise<void> {
  for (const id of ids) {
    if (id === keep) continue;
    try { await dropEnvelope(identity, roomId, id); } catch { /* gone already, or not ours */ }
  }
}

// ---------- the ceremony that gets an identity onto a second screen ----------

/** `#link=<code>.<secret>` — the secret rides in the fragment, which browsers do not send. */
export function deviceLinkUrl(origin: string, code: string, secret: string): string {
  return `${origin}/#link=${code}.${encodeURIComponent(secret)}`;
}

export function parseDeviceLink(source: string): { code: string; secret: string } | null {
  const hash = source.includes("#") ? source.slice(source.indexOf("#") + 1) : source;
  const value = new URLSearchParams(hash).get("link");
  if (!value) return null;
  const at = value.indexOf(".");
  if (at <= 0) return null;
  const code = value.slice(0, at);
  const secret = decodeURIComponent(value.slice(at + 1));
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code) || secret.length < 40) return null;
  return { code, secret };
}

/**
 * Seal this identity for another of your own screens to collect.
 *
 * The relay is handed ciphertext filed under a hash of the secret, and never the secret — so the
 * link is the only thing that opens it, the link only ever exists in a fragment and a QR code,
 * and it is good for one collection inside fifteen minutes.
 */
export async function mintDeviceLink(identity: LocalIdentity, home: string | null, origin: string): Promise<{
  code: string; secret: string; link: string; expiresAt: number;
}> {
  const secret = linkSecret();
  const code = await linkCodeFor(secret);
  const bundle: DeviceLinkBundle = { v: 1, identity, home, at: Date.now() };
  const sealed = await sealLink(code, secret, bundle);
  const { expiresAt } = await createDeviceLink(identity, code, {
    proof: sealed.proof,
    iv: sealed.iv,
    blob: sealed.blob,
    owner: publicMember(identity)
  });
  return { code, secret, link: deviceLinkUrl(origin, code, secret), expiresAt };
}

/** Collect one. Nothing is written here — the caller decides whether to adopt what comes back. */
export async function claimIdentity(code: string, secret: string): Promise<DeviceLinkBundle> {
  // The proof is what persuades the relay to hand the bundle over, and it is derived from the
  // same secret that opens it — so a device that cannot decrypt it was never given it either.
  const { iv, blob } = await claimDeviceLink(code, await linkProof(code, secret));
  const { value } = await openLink<DeviceLinkBundle>(code, secret, blob, iv);
  if (value?.v !== 1 || !value.identity?.deviceId || !value.identity.signPrivateJwk) {
    throw new Error("That link did not contain a Kin identity");
  }
  return value;
}
