import type { CipherEnvelope, LocalIdentity, PairPackage, PairStatus, PublicMember } from "./types";
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
export async function createRoom(identity: LocalIdentity, id: string, kind: "group" | "direct", title: string, members: PublicMember[]): Promise<void> {
  await signedJson(identity, "PUT", `/api/rooms/${encodeURIComponent(id)}`, { kind, title, members });
}

export async function roomMembers(identity: LocalIdentity, roomId: string): Promise<PublicMember[]> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/members`;
  return signedJson(identity, "GET", path);
}
export async function addRoomMember(identity: LocalIdentity, roomId: string, member: PublicMember): Promise<void> {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/members`;
  await signedJson(identity, "POST", path, member);
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
