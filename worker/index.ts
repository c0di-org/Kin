import { DurableObject } from "cloudflare:workers";
import { b64urlToBytes, bytesToB64url, sendPushNotification, type PushSubscriptionJSON } from "./webpush";

type MemberRole = "member" | "guest" | "viewer";

type Member = {
  deviceId: string;
  displayName: string;
  avatarSeed: string;
  dhPublicJwk: JsonWebKey;
  signPublicJwk: JsonWebKey;
  role?: MemberRole;
};

type Envelope = {
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

type FileRecord = { fileId: string; key: string; expiresAt: number };
type RoomMeta = {
  id: string;
  kind: "group" | "direct";
  title: string;
  createdAt: number;
  /** Set on a channel: the room whose roster decides who may walk into this one. */
  spaceId?: string;
  /** Hold messages and attachments until deleted, rather than sweeping them after a week. */
  keep?: boolean;
};
/** A channel's name, encrypted under the space key. The relay routes these and cannot read them. */
type ChannelRecord = { id: string; blob: string; iv: string; createdAt: number };
type InviteSummary = {
  code: string;
  role: Exclude<MemberRole, "member">;
  createdAt: number;
  expiresAt: number;
  uses: number;
  maxUses: number | null;
  revoked?: boolean;
};
type InviteRecord = {
  code: string;
  proof: string;
  room: { id: string; kind: "group" | "direct"; title: string; spaceId?: string };
  inviter: Member;
  role: Exclude<MemberRole, "member">;
  wrappedKey: string;
  iv: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number | null;
  uses: number;
  revoked?: boolean;
};
type PairRecord = { code: string; creator: Member; creatorToken: string; group: { id: string; title: string }; joiner?: Member; joinerToken?: string; complete?: boolean };
type PairPackage = { creator: Member; group: { id: string; title: string; wrappedKey: string; wrapIv: string }; safetyCode: string };

type Env = {
  ROOMS: DurableObjectNamespace<ConversationRoom>;
  PAIRS: DurableObjectNamespace<PairingSession>;
  INVITES: DurableObjectNamespace<InviteTicket>;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

const enc = new TextEncoder();
const MAX_SKEW = 5 * 60_000;
const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const PAIR_TTL = 10 * 60 * 1000;
const MAX_FILE = 25 * 1024 * 1024;
const INVITE_MAX_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_CHANNELS = 64;
/**
 * What a kept room may hold. Ordinary rooms are self-limiting — everything in them expires after
 * a week — so these caps exist only for rooms that have opted out of that, where without them one
 * album could grow until it was the relay's problem rather than its owner's.
 */
const KEEP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const KEEP_MAX_MESSAGES = 20_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function error(message: string, status = 400): Response {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}
function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function code(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
function envelopeText(envelope: Envelope): string {
  return [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
}
async function sha256b64(bytes: Uint8Array): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
}
/** The client half of this lives in `directConversation` (src/lib/crypto.ts); the two must agree. */
async function directRoomId(a: string, b: string): Promise<string> {
  return (await sha256b64(enc.encode(`kin-direct-room:${[a, b].sort().join(":")}`))).slice(0, 32);
}
/** Read a stream into memory, giving up past `limit` rather than trusting a size nobody declared. */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function sameJwk(a: JsonWebKey | undefined, b: JsonWebKey | undefined): boolean {
  if (!a || !b) return false;
  return a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;
}
/**
 * Verify an X-Kin-* signature against a member card the request itself supplies.
 *
 * The room object checks signatures against its roster; an invite has no roster to check against,
 * so what is provable here is narrower: that whoever sent this holds the private key for the card
 * they are presenting, and that the body has not been swapped since it was signed. Who that card
 * belongs to is decided elsewhere — by the invite proof on redemption, and by the room's own
 * roster once they are in it.
 *
 * `burnNonce` is the caller's replay guard; returning false from it rejects the request.
 */
async function verifySignedBy(
  request: Request,
  bodyHash: string,
  member: Member,
  burnNonce?: (deviceId: string, nonce: string, signedAt: number) => Promise<boolean>
): Promise<boolean> {
  const device = request.headers.get("X-Kin-Device");
  const time = request.headers.get("X-Kin-Time");
  const nonce = request.headers.get("X-Kin-Nonce");
  const claimedHash = request.headers.get("X-Kin-Body");
  const sig = request.headers.get("X-Kin-Signature");
  if (!device || !time || !nonce || !claimedHash || !sig) return false;
  if (device !== member.deviceId) return false;
  if (Math.abs(Date.now() - Number(time)) > MAX_SKEW) return false;
  if (claimedHash !== bodyHash) return false;
  const path = new URL(request.url).pathname;
  const canonical = [request.method.toUpperCase(), path, time, nonce, claimedHash].join("\n");
  if (!(await verifyEcdsa(member.signPublicJwk, sig, canonical))) return false;
  if (burnNonce && !(await burnNonce(device, nonce, Number(time)))) return false;
  return true;
}

async function verifyEcdsa(jwk: JsonWebKey, signature: string, text: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(signature), enc.encode(text));
  } catch { return false; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });

    if (url.pathname === "/api/pair" && request.method === "POST") {
      const body = await request.json() as { creator: Member; group: { id: string; title: string } };
      for (let i = 0; i < 4; i++) {
        const pairCode = code(); const creatorToken = token();
        const stub = env.PAIRS.get(env.PAIRS.idFromName(pairCode));
        const res = await stub.fetch(new Request(`https://pair.internal/${pairCode}/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairCode, creatorToken, ...body }) }));
        if (res.ok) return json({ code: pairCode, creatorToken });
        if (res.status !== 409) return res;
      }
      return error("Could not allocate code", 503);
    }

    const pairMatch = url.pathname.match(/^\/api\/pair\/([A-Z0-9]+)(?:\/(join|complete|claim))?$/i);
    if (pairMatch) {
      const pairCode = pairMatch[1].toUpperCase(); const action = pairMatch[2] ?? "status";
      const stub = env.PAIRS.get(env.PAIRS.idFromName(pairCode));
      const body = request.method === "GET" ? undefined : await request.text();
      return stub.fetch(new Request(`https://pair.internal/${pairCode}/${action}`, { method: request.method, headers: request.headers, body }));
    }

    // An invite code is a hash of the secret that opens it, so the client can name its own
    // object without the relay allocating anything — and the request path stays exactly what the
    // client signed, which is what the invite object verifies against.
    const inviteMatch = url.pathname.match(/^\/api\/invite\/([A-Za-z0-9_-]{8,64})(?:\/(redeem|revoke))?$/);
    if (inviteMatch) {
      return env.INVITES.get(env.INVITES.idFromName(inviteMatch[1])).fetch(request);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1]);
      return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
    }

    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return response;
  }
};

export class PairingSession extends DurableObject<Env> {
  private status(record: PairRecord) { const { creatorToken: _a, joinerToken: _b, ...safe } = record; return safe; }
  private bearer(request: Request): string | null { const value = request.headers.get("Authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : null; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean); const pairCode = parts[0]; const action = parts[1] ?? "status"; const now = Date.now();
    const record = await this.ctx.storage.get<PairRecord>("record");
    if (action === "create" && request.method === "POST") {
      if (record) return error("Code exists", 409);
      const body = await request.json() as PairRecord; await this.ctx.storage.put("record", body); await this.ctx.storage.setAlarm(now + PAIR_TTL); return json({ ok: true });
    }
    if (!record || record.code !== pairCode) return error("Pairing expired", 404);
    if (action === "status" && request.method === "GET") {
      if (this.bearer(request) !== record.creatorToken) return error("Unauthorized", 401); return json(this.status(record));
    }
    if (action === "join" && request.method === "POST") {
      const joiner = await request.json() as Member;
      if (record.joiner && record.joiner.deviceId !== joiner.deviceId) return error("Code already used", 409);
      const joinerToken = record.joinerToken ?? token(); const next = { ...record, joiner, joinerToken }; await this.ctx.storage.put("record", next); return json({ status: this.status(next), claimToken: joinerToken });
    }
    if (action === "complete" && request.method === "POST") {
      if (this.bearer(request) !== record.creatorToken) return error("Unauthorized", 401); if (!record.joiner) return error("No joiner", 409);
      const pkg = await request.json() as PairPackage; await this.ctx.storage.put("package", pkg); await this.ctx.storage.put("record", { ...record, complete: true }); return json({ ok: true });
    }
    if (action === "claim" && request.method === "GET") {
      if (!record.joinerToken || this.bearer(request) !== record.joinerToken) return error("Unauthorized", 401);
      const pkg = await this.ctx.storage.get<PairPackage>("package"); if (!pkg) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); return json(pkg);
    }
    return error("Not found", 404);
  }
  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}

/**
 * A standing invite: a link that works whether or not the person who made it is around.
 *
 * The old pairing flow needed both devices online at once — the inviter sat polling, wrapped the
 * room key to the joiner's public key the moment they appeared, and posted it. That is a fine
 * ceremony when you are stood next to someone, and useless for "here's a link, look whenever".
 *
 * So the key is wrapped up front instead, under a secret the relay never sees: the client seals
 * the room key with a key derived from a random secret, hands the relay only the ciphertext, and
 * puts the secret in the URL fragment, which browsers do not send to servers. The relay ends up
 * holding something it cannot open, addressed by a code it did allocate.
 *
 * Knowing the code alone must not be enough to get in — the relay knows every code it issued —
 * so redemption also has to present `proof`, a hash of the secret that the relay stores but
 * cannot invert. Whoever holds the link can enrol; whoever holds only the relay cannot.
 */
export class InviteTicket extends DurableObject<Env> {
  private async record(): Promise<InviteRecord | undefined> {
    return this.ctx.storage.get<InviteRecord>("record");
  }

  /** Live means: exists, not revoked, not expired, and not already spent. */
  private live(record: InviteRecord | undefined, now = Date.now()): record is InviteRecord {
    if (!record || record.revoked) return false;
    if (record.expiresAt <= now) return false;
    if (record.maxUses !== null && record.uses >= record.maxUses) return false;
    return true;
  }

  private remaining(record: InviteRecord): number | null {
    return record.maxUses === null ? null : Math.max(0, record.maxUses - record.uses);
  }

  /** Replay guard, mirroring the room object's: a nonce is good exactly once. */
  private async claimNonce(deviceId: string, nonce: string, signedAt: number): Promise<boolean> {
    const key = `nonce:${deviceId}:${nonce}`;
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, signedAt + MAX_SKEW);
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/invite\/([A-Za-z0-9_-]{8,64})(?:\/(redeem|revoke))?$/);
    if (!match) return error("Bad invite path", 404);
    const inviteCode = match[1];
    const action = match[2] ?? (request.method === "PUT" ? "create" : "preview");
    const burn = (d: string, n: string, t: number) => this.claimNonce(d, n, t);
    const now = Date.now();
    const record = await this.record();

    if (action === "create" && request.method === "PUT") {
      if (record) return error("Code exists", 409);
      const bodyText = await request.text();
      let body: Omit<InviteRecord, "code" | "uses" | "createdAt">;
      try { body = JSON.parse(bodyText); } catch { return error("Invalid body"); }
      if (!body?.proof || !body.wrappedKey || !body.iv || !body.room?.id || !body.inviter?.deviceId) {
        return error("Invalid invite");
      }
      // Signed by the inviter as the member card they are presenting, which is the same shape of
      // claim room creation makes: the roster lives in another object, so what is checkable here
      // is that a real device with these keys asked for this.
      const signed = await verifySignedBy(request, await sha256b64(enc.encode(bodyText)), body.inviter, burn);
      if (!signed) return error("Unauthorized", 401);
      const expiresAt = Math.min(Number(body.expiresAt) || 0, now + INVITE_MAX_TTL);
      if (expiresAt <= now) return error("Invite would already be expired");
      const maxUses = body.maxUses === null ? null : Math.max(1, Math.min(500, Number(body.maxUses) || 1));
      const role: Exclude<MemberRole, "member"> = body.role === "viewer" ? "viewer" : "guest";
      const next: InviteRecord = {
        code: inviteCode,
        proof: String(body.proof),
        room: {
          id: String(body.room.id),
          kind: body.room.kind === "direct" ? "direct" : "group",
          title: String(body.room.title ?? "").slice(0, 80),
          ...(body.room.spaceId ? { spaceId: String(body.room.spaceId) } : {})
        },
        inviter: body.inviter,
        role,
        wrappedKey: String(body.wrappedKey),
        iv: String(body.iv),
        createdAt: now,
        expiresAt,
        maxUses,
        uses: 0
      };
      // The room must exist and the inviter must be a full member of it. Asked of the room rather
      // than read off the request, because the request is the inviter's to write: otherwise anyone
      // could mint invites to a room they have never been near, and a guest could mint them to one
      // they were themselves only invited into.
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(next.room.id));
      const standing = await room.memberRole(next.inviter.deviceId);
      if (!standing) return error("Not a member of that room", 403);
      if (standing !== "member") return error("Only a full member can invite", 403);

      await this.ctx.storage.put("record", next);
      await this.ctx.storage.setAlarm(expiresAt);
      // Mirrored onto the room so its members can see what links are outstanding and kill one.
      await room.noteInvite({ code: inviteCode, role, createdAt: now, expiresAt, maxUses, uses: 0 });
      return json({ code: inviteCode, expiresAt, maxUses }, 201);
    }

    if (!record || record.code !== inviteCode) return error("This invite has expired", 404);

    if (action === "preview" && request.method === "GET") {
      if (!this.live(record, now)) return error("This invite has expired", 410);
      const { proof: _proof, ...safe } = record;
      return json({ ...safe, remaining: this.remaining(record) });
    }

    if (action === "redeem" && request.method === "POST") {
      const bodyText = await request.text();
      let body: { proof?: string; member?: Member };
      try { body = JSON.parse(bodyText); } catch { return error("Invalid body"); }
      if (!body?.member?.deviceId || !body.member.signPublicJwk || !body.member.dhPublicJwk) {
        return error("Invalid member");
      }
      const signed = await verifySignedBy(request, await sha256b64(enc.encode(bodyText)), body.member, burn);
      if (!signed) return error("Unauthorized", 401);
      if (!this.live(record, now)) return error("This invite has expired", 410);
      // The check the whole design rests on: the relay stores every code it hands out, so without
      // this, holding the relay's own data would be enough to join any room it relays for.
      if (body.proof !== record.proof) return error("This invite is not valid", 403);

      const member: Member = {
        deviceId: body.member.deviceId,
        displayName: String(body.member.displayName ?? "").slice(0, 64),
        avatarSeed: String(body.member.avatarSeed ?? "").slice(0, 64),
        dhPublicJwk: body.member.dhPublicJwk,
        signPublicJwk: body.member.signPublicJwk,
        role: record.role
      };
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(record.room.id));
      const enrolled = await room.enrol(member);
      if (!enrolled.ok) return error(enrolled.reason ?? "Could not join", 409);

      // Counted only once per device, so that reopening the link on the same phone — which is
      // what happens every time someone taps it again — does not burn a use of a one-use invite.
      if (!(await this.ctx.storage.get(`used:${member.deviceId}`))) {
        await this.ctx.storage.put(`used:${member.deviceId}`, now);
        await this.ctx.storage.put("record", { ...record, uses: record.uses + 1 });
      }
      return json({ ok: true, room: record.room, role: record.role });
    }

    if (action === "revoke" && request.method === "POST") {
      // Any member of the room may kill a link, not only whoever made it — the person who needs
      // it dead is whoever notices it got out, and that is not reliably the person who shared it.
      const bodyText = await request.text();
      let body: { member?: Member };
      try { body = JSON.parse(bodyText); } catch { return error("Invalid body"); }
      if (!body?.member?.deviceId) return error("Invalid member");
      const signed = await verifySignedBy(request, await sha256b64(enc.encode(bodyText)), body.member, burn);
      if (!signed) return error("Unauthorized", 401);
      const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(record.room.id));
      if (!(await room.memberRole(body.member.deviceId))) return error("Not a member of that room", 403);
      await this.ctx.storage.put("record", { ...record, revoked: true });
      await this.env.ROOMS.get(this.env.ROOMS.idFromName(record.room.id)).markInviteRevoked(inviteCode);
      return json({ ok: true });
    }

    return error("Not found", 404);
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}

export class ConversationRoom extends DurableObject<Env> {
  private async meta(): Promise<RoomMeta | undefined> {
    return this.ctx.storage.get<RoomMeta>("meta");
  }
  private async member(deviceId: string): Promise<Member | undefined> {
    return this.ctx.storage.get<Member>(`member:${deviceId}`);
  }
  private async allMembers(): Promise<Member[]> {
    const rows = await this.ctx.storage.list<Member>({ prefix: "member:" });
    return [...rows.values()];
  }

  /**
   * What this device is on our roster, or null if it is not on it at all.
   *
   * Called over RPC by other objects: by a channel deciding whether somebody may walk in — that
   * answer lives in the space's roster, not the channel's — and by an invite deciding whether
   * whoever is minting it is entitled to. Both need the standing, not just the presence, so this
   * returns the role rather than a yes.
   */
  async memberRole(deviceId: string): Promise<MemberRole | null> {
    const member = await this.member(deviceId);
    return member ? (member.role ?? "member") : null;
  }

  /**
   * Add a member on an invite's say-so, over RPC from the invite object.
   *
   * This is the one path into a room that does not require already being in it, which is exactly
   * what a link invite is. The authorisation happened in the invite object — it checked the proof
   * that only the link holder has — so what is left here is the same key-immutability rule every
   * other write obeys, plus a refusal to quietly change the standing of somebody already inside.
   */
  async enrol(member: Member): Promise<{ ok: boolean; reason?: string }> {
    const meta = await this.meta();
    if (!meta) return { ok: false, reason: "That room is gone" };
    const existing = await this.member(member.deviceId);
    if (existing) {
      if (!sameJwk(existing.signPublicJwk, member.signPublicJwk)) return { ok: false, reason: "Device keys are immutable" };
      if (!sameJwk(existing.dhPublicJwk, member.dhPublicJwk)) return { ok: false, reason: "Device keys are immutable" };
      // Already in, and possibly in more fully than this link would grant. Redeeming a guest link
      // for a room you are already a full member of must not demote you.
      return { ok: true };
    }
    if ((await this.allMembers()).length >= 256) return { ok: false, reason: "That room is full" };
    await this.ctx.storage.put(`member:${member.deviceId}`, member);
    this.broadcast({ kind: "member", member });
    return { ok: true };
  }

  /** Record an invite against the room so its members can see and revoke what is outstanding. */
  async noteInvite(summary: InviteSummary): Promise<void> {
    await this.ctx.storage.put(`invite:${summary.code}`, summary);
  }

  async markInviteRevoked(inviteCode: string): Promise<void> {
    const existing = await this.ctx.storage.get<InviteSummary>(`invite:${inviteCode}`);
    if (existing) await this.ctx.storage.put(`invite:${inviteCode}`, { ...existing, revoked: true });
  }

  private async listInvites(): Promise<Response> {
    const rows = await this.ctx.storage.list<InviteSummary>({ prefix: "invite:" });
    const now = Date.now();
    return json([...rows.values()].filter(x => !x.revoked && x.expiresAt > now));
  }

  /**
   * The channel directory: which channels this space has, under names only its members can read.
   *
   * It lives here rather than in the message stream because the message stream expires. Someone
   * who joins a space in its second month has to arrive to the same set of channels as everybody
   * else, and a "channel created" message from six weeks ago is long gone by then.
   */
  private async listChannels(): Promise<Response> {
    const rows = await this.ctx.storage.list<ChannelRecord>({ prefix: "channel:" });
    return json([...rows.values()].sort((a, b) => a.createdAt - b.createdAt));
  }

  private async putChannel(body: string): Promise<Response> {
    let incoming: ChannelRecord;
    try { incoming = JSON.parse(body); } catch { return error("Invalid body"); }
    if (!incoming?.id || !incoming.blob || !incoming.iv) return error("Invalid channel");
    const existing = await this.ctx.storage.get<ChannelRecord>(`channel:${incoming.id}`);
    if (!existing) {
      const count = (await this.ctx.storage.list({ prefix: "channel:" })).size;
      if (count >= MAX_CHANNELS) return error("That is as many channels as a space can hold", 409);
    }
    const record: ChannelRecord = {
      id: String(incoming.id).slice(0, 64),
      blob: String(incoming.blob).slice(0, 4096),
      iv: String(incoming.iv).slice(0, 64),
      createdAt: existing?.createdAt ?? Date.now()
    };
    await this.ctx.storage.put(`channel:${record.id}`, record);
    this.broadcast({ kind: "channel", channel: record });
    return json({ ok: true });
  }

  private async deleteChannel(channelId: string): Promise<Response> {
    await this.ctx.storage.delete(`channel:${channelId}`);
    this.broadcast({ kind: "channel-removed", channelId });
    return json({ ok: true });
  }

  /**
   * Join a channel on the strength of being in its space.
   *
   * Every other way into a room needs to already be in it or to hold an invite. A channel needs
   * neither, because its key is derived from the space key: anybody who can read the space can
   * already read the channel, and making them wait for someone to add them by hand would be
   * ceremony over a door that is not locked. So the channel asks the space whether this device is
   * one of theirs, and lets them in if it is.
   */
  private async joinAsSpaceMember(request: Request, meta: RoomMeta, body: string): Promise<Response> {
    if (!meta.spaceId) return error("This room is not a channel", 403);
    let incoming: Member;
    try { incoming = JSON.parse(body); } catch { return error("Invalid body"); }
    if (!incoming?.deviceId || !incoming.signPublicJwk || !incoming.dhPublicJwk) return error("Invalid member");
    if (!(await verifySignedBy(request, await sha256b64(enc.encode(body)), incoming, (d, n, t) => this.claimNonce(d, n, t)))) {
      return error("Unauthorized", 401);
    }
    // Whatever they are in the space, they are in the channel — a guest of the space stays a
    // guest here, rather than the channel taking the client's word for its own standing.
    const space = this.env.ROOMS.get(this.env.ROOMS.idFromName(meta.spaceId));
    const standing = await space.memberRole(incoming.deviceId);
    if (!standing) return error("Not a member of this space", 403);
    const result = await this.enrol({
      deviceId: incoming.deviceId,
      displayName: String(incoming.displayName ?? "").slice(0, 64),
      avatarSeed: String(incoming.avatarSeed ?? "").slice(0, 64),
      dhPublicJwk: incoming.dhPublicJwk,
      signPublicJwk: incoming.signPublicJwk,
      role: standing
    });
    if (!result.ok) return error(result.reason ?? "Could not join", 409);
    return json(await this.meta());
  }

  /**
   * Burn a nonce, refusing one we have already seen. Without this a signed request can be
   * replayed freely for the whole MAX_SKEW window, which for POSTs means replaying the write.
   */
  private async claimNonce(deviceId: string, nonce: string, signedAt: number): Promise<boolean> {
    const key = `nonce:${deviceId}:${nonce}`;
    if (await this.ctx.storage.get(key)) return false;
    const expiresAt = signedAt + MAX_SKEW;
    await this.ctx.storage.put(key, expiresAt);
    await this.scheduleSweep(expiresAt);
    return true;
  }

  /**
   * Verify the X-Kin-* signature over a request. `bodyHash` is the SHA-256 the caller has
   * computed over the bytes actually received: the signature commits to a body digest, so
   * comparing it against the real body is what makes a signed request cover its payload
   * rather than only its headers.
   *
   * `signer` exists for room creation, where the roster is still empty and the signature has
   * to be checked against a member card the body itself claims.
   */
  private async verifySigned(
    request: Request,
    bodyHash: string,
    signer: (deviceId: string) => Promise<Member | undefined> | Member | undefined = id => this.member(id),
    path = new URL(request.url).pathname
  ): Promise<Member | null> {
    const device = request.headers.get("X-Kin-Device");
    const time = request.headers.get("X-Kin-Time");
    const nonce = request.headers.get("X-Kin-Nonce");
    const claimedHash = request.headers.get("X-Kin-Body");
    const sig = request.headers.get("X-Kin-Signature");
    if (!device || !time || !nonce || !claimedHash || !sig) return null;
    if (Math.abs(Date.now() - Number(time)) > MAX_SKEW) return null;
    if (claimedHash !== bodyHash) return null;
    const member = await signer(device);
    if (!member) return null;
    const canonical = [request.method.toUpperCase(), path, time, nonce, claimedHash].join("\n");
    if (!(await verifyEcdsa(member.signPublicJwk, sig, canonical))) return null;
    if (!(await this.claimNonce(device, nonce, Number(time)))) return null;
    return member;
  }

  /** Verification for the JSON endpoints, whose bodies are small enough to buffer and re-hash. */
  private async verifySignedRequest(request: Request): Promise<{ member: Member; body: string } | null> {
    const body = await request.text();
    const member = await this.verifySigned(request, await sha256b64(enc.encode(body)));
    return member ? { member, body } : null;
  }

  private async verifyWs(url: URL): Promise<Member | null> {
    const device = url.searchParams.get("device");
    const time = url.searchParams.get("time");
    const nonce = url.searchParams.get("nonce");
    const body = url.searchParams.get("body");
    const sig = url.searchParams.get("sig");
    if (!device || !time || !nonce || !body || !sig) return null;
    if (Math.abs(Date.now() - Number(time)) > MAX_SKEW) return null;
    const member = await this.member(device);
    if (!member) return null;
    const canonical = ["GET", url.pathname, time, nonce, body].join("\n");
    if (!(await verifyEcdsa(member.signPublicJwk, sig, canonical))) return null;
    if (!(await this.claimNonce(device, nonce, Number(time)))) return null;
    return member;
  }

  private async verifyEnvelope(envelope: Envelope): Promise<boolean> {
    const member = await this.member(envelope.senderDeviceId);
    const meta = await this.meta();
    if (!member || !meta) return false;
    // A viewer came in on a look-but-don't-touch link. The relay cannot read a payload to tell a
    // message from a reaction, so read-only here means no envelopes at all, and the composer the
    // client hides is backed by a refusal rather than only by good manners.
    if (member.role === "viewer") return false;
    if (envelope.conversationId !== meta.id) return false;
    if (envelope.createdAt > Date.now() + MAX_SKEW) return false;
    if (!meta.keep) {
      if (envelope.expiresAt > envelope.createdAt + MESSAGE_TTL + 60_000) return false;
      if (envelope.expiresAt <= Date.now()) return false;
    }
    return verifyEcdsa(member.signPublicJwk, envelope.signature, envelopeText(envelope));
  }

  private broadcast(payload: unknown, exceptDevice?: string): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = (ws as WebSocket & { deserializeAttachment(): { deviceId?: string } }).deserializeAttachment?.();
        if (exceptDevice && attachment?.deviceId === exceptDevice) continue;
        ws.send(text);
      } catch { /* a socket that died mid-broadcast is nothing we can do about here */ }
    }
  }

  /**
   * Store an envelope, and — unless this room keeps things — book its expiry.
   *
   * In a kept room no deadline is recorded at all, rather than one set far in the future. A room
   * with a distant deadline still wakes its alarm on the hourly clamp forever, to sweep a list it
   * will find nothing in; a room with no deadline simply stops having an alarm. The envelope's
   * own `expiresAt` is left alone because it is signed, and simply stops meaning anything here.
   */
  private async storeEnvelope(envelope: Envelope, meta: RoomMeta): Promise<boolean> {
    const key = `msg:${String(envelope.createdAt).padStart(16, "0")}:${envelope.id}`;
    if (await this.ctx.storage.get(key)) return false;
    if (meta.keep) {
      const count = (await this.ctx.storage.get<number>("keptMessages")) ?? 0;
      if (count >= KEEP_MAX_MESSAGES) return false;
      await this.ctx.storage.put(key, envelope);
      await this.ctx.storage.put("keptMessages", count + 1);
      return true;
    }
    await this.ctx.storage.put(key, envelope);
    await this.scheduleSweep(envelope.expiresAt);
    return true;
  }

  /** Pull the retention alarm earlier if this deadline lands before the one already set. */
  private async scheduleSweep(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const next = Math.min(at, Date.now() + 60 * 60_000);
    if (!current || next < current) await this.ctx.storage.setAlarm(next);
  }

  private async notifyOthers(senderDeviceId: string, conversationId: string): Promise<void> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;
    const [subs, sender, meta] = await Promise.all([
      this.ctx.storage.list<PushSubscriptionJSON>({ prefix: "push:" }),
      this.member(senderDeviceId),
      this.meta()
    ]);
    const payload = JSON.stringify({
      title: meta?.kind === "group" ? meta.title : (sender?.displayName ?? "Kin"),
      body: meta?.kind === "group" ? `${sender?.displayName ?? "Someone"} sent a message` : "New message",
      conversationId
    });
    const vapid = {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT ?? "mailto:kin@example.invalid"
    };
    await Promise.allSettled([...subs.entries()].map(async ([key, sub]) => {
      if (key === `push:${senderDeviceId}`) return;
      try {
        const res = await sendPushNotification(sub, payload, vapid, { ttl: 7 * 24 * 60 * 60, urgency: "high" });
        if (res.status === 404 || res.status === 410) await this.ctx.storage.delete(key);
        else if (!res.ok) console.error(JSON.stringify({ kind: "push-failed", status: res.status, endpoint: new URL(sub.endpoint).origin }));
      } catch (err) {
        console.error(JSON.stringify({ kind: "push-error", error: String(err) }));
      }
    }));
  }

  private async createRoom(roomId: string, request: Request): Promise<Response> {
    const bodyText = await request.text();
    let body: { kind: "group" | "direct"; title: string; members: Member[]; spaceId?: string; keep?: boolean };
    try { body = JSON.parse(bodyText); } catch { return error("Invalid body"); }
    const members = (body.members ?? []).slice(0, 64);
    if (!members.length) return error("Missing members");

    // Nothing is stored yet, so there is no roster to check the signature against. Requiring the
    // creator to sign as one of the members they are listing is what proves a real device is
    // behind the room, instead of first-writer-wins.
    const device = request.headers.get("X-Kin-Device");
    if (!device || !request.headers.get("X-Kin-Signature")) return error("Unauthorized", 401);
    const claimed = members.find(m => m.deviceId === device);
    if (!claimed) return error("Creator must be one of the members", 403);
    const creator = await this.verifySigned(request, await sha256b64(enc.encode(bodyText)), () => claimed);
    if (!creator) return error("Unauthorized", 401);

    const existing = await this.meta();
    if (existing) {
      // Re-creating a room you are in is a no-op that hands back its metadata. Doing so for a room
      // you are *not* in must not confirm it exists: direct room ids are derivable by anyone in the
      // family, so answering would let a member enumerate who has a private chat with whom.
      return (await this.member(creator.deviceId)) ? json(existing) : error("Not a member of this room", 403);
    }

    // A direct room's id is a hash of exactly the two device ids in it, so recomputing it here
    // binds the room to its participants. Everyone in a family knows everyone's device ids, so
    // without this any member can pre-create — and sit inside — the DM between two other people.
    if (body.kind === "direct") {
      if (members.length !== 2) return error("A direct room holds exactly two members", 403);
      if (roomId !== await directRoomId(members[0].deviceId, members[1].deviceId)) {
        return error("Direct room id must be derived from its members", 403);
      }
    }

    // A channel names the space it belongs to, and that claim decides who may later walk in
    // unaided — so it is only worth anything if the person making it is in that space themselves.
    if (body.spaceId) {
      if (body.kind !== "group") return error("Only a group can be a channel", 403);
      if (body.spaceId === roomId) return error("A space cannot be its own channel", 403);
      const space = this.env.ROOMS.get(this.env.ROOMS.idFromName(body.spaceId));
      if ((await space.memberRole(creator.deviceId)) !== "member") return error("Not a member of that space", 403);
    }

    const meta: RoomMeta = {
      id: roomId,
      kind: body.kind,
      title: body.title.slice(0, 80),
      createdAt: Date.now(),
      ...(body.spaceId ? { spaceId: body.spaceId } : {}),
      ...(body.keep ? { keep: true } : {})
    };
    await this.ctx.storage.put("meta", meta);
    for (const member of members) await this.ctx.storage.put(`member:${member.deviceId}`, member);
    return json(meta, 201);
  }

  private async putMember(requester: Member, body: string): Promise<Response> {
    let incoming: Member;
    try { incoming = JSON.parse(body); } catch { return error("Invalid body"); }
    if (!incoming?.deviceId || !incoming.signPublicJwk || !incoming.dhPublicJwk) return error("Invalid member");

    const existing = await this.member(incoming.deviceId);
    if (existing) {
      // Introducing somebody new is the pairing flow and stays open to any member. Rewriting a
      // card that already exists is not: only its owner may touch it, and never its keys. A
      // device that needs fresh keys gets a fresh deviceId, so a key change on a known member is
      // always somebody swapping themselves in as that person.
      if (requester.deviceId !== incoming.deviceId) return error("Not your member card", 403);
      if (!sameJwk(existing.signPublicJwk, incoming.signPublicJwk)) return error("Device keys are immutable", 403);
      if (!sameJwk(existing.dhPublicJwk, incoming.dhPublicJwk)) return error("Device keys are immutable", 403);
    }

    const member: Member = existing
      ? { ...existing, displayName: String(incoming.displayName ?? "").slice(0, 64), avatarSeed: String(incoming.avatarSeed ?? "").slice(0, 64) }
      : { ...incoming, displayName: String(incoming.displayName ?? "").slice(0, 64), avatarSeed: String(incoming.avatarSeed ?? "").slice(0, 64) };
    await this.ctx.storage.put(`member:${member.deviceId}`, member);
    this.broadcast({ kind: "member", member });
    return json({ ok: true });
  }

  /**
   * Drop a member from the room.
   *
   * Any member may remove any member, which is the same trust Kin already extends for adding one
   * — pairing lets any member introduce anybody, and a family has no admin to appeal to. What it
   * buys is the case this exists for: a phone that was lost, replaced or handed on, whose device
   * is still listed and still receiving.
   *
   * Removal is a relay-side eviction, not a key rotation. It cuts the device off from history,
   * from the socket and from posting, but the conversation key it already holds is unchanged, so
   * it keeps whatever it had already received. The UI says so rather than implying otherwise.
   */
  private async removeMember(requester: Member, deviceId: string): Promise<Response> {
    const target = await this.member(deviceId);
    if (!target) return json({ ok: true });
    const members = await this.allMembers();
    // Emptying the room would leave a meta record nobody can ever authenticate against again,
    // and every request to it answering 401 forever.
    if (members.length <= 1) return error("A room keeps its last member", 409);
    await this.ctx.storage.delete([`member:${deviceId}`, `push:${deviceId}`]);
    this.broadcast({ kind: "member-removed", deviceId, byDeviceId: requester.deviceId });
    return json({ ok: true });
  }

  private async listHistory(): Promise<Response> {
    // Keys are msg:<zero-padded createdAt>:<id> and DO list is ascending, so an unqualified
    // limit hands back the *oldest* 400 — past 400 live envelopes a reconnecting client would
    // replay ancient history and never see anything recent. Take the newest, then put them back
    // in order, because clients ingest oldest-first.
    const rows = await this.ctx.storage.list<Envelope>({ prefix: "msg:", limit: 400, reverse: true });
    const now = Date.now();
    const meta = await this.meta();
    const live = meta?.keep ? [...rows.values()] : [...rows.values()].filter(x => x.expiresAt > now);
    return json(live.sort((a, b) => a.createdAt - b.createdAt));
  }

  private async postMessage(request: Request, meta: RoomMeta): Promise<Response> {
    const envelope = await request.json() as Envelope;
    if (!(await this.verifyEnvelope(envelope))) return error("Invalid envelope", 401);
    if (await this.storeEnvelope(envelope, meta)) {
      this.broadcast(envelope, envelope.senderDeviceId);
      this.ctx.waitUntil(this.notifyOthers(envelope.senderDeviceId, meta.id));
    }
    return json({ ok: true }, 202);
  }

  private async registerPush(member: Member, body: string): Promise<Response> {
    let sub: PushSubscriptionJSON;
    try { sub = JSON.parse(body); } catch { return error("Invalid body"); }
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return error("Invalid subscription");
    await this.ctx.storage.put(`push:${member.deviceId}`, sub);
    return json({ ok: true });
  }

  /**
   * Attachments stream straight to R2 rather than being buffered, so the body is not re-hashed
   * here the way the JSON endpoints are. Two guards stand in for that: a counting stream that
   * aborts past the cap even when no Content-Length was declared, and the signed digest passed
   * to R2 as an upload checksum, which fails the write if the bytes disagree with the signature.
   */
  private async putFile(request: Request, fileId: string, key: string, meta: RoomMeta): Promise<Response> {
    const limit = MAX_FILE + 64 * 1024;
    const declared = request.headers.get("Content-Length");
    if (declared && Number(declared) > limit) return error("File too large", 413);
    const claimedDigest = request.headers.get("X-Kin-Body") ?? "";
    const signed = await this.verifySigned(request, claimedDigest);
    if (!signed) return error("Unauthorized", 401);
    if (!request.body) return error("Missing file");
    const digest = b64urlToBytes(claimedDigest);
    if (digest.byteLength !== 32) return error("Invalid content hash");
    if (meta.keep && ((await this.ctx.storage.get<number>("keptBytes")) ?? 0) >= KEEP_MAX_BYTES) {
      return error("This album is full — delete something to make room", 507);
    }

    // R2 only accepts a body whose length is known up front, so a declared upload streams
    // straight through — the runtime holds it to its Content-Length, which we have already
    // bounded. A chunked upload declares nothing, which is exactly the case the old guard let
    // past unmeasured, so it is read into memory under the same cap instead.
    let body: ReadableStream<Uint8Array> | Uint8Array = request.body;
    let stored = Number(declared ?? 0);
    if (!declared) {
      const buffered = await readAtMost(request.body, limit);
      if (!buffered) return error("File too large", 413);
      body = buffered;
      stored = buffered.byteLength;
    }
    try {
      await this.env.ATTACHMENTS.put(key, body, {
        httpMetadata: { contentType: "application/octet-stream" },
        sha256: toHex(digest)
      });
    } catch (err) {
      // R2 aborts a checksum mismatch mid-stream; let go of the rest of the body before
      // replying, or the runtime raises "can't read from request stream after response".
      try { await request.body.cancel(); } catch { /* already consumed */ }
      try { await this.env.ATTACHMENTS.delete(key); } catch { /* nothing landed */ }
      console.error(JSON.stringify({ kind: "upload-rejected", error: String(err) }));
      return error("Upload rejected", 400);
    }
    // R2 has no lifecycle rule behind it and wrangler.jsonc cannot express one, so the room
    // remembers what it put there and expires it on the same sweep that expires envelopes.
    // Without this record an attachment simply lives in the bucket forever — which in a kept room
    // is the point, so those go under a prefix the sweep does not read, and are counted instead.
    if (meta.keep) {
      const bytes = (await this.ctx.storage.get<number>("keptBytes")) ?? 0;
      await this.ctx.storage.put(`kept:${fileId}`, { fileId, key, expiresAt: 0 });
      await this.ctx.storage.put("keptBytes", bytes + stored);
      return json({ ok: true }, 201);
    }
    const expiresAt = Date.now() + MESSAGE_TTL;
    await this.ctx.storage.put(`file:${String(expiresAt).padStart(16, "0")}:${fileId}`, { fileId, key, expiresAt });
    await this.scheduleSweep(expiresAt);
    return json({ ok: true }, 201);
  }

  private async getFile(key: string): Promise<Response> {
    const obj = await this.env.ATTACHMENTS.get(key);
    if (!obj) return error("File expired", 404);
    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store" }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
    if (!match) return error("Bad room path", 404);
    const roomId = decodeURIComponent(match[1]);
    const tail = match[2] ?? "";

    if (tail === "" && request.method === "PUT") return this.createRoom(roomId, request);

    const meta = await this.meta();
    if (!meta) return error("Room not found", 404);

    if (tail === "/ws" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("Expected websocket", 426);
      const member = await this.verifyWs(url);
      if (!member) return error("Unauthorized", 401);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      (server as WebSocket & { serializeAttachment(v: unknown): void }).serializeAttachment({ deviceId: member.deviceId });
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (tail === "/members" && request.method === "GET") {
      if (!(await this.verifySignedRequest(request))) return error("Unauthorized", 401);
      return json(await this.allMembers());
    }
    if (tail === "/members" && request.method === "POST") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      return this.putMember(signed.member, signed.body);
    }
    const memberMatch = tail.match(/^\/members\/([A-Za-z0-9_-]+)$/);
    if (memberMatch && request.method === "DELETE") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      return this.removeMember(signed.member, memberMatch[1]);
    }
    // Joining a channel is the one room write that does not require already being in the room,
    // so it verifies against the card in the body rather than against the roster.
    if (tail === "/join" && request.method === "POST") {
      return this.joinAsSpaceMember(request, meta, await request.text());
    }
    if (tail === "/channels" && request.method === "GET") {
      if (!(await this.verifySignedRequest(request))) return error("Unauthorized", 401);
      return this.listChannels();
    }
    if (tail === "/channels" && request.method === "POST") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      if (signed.member.role && signed.member.role !== "member") return error("Guests cannot change channels", 403);
      return this.putChannel(signed.body);
    }
    const channelMatch = tail.match(/^\/channels\/([A-Za-z0-9_-]+)$/);
    if (channelMatch && request.method === "DELETE") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      if (signed.member.role && signed.member.role !== "member") return error("Guests cannot change channels", 403);
      return this.deleteChannel(channelMatch[1]);
    }
    if (tail === "/invites" && request.method === "GET") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      if (signed.member.role && signed.member.role !== "member") return error("Guests cannot see invites", 403);
      return this.listInvites();
    }
    if (tail === "/history" && request.method === "GET") {
      if (!(await this.verifySignedRequest(request))) return error("Unauthorized", 401);
      return this.listHistory();
    }
    if (tail === "/messages" && request.method === "POST") {
      return this.postMessage(request, meta);
    }
    if (tail === "/push" && request.method === "POST") {
      const signed = await this.verifySignedRequest(request);
      if (!signed) return error("Unauthorized", 401);
      return this.registerPush(signed.member, signed.body);
    }

    const fileMatch = tail.match(/^\/files\/([A-Za-z0-9_-]+)$/);
    if (fileMatch) {
      const key = `rooms/${roomId}/${fileMatch[1]}`;
      if (request.method === "PUT") return this.putFile(request, fileMatch[1], key, meta);
      if (request.method === "GET") {
        if (!(await this.verifySignedRequest(request))) return error("Unauthorized", 401);
        return this.getFile(key);
      }
    }

    return error("Not found", 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let frame: { kind?: string; active?: boolean; messageId?: string };
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch { return; }
    const attachment = (ws as WebSocket & { deserializeAttachment(): { deviceId?: string } }).deserializeAttachment?.();
    const senderDeviceId = attachment?.deviceId;
    if (!senderDeviceId) return;
    if (frame.kind === "typing") this.broadcast({ kind: "typing", senderDeviceId, active: !!frame.active }, senderDeviceId);
    if (frame.kind === "read") this.broadcast({ kind: "read", senderDeviceId, messageId: frame.messageId }, senderDeviceId);
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  async alarm(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    const deletes: string[] = [];

    for (const [key, envelope] of await this.ctx.storage.list<Envelope>({ prefix: "msg:" })) {
      if (envelope.expiresAt <= now) deletes.push(key);
      else next = Math.min(next, envelope.expiresAt);
    }
    for (const [key, expiresAt] of await this.ctx.storage.list<number>({ prefix: "nonce:" })) {
      if (expiresAt <= now) deletes.push(key);
      else next = Math.min(next, expiresAt);
    }

    const expiredFiles: FileRecord[] = [];
    const fileRecordKeys: string[] = [];
    for (const [key, record] of await this.ctx.storage.list<FileRecord>({ prefix: "file:" })) {
      if (record.expiresAt <= now) { expiredFiles.push(record); fileRecordKeys.push(key); }
      else next = Math.min(next, record.expiresAt);
    }
    if (expiredFiles.length) {
      try {
        await this.env.ATTACHMENTS.delete(expiredFiles.map(r => r.key));
        deletes.push(...fileRecordKeys);
      } catch (err) {
        // Hold on to the records so the next sweep retries, rather than forgetting objects
        // that are still sitting in the bucket.
        console.error(JSON.stringify({ kind: "attachment-sweep-failed", count: expiredFiles.length, error: String(err) }));
      }
    }

    if (deletes.length) await this.ctx.storage.delete(deletes);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.min(next, now + 60 * 60_000));
  }
}
