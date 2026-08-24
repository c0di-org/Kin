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
  /** Our own role, as the relay recorded it — what the UI hides or offers on the strength of. */
  role?: MemberRole;
  /**
   * Messages and attachments here are kept until somebody deletes them, instead of expiring
   * after seven days. What makes an album an album.
   */
  keep?: boolean;
  lastMessageAt?: number;
  lastPreview?: string;
  lastPreviewSender?: string;
  lastReadAt?: number;
  unread?: number;
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
  event?: {
    /**
     * `pin`, `check`, `additem` and `removeitem` are folded at render time exactly the way
     * reactions and deletions already are: the relay never learns that a list gained a line, and
     * anybody replaying the room's history arrives at the same list we are looking at.
     */
    kind: "edit" | "delete" | "reaction" | "pin" | "check" | "additem" | "removeitem";
    targetId: string;
    value?: string;
    /**
     * The state being asserted, rather than a flip, so two people ticking the same line at the
     * same moment agree afterwards instead of cancelling each other out.
     */
    done?: boolean;
    /** The line being added, for `additem`. */
    item?: ListItem;
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
