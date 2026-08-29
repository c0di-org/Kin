/**
 * What everyone in a room may do in it.
 *
 * `member` is the default and is what a family is made of. `guest` is somebody who arrived on a
 * link: they can read and post, but cannot hand out invites of their own, so a link you shared
 * with one person cannot quietly become a link they shared with ten. `viewer` can read and
 * react but not post — the "come and look at the photos" case.
 */
export type MemberRole = "member" | "guest" | "viewer";

export type PublicMember = {
  deviceId: string;
  displayName: string;
  avatarSeed: string;
  dhPublicJwk: JsonWebKey;
  signPublicJwk: JsonWebKey;
  role?: MemberRole;
};

export type LocalIdentity = PublicMember & {
  dhPrivateJwk: JsonWebKey;
  signPrivateJwk: JsonWebKey;
};

export type Conversation = {
  id: string;
  kind: "group" | "direct";
  title: string;
  key: string;
  members: PublicMember[];
  createdAt: number;
  emoji?: string;
  /**
   * The space this is a channel of. A conversation without one is a space in its own right —
   * which is what every group was before channels existed, and what a brand new group still is.
   */
  spaceId?: string;
  /** How this device is known *here*, when that should not be how it is known everywhere. */
  profile?: { displayName: string; avatarSeed: string };
  /** When the name, face or colour this device is showing was last decided anywhere. */
  metaAt?: number;
  /** Our own role, as the relay recorded it — what the UI hides or offers on the strength of. */
  role?: MemberRole;
  /**
   * The tone this place is painted in, from `lib/tones.ts`. Absent is Kin's own candy palette.
   *
   * A name and a face tell you which room you are in once you have read them; a colour tells you
   * before you have. It is per-conversation and travels with the rename, so everybody's Beach Trip
   * is the same orange.
   */
  color?: string;
  /**
   * The relay stopped listing this device in this room. Local only, never written by anything but
   * a roster we asked for, and reversible the moment we are listed again.
   *
   * Nothing is deleted on the strength of it — a relay that could make a family's history vanish
   * by claiming a removal is exactly what the sync layer refuses to allow. All it does is stop the
   * composer pretending a message will ever arrive.
   */
  removedAt?: number;
  /**
   * Messages and attachments here are kept until somebody deletes them, instead of expiring
   * after seven days. What makes an album an album.
   */
  keep?: boolean;
  /**
   * The room this person keeps for themselves — notes, links, photos parked for later.
   *
   * A flag rather than a third `kind`, because underneath it is an ordinary group with one
   * member in it and everything a room can do it can do: attachments, lists, pins, the gallery,
   * a socket to this person's other screens. What the flag buys is the handful of places where
   * "a group of one" would otherwise be drawn as a family waiting for somebody to arrive —
   * invite cards, rosters, "leave this family" — and the ordering rules that keep it out of the
   * way of the rooms other people are in.
   */
  self?: true;
  lastMessageAt?: number;
  lastPreview?: string;
  lastPreviewSender?: string;
  lastReadAt?: number;
  unread?: number;
  /**
   * Something happened here that is not a message: a list ticked, a rename, somebody arriving.
   *
   * Kept apart from `unread` because that number is also the app badge, and a supermarket trip
   * spent ticking off a shared list should not come home claiming twelve unread messages.
   */
  nudge?: boolean;
  /** Device ids whose keys changed under us — a warning that outlives a reload. */
  keyAlerts?: string[];
  /**
   * Cards of people who have left, kept only so their messages still verify.
   *
   * The roster is the relay's to report, and it is not signed by anybody — so a relay that felt
   * like it could drop a name from it, and every message that person ever sent would stop
   * verifying and silently vanish from a thread we already hold. What somebody said does not
   * become unsaid when they leave, so their key stays here after their row goes.
   */
  pastMembers?: PublicMember[];
};

export type AttachmentPayload = {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  iv: string;
  key: string;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  thumb?: string;
};

/** One line of a shared list, as the person who wrote it typed it. */
export type ListItem = { id: string; text: string };

/** A list everybody in the room can tick off: groceries, packing, chores. */
export type ListPayload = { title: string; items: ListItem[] };

export type ChatPayload = {
  type: "text" | "file" | "event" | "list";
  text?: string;
  attachment?: AttachmentPayload;
  list?: ListPayload;
  replyTo?: string;
  /**
   * Where a copy kept in your own room came from, so a line saved out of a conversation still
   * says which conversation. Only ever set on the copy — keeping something does not touch, mark
   * or notify the message it was taken from.
   */
  kept?: { from: string };
  event?: {
    /**
     * `pin`, `check`, `additem` and `removeitem` are folded at render time exactly the way
     * reactions and deletions already are: the relay never learns that a list gained a line, and
     * anybody replaying the room's history arrives at the same list we are looking at.
     *
     * `meta`, `joined` and `left` are the room talking about itself. They fold the same way, and
     * they are the reason a rename is comprehensible: a group that quietly becomes something else
     * overnight is unsettling in a way that "Dad renamed this to Beach Trip" is not.
     */
    kind: "edit" | "delete" | "reaction" | "pin" | "check" | "additem" | "removeitem" | "meta" | "joined" | "left";
    targetId: string;
    value?: string;
    /**
     * The state being asserted, rather than a flip, so two people ticking the same line at the
     * same moment agree afterwards instead of cancelling each other out.
     */
    done?: boolean;
    /** The line being added, for `additem` — and carried on `check` and `removeitem` too, so a
     *  preview line can say *which* thing was ticked without holding the list it belongs to. */
    item?: ListItem;
    /** What a `meta` event changes. Each field is last-write-wins on its own, so two people
     *  renaming and recolouring at the same moment both get their way. */
    meta?: { title?: string; emoji?: string; color?: string };
  };
};

export type CipherEnvelope = {
  kind: "message";
  id: string;
  conversationId: string;
  senderDeviceId: string;
  createdAt: number;
  expiresAt: number;
  iv: string;
  ciphertext: string;
  signature: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  createdAt: number;
  payload: ChatPayload;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Set once a delete event for this message has been folded in and its contents dropped. */
  deletedAt?: number;
  reactions?: Record<string, string[]>;
};

export type PairStatus = {
  code: string;
  creator: PublicMember;
  group: { id: string; title: string };
  joiner?: PublicMember;
  complete?: boolean;
};

export type PairPackage = {
  creator: PublicMember;
  group: { id: string; title: string; wrappedKey: string; wrapIv: string };
};

/** What a channel calls itself, sealed under the space key so only the space can read it. */
export type ChannelMeta = {
  title: string;
  emoji: string;
  color?: string;
  /**
   * When this name was decided, by the clock of whoever decided it.
   *
   * The directory and the message stream both carry a channel's name, and a device that was
   * asleep reads them in whichever order it happens to. Without a stamp the sweep would happily
   * paint an old name back over a rename it had already folded in. Sealed with the rest of it, so
   * the relay learns nothing from it either.
   */
  at?: number;
};

/** A channel as the relay holds it: an id, and a name only the space's members can read. */
export type ChannelRecord = {
  id: string;
  blob: string;
  iv: string;
  createdAt: number;
};

export type InviteRole = Exclude<MemberRole, "member">;

/** What an invite link opens onto, before the joiner has decided to walk through it. */
export type InvitePreview = {
  code: string;
  room: { id: string; kind: "group" | "direct"; title: string; emoji?: string; spaceId?: string };
  inviter: PublicMember;
  role: InviteRole;
  wrappedKey: string;
  iv: string;
  expiresAt: number;
  remaining: number | null;
};

export type InviteSummary = {
  code: string;
  role: InviteRole;
  createdAt: number;
  expiresAt: number;
  uses: number;
  maxUses: number | null;
  revoked?: boolean;
};

/** How a link this device minted is getting on, as the relay sees it. */
export type DeviceLinkStatus = { claimed: boolean; expiresAt: number };

/**
 * What travels to a second device of the same person, sealed under the link secret.
 *
 * Only the identity, deliberately. The rooms follow separately over the sync room — which is the
 * same path they take every day afterwards, so a device that has just linked and a device that
 * has been linked for a month are on exactly one code path rather than two.
 */
export type DeviceLinkBundle = {
  v: 1;
  identity: LocalIdentity;
  /** So the second screen opens into the same place the first one does, before anything is set up. */
  home: string | null;
  at: number;
};

/** One room, as a person's own devices describe it to each other. */
export type SnapshotRoom = {
  id: string;
  kind: "group" | "direct";
  title: string;
  key: string;
  createdAt: number;
  emoji?: string;
  spaceId?: string;
  color?: string;
  keep?: boolean;
  role?: MemberRole;
  metaAt?: number;
  profile?: { displayName: string; avatarSeed: string };
  /**
   * The other person, for a direct chat only.
   *
   * A group's roster is pulled from the relay the moment the room connects, so carrying it here
   * would be duplicating something already on its way. A direct chat has no roster to pull — it
   * is two device keys and a derivation — so its peer has to travel.
   */
  peer?: PublicMember;
};

/**
 * One device's picture of what this person is in, for their other devices to read.
 *
 * A full list rather than a diff, because a device that has been off for a fortnight has no diff
 * to catch up on — and because two devices both writing full pictures converge, where two
 * devices both writing diffs need to agree about order.
 *
 * `gone` is the exception, and it is why leaving works: absence from `rooms` cannot mean
 * "removed", or a device that had joined something its sibling has not heard about yet would
 * lose it. A room is only dropped when it is named here, with the moment it was left — so a room
 * left on Tuesday and rejoined on Friday stays.
 */
export type DeviceSnapshot = {
  v: 1;
  at: number;
  profile: { displayName: string; avatarSeed: string; at: number };
  home: string | null;
  rooms: SnapshotRoom[];
  gone: Record<string, number>;
};
