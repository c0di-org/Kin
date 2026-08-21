export type PublicMember = {
  deviceId: string;
  displayName: string;
  avatarSeed: string;
  dhPublicJwk: JsonWebKey;
  signPublicJwk: JsonWebKey;
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
  lastMessageAt?: number;
  lastPreview?: string;
  lastPreviewSender?: string;
  lastReadAt?: number;
  unread?: number;
  /** Device ids whose keys changed under us — a warning that outlives a reload. */
  keyAlerts?: string[];
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

export type ChatPayload = {
  type: "text" | "file" | "event";
  text?: string;
  attachment?: AttachmentPayload;
  replyTo?: string;
  event?: { kind: "edit" | "delete" | "reaction"; targetId: string; value?: string };
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
  safetyCode: string;
};
