/**
 * Test-only doubles for the Durable Object runtime: enough of `ctx.storage`, R2 and the
 * WebCrypto request-signing the client does to drive `ConversationRoom` from plain vitest.
 */
import { exportJwk, generateKeyPair } from "../webcrypto";

type Row = { key: string; value: unknown };

export class FakeStorage {
  private rows = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.rows.has(key) ? (structuredClone(this.rows.get(key)) as T) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.rows.set(key, structuredClone(value));
  }
  async delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.rows.delete(k);
  }
  async list<T>(options: { prefix?: string; limit?: number; reverse?: boolean } = {}): Promise<Map<string, T>> {
    const { prefix = "", limit = Infinity, reverse = false } = options;
    const rows: Row[] = [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (reverse) rows.reverse();
    return new Map(rows.slice(0, limit).map(r => [r.key, structuredClone(r.value) as T]));
  }
  async deleteAll(): Promise<void> { this.rows.clear(); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
  /** The runtime clears an alarm as it fires; tests that drive `alarm()` by hand have to say so. */
  fireAlarm(): void { this.alarm = null; }

  keys(prefix = ""): string[] {
    return [...this.rows.keys()].filter(k => k.startsWith(prefix)).sort();
  }
}

export class FakeR2 {
  objects = new Map<string, Uint8Array>();
  puts: { key: string; options?: unknown }[] = [];

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | null, options?: { sha256?: string }) {
    this.puts.push({ key, options });
    const bytes = await drain(body);
    // R2 validates an sha256 upload checksum server-side and rejects the write on mismatch;
    // the worker leans on that instead of buffering the attachment to hash it itself.
    if (options?.sha256) {
      const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
      const hex = Array.from(actual, b => b.toString(16).padStart(2, "0")).join("");
      if (hex !== options.sha256.toLowerCase()) throw new Error("put: The SHA-256 checksum you specified did not match what we received");
    }
    this.objects.set(key, bytes);
    return { key };
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { key, body: bytes, arrayBuffer: async () => bytes } : null;
  }
  async delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
}

async function drain(body: ReadableStream | ArrayBuffer | Uint8Array | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const chunks: Uint8Array[] = [];
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * A hibernating WebSocket, faithful on the one point tests get wrong: the runtime drops a socket
 * from `getWebSockets()` once it is closed. A fake that merely records the call will happily go on
 * delivering to it, and then agree that eviction works when it does not.
 */
export function fakeSocket(deviceId: string, pool: unknown[], session?: string) {
  const ws = {
    deviceId,
    session,
    sent: [] as string[],
    closed: false,
    // A device may now have more than one of these — a phone and a laptop on the same identity —
    // and the session is how the room tells the socket that sent a message from the one that
    // wants to be told about it.
    deserializeAttachment: () => (session ? { deviceId, session } : { deviceId }),
    serializeAttachment: () => {},
    send(text: string) {
      if (ws.closed) throw new Error("socket is closed");
      ws.sent.push(text);
    },
    close() {
      ws.closed = true;
      const at = pool.indexOf(ws);
      if (at >= 0) pool.splice(at, 1);
    }
  };
  pool.push(ws);
  return ws;
}

export function fakeCtx(storage = new FakeStorage(), sockets: unknown[] = []) {
  return {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
    waitUntil: (p: Promise<unknown>) => { void p; }
  };
}

export function fakeEnv(overrides: Record<string, unknown> = {}) {
  return { ATTACHMENTS: new FakeR2(), ...overrides } as any;
}

/**
 * A Durable Object namespace whose stubs are the objects themselves.
 *
 * The worker now has objects that call each other — an invite asks a room to enrol somebody, a
 * channel asks its space who is in it — and those are plain method calls on a typed stub, so a
 * namespace that hands back the instance is a faithful enough double to drive both sides.
 */
export function fakeNamespace<T>(make: (id: string) => T) {
  const instances = new Map<string, T>();
  return {
    instances,
    idFromName: (name: string) => name,
    get: (name: string) => {
      const existing = instances.get(name);
      if (existing) return existing;
      const created = make(name);
      instances.set(name, created);
      return created;
    }
  };
}

/** A ROOMS namespace of real room objects, each with its own storage. */
export function fakeRooms(RoomClass: new (ctx: any, env: any) => any, env: any) {
  const storages = new Map<string, FakeStorage>();
  const ns = fakeNamespace((id: string) => {
    const storage = new FakeStorage();
    storages.set(id, storage);
    return new RoomClass(fakeCtx(storage), env);
  });
  return Object.assign(ns, { storages });
}

// ---------- identities that sign exactly like src/lib/crypto.ts ----------

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256b64(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? enc.encode(value) : value;
  return b64url(await crypto.subtle.digest("SHA-256", bytes as Uint8Array));
}

export type TestIdentity = {
  deviceId: string;
  displayName: string;
  avatarSeed: string;
  dhPublicJwk: JsonWebKey;
  signPublicJwk: JsonWebKey;
  signPrivate: CryptoKey;
  member(): Record<string, unknown>;
};

export async function makeIdentity(displayName: string): Promise<TestIdentity> {
  const dh = await generateKeyPair({ name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
  const sign = await generateKeyPair({ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"]);
  const id: TestIdentity = {
    deviceId: crypto.randomUUID(),
    displayName,
    avatarSeed: `e:${displayName[0]}`,
    dhPublicJwk: await exportJwk(dh.publicKey),
    signPublicJwk: await exportJwk(sign.publicKey),
    signPrivate: sign.privateKey,
    member() {
      return {
        deviceId: id.deviceId,
        displayName: id.displayName,
        avatarSeed: id.avatarSeed,
        dhPublicJwk: id.dhPublicJwk,
        signPublicJwk: id.signPublicJwk
      };
    }
  };
  return id;
}

/** Mirrors `signRequest` in src/lib/crypto.ts. */
export async function signHeaders(
  id: TestIdentity,
  method: string,
  path: string,
  body = "",
  bodyHashOverride?: string,
  timeOverride?: number
): Promise<Record<string, string>> {
  const ts = String(timeOverride ?? Date.now());
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(8)));
  const bodyHash = bodyHashOverride ?? (await sha256b64(body));
  const canonical = [method.toUpperCase(), path, ts, nonce, bodyHash].join("\n");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(canonical));
  return {
    "X-Kin-Device": id.deviceId,
    "X-Kin-Time": ts,
    "X-Kin-Nonce": nonce,
    "X-Kin-Body": bodyHash,
    "X-Kin-Signature": b64url(signature)
  };
}

export async function signedRequest(
  id: TestIdentity,
  method: string,
  path: string,
  payload?: unknown,
  init: RequestInit = {}
): Promise<Request> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const headers = await signHeaders(id, method, path, body);
  return new Request(`https://kin.test${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
    body: body || undefined
  });
}

/** A room id derived the way `directConversation` does in src/lib/crypto.ts. */
export async function directRoomId(a: string, b: string): Promise<string> {
  return (await sha256b64(`kin-direct-room:${[a, b].sort().join(":")}`)).slice(0, 32);
}

export async function signEnvelope(id: TestIdentity, envelope: Record<string, any>) {
  const text = [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(text));
  return { ...envelope, signature: b64url(sig) };
}

// ---------- shared room fixture ----------

export const ROOM = "family-room-1";
export const roomPath = (tail = "", roomId: string = ROOM) => `/api/rooms/${roomId}${tail}`;

export type Fixture = {
  storage: FakeStorage;
  env: ReturnType<typeof fakeEnv>;
  room: any;
  alice: TestIdentity;
  bob: TestIdentity;
  mallory: TestIdentity;
  seed(kind?: "group" | "direct", members?: TestIdentity[], id?: string): Promise<void>;
  /** Stand up a second, fully seeded room in the ROOMS namespace — a space, or a channel. */
  seedRoom(id: string, members: TestIdentity[], meta?: Record<string, unknown>): Promise<any>;
};

export async function newFixture(RoomClass: new (ctx: any, env: any) => any): Promise<Fixture> {
  const storage = new FakeStorage();
  const env = fakeEnv();
  env.ROOMS = fakeRooms(RoomClass, env);
  const [alice, bob, mallory] = await Promise.all([makeIdentity("Alice"), makeIdentity("Bob"), makeIdentity("Mallory")]);
  const room = new RoomClass(fakeCtx(storage), env);
  // The room under test answers to its own id inside the namespace too, so an object that reaches
  // for it by name — an invite enrolling somebody into it — gets this one and not a fresh empty.
  env.ROOMS.instances.set(ROOM, room);
  env.ROOMS.storages.set(ROOM, storage);
  const fixture: Fixture = {
    storage, env, alice, bob, mallory,
    room,
    async seed(kind = "group", members = [alice, bob], id = ROOM) {
      await storage.put("meta", { id, kind, title: "Family", createdAt: Date.now() });
      for (const m of members) await storage.put(`member:${m.deviceId}`, m.member());
    },
    async seedRoom(id, members, meta = {}) {
      const other = env.ROOMS.get(id);
      const otherStorage = env.ROOMS.storages.get(id)!;
      await otherStorage.put("meta", { id, kind: "group", title: id, createdAt: Date.now(), ...meta });
      for (const m of members) await otherStorage.put(`member:${m.deviceId}`, m.member());
      return other;
    }
  };
  return fixture;
}
