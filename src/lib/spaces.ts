import {
  deriveChannelKey, inviteSecret, openChannelMeta, openInvite, publicMember,
  randomId, randomKey, sealChannelMeta, sealInvite, sha256
} from "./crypto";
import {
  createInvite, createRoom, joinChannel, listChannels, previewInvite,
  publishChannel, redeemInvite, unpublishChannel
} from "./relay";
import type { Conversation, InvitePreview, InviteRole, LocalIdentity, PublicMember } from "./types";

const DAY = 24 * 60 * 60 * 1000;

/** How long a link lives if nobody says otherwise: long enough to be seen, short enough to lapse. */
export const DEFAULT_INVITE_TTL = 7 * DAY;

// ---------- spaces and channels ----------

/**
 * A group with nothing above it. Every group used to be one of these without needing a name for
 * it; a group only becomes a *space* in any meaningful sense once it has a second channel.
 */
export async function createSpace(identity: LocalIdentity, title: string, options: { emoji?: string; keep?: boolean } = {}): Promise<Conversation> {
  const space: Conversation = {
    id: randomId(),
    kind: "group",
    title: title.trim().slice(0, 40) || "New group",
    key: randomKey(),
    members: [publicMember(identity)],
    createdAt: Date.now(),
    ...(options.emoji ? { emoji: options.emoji } : {}),
    ...(options.keep ? { keep: true } : {})
  };
  await createRoom(identity, space.id, "group", space.title, space.members, { keep: options.keep });
  return space;
}

/**
 * Open a channel in a space.
 *
 * There is no key to hand out and nobody to wait for: the channel's key falls out of the space's
 * key and the channel's id, both of which every member either has or is about to be told. So
 * creating one is a room on the relay plus a line in the space's directory, and everyone else
 * finds it the next time they look.
 */
export async function createChannel(
  identity: LocalIdentity,
  space: Conversation,
  title: string,
  options: { emoji?: string; keep?: boolean } = {}
): Promise<Conversation> {
  const id = randomId();
  const name = title.trim().slice(0, 40) || "New channel";
  const emoji = options.emoji ?? "💬";
  const channel: Conversation = {
    id,
    kind: "group",
    title: name,
    emoji,
    key: await deriveChannelKey(space.key, id),
    members: [publicMember(identity)],
    createdAt: Date.now(),
    spaceId: space.id,
    ...(options.keep ? { keep: true } : {})
  };
  await createRoom(identity, id, "group", name, channel.members, { spaceId: space.id, keep: options.keep });
  await publishChannel(identity, space.id, { id, ...(await sealChannelMeta(space.key, { title: name, emoji })) });
  return channel;
}

export async function removeChannel(identity: LocalIdentity, space: Conversation, channelId: string): Promise<void> {
  await unpublishChannel(identity, space.id, channelId);
}

/**
 * Read a space's directory: the channels this device does not have yet, and everything the
 * directory currently lists.
 *
 * Joining each one is a separate step that may fail on its own — a channel deleted between the
 * listing and the join, a device that has since been removed from the space — so a channel that
 * will not open is skipped rather than failing the whole sweep.
 *
 * `present` is what makes a deletion travel to a device that was asleep when it happened. The
 * relay broadcasts a removal, but a broadcast only reaches whoever is listening; the directory is
 * the durable answer, and a channel missing from it has been deleted for everybody.
 */
export async function discoverChannels(
  identity: LocalIdentity,
  space: Conversation,
  known: Set<string>
): Promise<{ joined: Conversation[]; present: Set<string> }> {
  const directory = await listChannels(identity, space.id);
  const found: Conversation[] = [];
  for (const record of directory) {
    if (known.has(record.id)) continue;
    try {
      const meta = await openChannelMeta(space.key, record.blob, record.iv);
      const mine = publicMember(identity);
      await joinChannel(identity, record.id, { ...mine, ...(space.profile ?? {}) });
      found.push({
        id: record.id,
        kind: "group",
        title: meta.title,
        emoji: meta.emoji,
        key: await deriveChannelKey(space.key, record.id),
        members: [mine],
        createdAt: record.createdAt,
        spaceId: space.id,
        ...(space.profile ? { profile: space.profile } : {}),
        ...(space.role ? { role: space.role } : {})
      });
    } catch { /* not ours to open, or gone since the listing — the next sweep tries again */ }
  }
  return { joined: found, present: new Set(directory.map(r => r.id)) };
}

// ---------- invite links ----------

/**
 * The code an invite is filed under: a hash of the secret that opens it.
 *
 * Deriving it rather than having the relay allocate one means the client can name the object it
 * is about to create, so the URL it signs is one it already knows — and the relay learns a value
 * it cannot walk back to the secret.
 */
export async function inviteCodeFor(secret: string): Promise<string> {
  return (await sha256(`kin-invite-code:${secret}`)).slice(0, 16);
}

/** The secret rides in the fragment, which browsers do not put on the wire. */
export function inviteLink(origin: string, code: string, secret: string): string {
  return `${origin}/#join=${code}.${encodeURIComponent(secret)}`;
}

export function parseInviteLink(source: string): { code: string; secret: string } | null {
  const hash = source.includes("#") ? source.slice(source.indexOf("#") + 1) : source;
  const value = new URLSearchParams(hash).get("join");
  if (!value) return null;
  const at = value.indexOf(".");
  if (at <= 0) return null;
  const code = value.slice(0, at);
  const secret = decodeURIComponent(value.slice(at + 1));
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code) || secret.length < 40) return null;
  return { code, secret };
}

export async function mintInvite(
  identity: LocalIdentity,
  conversation: Conversation,
  options: { role?: InviteRole; ttl?: number; maxUses?: number | null; origin?: string } = {}
): Promise<{ code: string; secret: string; link: string; expiresAt: number }> {
  const secret = inviteSecret();
  const code = await inviteCodeFor(secret);
  const sealed = await sealInvite(code, secret, conversation.key);
  const expiresAt = Date.now() + (options.ttl ?? DEFAULT_INVITE_TTL);
  await createInvite(identity, code, {
    proof: sealed.proof,
    room: {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      ...(conversation.emoji ? { emoji: conversation.emoji } : {}),
      ...(conversation.spaceId ? { spaceId: conversation.spaceId } : {})
    },
    inviter: publicMember(identity),
    role: options.role ?? "guest",
    wrappedKey: sealed.wrappedKey,
    iv: sealed.iv,
    expiresAt,
    maxUses: options.maxUses === undefined ? 1 : options.maxUses
  });
  return { code, secret, link: inviteLink(options.origin ?? location.origin, code, secret), expiresAt };
}

export async function lookUpInvite(code: string): Promise<InvitePreview> {
  return previewInvite(code);
}

/**
 * Walk through an invite link.
 *
 * The room key comes out of the ciphertext the relay was holding, opened with the secret from the
 * fragment; the same secret produces the proof that persuades the relay to put this device on the
 * roster. Both halves have to work, and neither tells the relay anything it could have worked out
 * on its own.
 */
export async function acceptInvite(
  identity: LocalIdentity,
  code: string,
  secret: string,
  preview: InvitePreview,
  profile?: { displayName: string; avatarSeed: string }
): Promise<Conversation> {
  const { proof, roomKey } = await openInvite(code, secret, preview.wrappedKey, preview.iv);
  const card: PublicMember = { ...publicMember(identity), ...(profile ?? {}) };
  const result = await redeemInvite(identity, code, proof, card);
  return {
    id: preview.room.id,
    kind: preview.room.kind,
    title: preview.room.title,
    key: roomKey,
    members: [card, preview.inviter],
    createdAt: Date.now(),
    role: result.role,
    ...(preview.room.emoji ? { emoji: preview.room.emoji } : {}),
    ...(preview.room.spaceId ? { spaceId: preview.room.spaceId } : {}),
    ...(profile ? { profile } : {})
  };
}

// ---------- arriving without a name ----------

const CREATURES = ["Otter", "Fox", "Heron", "Bear", "Wren", "Moth", "Pike", "Hare", "Owl", "Newt", "Crane", "Vole"];
const FACES = ["🦦", "🦊", "🪶", "🐻", "🐦", "🦋", "🐟", "🐰", "🦉", "🦎", "🕊️", "🐹"];

/**
 * A name for somebody who would rather not give one.
 *
 * Anonymous has to still be addressable — a room where three people are all called "Guest" is
 * worse for everyone than one where they are Guest Otter, Guest Wren and Guest Pike — so this
 * picks a creature rather than leaving the field empty.
 */
export function anonymousProfile(): { displayName: string; avatarSeed: string } {
  const at = Math.floor(Math.random() * CREATURES.length);
  return { displayName: `Guest ${CREATURES[at]}`, avatarSeed: `e:${FACES[at]}` };
}

// ---------- arranging what a device holds ----------

export type SpaceNode = {
  space: Conversation;
  channels: Conversation[];
  /** Everything unread anywhere under this space, which is what the sidebar badge counts. */
  unread: number;
  lastMessageAt: number;
};

const activity = (c: Conversation): number => c.lastMessageAt ?? c.createdAt;

/**
 * Sort a flat list of conversations into the shape the sidebar shows.
 *
 * A group with no channels stays exactly what it was before channels existed — one row, no
 * nesting, no hint that a hierarchy is available. That is deliberate: the family case should not
 * pay for the project case, and a space only starts looking like a space once somebody has given
 * it a reason to.
 *
 * A channel whose space this device does not hold comes back as an orphan rather than being
 * dropped, because that is what being invited straight into one channel looks like from inside.
 */
export function spaceTree(conversations: Conversation[]): {
  spaces: SpaceNode[];
  directs: Conversation[];
  orphans: Conversation[];
} {
  const spaces = new Map<string, SpaceNode>();
  const directs: Conversation[] = [];
  const channels: Conversation[] = [];

  for (const c of conversations) {
    if (c.kind === "direct") directs.push(c);
    else if (c.spaceId) channels.push(c);
    else spaces.set(c.id, { space: c, channels: [], unread: c.unread ?? 0, lastMessageAt: activity(c) });
  }

  const orphans: Conversation[] = [];
  for (const channel of channels) {
    const node = spaces.get(channel.spaceId!);
    if (!node) { orphans.push(channel); continue; }
    node.channels.push(channel);
    node.unread += channel.unread ?? 0;
    node.lastMessageAt = Math.max(node.lastMessageAt, activity(channel));
  }

  for (const node of spaces.values()) node.channels.sort((a, b) => activity(b) - activity(a));
  return {
    spaces: [...spaces.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt),
    directs: directs.sort((a, b) => activity(b) - activity(a)),
    orphans: orphans.sort((a, b) => activity(b) - activity(a))
  };
}

/** Can this device do the things only a full member may — invite, add channels, rename? */
export function isFullMember(c: Conversation | null): boolean {
  return !!c && (c.role ?? "member") === "member";
}

/** A viewer came to look. The relay refuses their envelopes; the composer should not offer. */
export function canPost(c: Conversation | null): boolean {
  return !!c && (c.role ?? "member") !== "viewer";
}
