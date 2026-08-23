import type { ChannelRecord, CipherEnvelope, InvitePreview, InviteRole, InviteSummary, LocalIdentity, PairPackage, PairStatus, PublicMember } from "./types";
import { sha256, signRequest } from "./crypto";

const base = (import.meta.env.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error((await res.text()) || `${res.status}`);
  return res.json() as Promise<T>;
}

async function signedJson<T>(identity: LocalIdentity, method: string, path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const auth = await signRequest(identity, method, path, body);
  return json<T>(path, { method, headers: { ...auth, "Content-Type": "application/json" }, body: body || undefined });
}

/** Signed, so the relay can tell a real creator from anyone squatting a room id they can derive. */
export async function createRoom(
  identity: LocalIdentity,
  id: string,
  kind: "group" | "direct",
  title: string,
  members: PublicMember[],
  options: { spaceId?: string; keep?: boolean } = {}
): Promise<void> {
  await signedJson(identity, "PUT", `/api/rooms/${encodeURIComponent(id)}`, { kind, title, members, ...options });
}

/**
 * Walk into a channel on the strength of being in its space.
 *
 * The other way in — somebody already inside adding you — needs them online at the moment you
 * arrive. A channel does not need that, because its key was derivable from the space key all
 * along; this just asks the relay to let the roster catch up with what is already true.
 */
export async function joinChannel(identity: LocalIdentity, roomId: string, member: PublicMember): Promise<void> {
  await signedJson(identity, "POST", `/api/rooms/${encodeURIComponent(roomId)}/join`, member);
}

export async function listChannels(identity: LocalIdentity, spaceId: string): Promise<ChannelRecord[]> {
  return signedJson(identity, "GET", `/api/rooms/${encodeURIComponent(spaceId)}/channels`);
}
export async function publishChannel(identity: LocalIdentity, spaceId: string, channel: Omit<ChannelRecord, "createdAt">): Promise<void> {
  await signedJson(identity, "POST", `/api/rooms/${encodeURIComponent(spaceId)}/channels`, channel);
}
export async function unpublishChannel(identity: LocalIdentity, spaceId: string, channelId: string): Promise<void> {
  await signedJson(identity, "DELETE", `/api/rooms/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(channelId)}`);
}

export async function roomMembers(identity: LocalIdentity, roomId: string): Promise<PublicMember[]> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/members`;
  return signedJson(identity, "GET", path);
}
export async function addRoomMember(identity: LocalIdentity, roomId: string, member: PublicMember): Promise<void> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/members`;
  await signedJson(identity, "POST", path, member);
}
/** Evict a device from a room. Removing yourself is how leaving a family works. */
export async function removeRoomMember(identity: LocalIdentity, roomId: string, deviceId: string): Promise<void> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(deviceId)}`;
  await signedJson(identity, "DELETE", path);
}
export async function history(identity: LocalIdentity, roomId: string): Promise<CipherEnvelope[]> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/history`;
  return signedJson(identity, "GET", path);
}

export async function createPair(creator: PublicMember, group: { id: string; title: string }): Promise<{ code: string; creatorToken: string }> {
  return json("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creator, group }) });
}
export async function joinPair(code: string, joiner: PublicMember): Promise<{ status: PairStatus; claimToken: string }> {
  return json(`/api/pair/${encodeURIComponent(code)}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(joiner) });
}
export async function pairStatus(code: string, creatorToken: string): Promise<PairStatus> {
  return json(`/api/pair/${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${creatorToken}` } });
}
export async function completePair(code: string, payload: PairPackage, creatorToken: string): Promise<void> {
  await json(`/api/pair/${encodeURIComponent(code)}/complete`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${creatorToken}` }, body: JSON.stringify(payload) });
}
export async function claimPair(code: string, claimToken: string): Promise<PairPackage> {
  const res = await fetch(`${base}/api/pair/${encodeURIComponent(code)}/claim`, { headers: { Authorization: `Bearer ${claimToken}` } });
  if (res.status === 204) throw new Error("Not ready");
  if (!res.ok) throw new Error((await res.text()) || `${res.status}`);
  return res.json() as Promise<PairPackage>;
}

// ---------- standing invites ----------

/**
 * Mint an invite. `code` is a hash of the secret rather than something the relay allocates, so
 * the path being signed is one the client already knows, and the secret behind it never travels.
 */
export async function createInvite(identity: LocalIdentity, code: string, ticket: {
  proof: string;
  room: { id: string; kind: "group" | "direct"; title: string; emoji?: string; spaceId?: string };
  inviter: PublicMember;
  role: InviteRole;
  wrappedKey: string;
  iv: string;
  expiresAt: number;
  maxUses: number | null;
}): Promise<{ code: string; expiresAt: number; maxUses: number | null }> {
  return signedJson(identity, "PUT", `/api/invite/${encodeURIComponent(code)}`, ticket);
}

export async function previewInvite(code: string): Promise<InvitePreview> {
  return json(`/api/invite/${encodeURIComponent(code)}`);
}

export async function redeemInvite(identity: LocalIdentity, code: string, proof: string, member: PublicMember): Promise<{
  room: { id: string; kind: "group" | "direct"; title: string; spaceId?: string };
  role: InviteRole;
}> {
  return signedJson(identity, "POST", `/api/invite/${encodeURIComponent(code)}/redeem`, { proof, member });
}

export async function revokeInvite(identity: LocalIdentity, code: string, member: PublicMember): Promise<void> {
  await signedJson(identity, "POST", `/api/invite/${encodeURIComponent(code)}/revoke`, { member });
}

export async function listInvites(identity: LocalIdentity, roomId: string): Promise<InviteSummary[]> {
  return signedJson(identity, "GET", `/api/rooms/${encodeURIComponent(roomId)}/invites`);
}

/**
 * Take a message off the relay as well as off the screen.
 *
 * A delete has always been a tombstone every client folds in, which is enough in an ordinary room
 * because the ciphertext lapses within the week anyway. A kept room has no such deadline, so
 * without this a retraction there left the message on the relay permanently.
 */
export async function dropEnvelope(identity: LocalIdentity, roomId: string, messageId: string): Promise<void> {
  await signedJson(identity, "DELETE", `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`);
}

/** And its attachment, which is what actually gives a full album its space back. */
export async function dropEncryptedFile(identity: LocalIdentity, roomId: string, fileId: string): Promise<void> {
  await signedJson(identity, "DELETE", `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`);
}

export async function sendEnvelope(roomId: string, envelope: CipherEnvelope): Promise<void> {
  await json(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope)
  });
}

export async function uploadEncryptedFile(identity: LocalIdentity, roomId: string, fileId: string, ciphertext: Uint8Array<ArrayBuffer>, contentHash: string): Promise<void> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`;
  const auth = await signRequest(identity, "PUT", path, "", contentHash);
  const res = await fetch(`${base}${path}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: ciphertext });
  if (!res.ok) throw new Error(await res.text());
}
export async function downloadEncryptedFile(identity: LocalIdentity, roomId: string, fileId: string): Promise<ArrayBuffer> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`;
  const auth = await signRequest(identity, "GET", path, "");
  const res = await fetch(`${base}${path}`, { headers: auth });
  if (!res.ok) throw new Error(await res.text());
  return res.arrayBuffer();
}

export async function registerPush(identity: LocalIdentity, roomId: string, subscription: PushSubscription): Promise<void> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/push`;
  await signedJson(identity, "POST", path, subscription.toJSON());
}
export async function relayConfig(): Promise<{ vapidPublicKey?: string }> {
  return json("/api/config");
}

export async function websocketUrl(identity: LocalIdentity, roomId: string): Promise<string> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/ws`;
  const bodyHash = await sha256("");
  const auth = await signRequest(identity, "GET", path, "", bodyHash);
  const origin = base || location.origin;
  const url = new URL(`${origin}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("device", identity.deviceId);
  url.searchParams.set("time", auth["X-Kin-Time"]);
  url.searchParams.set("nonce", auth["X-Kin-Nonce"]);
  url.searchParams.set("body", auth["X-Kin-Body"]);
  url.searchParams.set("sig", auth["X-Kin-Signature"]);
  return url.toString();
}
