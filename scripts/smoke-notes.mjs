/**
 * End-to-end smoke test for "Just me" — the room a person sends to themselves.
 *
 * The unit tests pin the derivation and the folding; this walks the whole thing over HTTP and a
 * pair of live sockets, because the property the feature stands on is one no unit test can see:
 * a note written on one screen arrives exactly once on the other, and not at all back on the one
 * that wrote it. That is the relay's `broadcast` skipping the sending *session* rather than the
 * sending device — a distinction that only exists because a phone and a laptop share a device id.
 *
 *   node scripts/smoke-notes.mjs [http://localhost:8787]
 */
const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const enc = new TextEncoder();
const dec = new TextDecoder();

let failures = 0;
function check(what, ok, detail = "") {
  console.log(`${ok ? "  ok" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- the same primitives as src/lib/crypto.ts ----------

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const unb64 = value => {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const sha256 = async value => b64(await crypto.subtle.digest("SHA-256", typeof value === "string" ? enc.encode(value) : value));

async function identity(displayName) {
  const dh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    deviceId: crypto.randomUUID(), displayName, avatarSeed: "e:🦊",
    dhPublicJwk: await crypto.subtle.exportKey("jwk", dh.publicKey),
    dhPrivateJwk: await crypto.subtle.exportKey("jwk", dh.privateKey),
    signPublicJwk: await crypto.subtle.exportKey("jwk", sign.publicKey),
    signPrivateJwk: await crypto.subtle.exportKey("jwk", sign.privateKey),
    signPrivate: sign.privateKey
  };
}
const card = id => ({
  deviceId: id.deviceId, displayName: id.displayName, avatarSeed: id.avatarSeed,
  dhPublicJwk: id.dhPublicJwk, signPublicJwk: id.signPublicJwk
});

async function signHeaders(id, method, path, body = "") {
  const ts = String(Date.now());
  const nonce = b64(crypto.getRandomValues(new Uint8Array(8)));
  const bodyHash = await sha256(body);
  const canonical = [method.toUpperCase(), path, ts, nonce, bodyHash].join("\n");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(canonical));
  return {
    "X-Kin-Device": id.deviceId, "X-Kin-Time": ts, "X-Kin-Nonce": nonce,
    "X-Kin-Body": bodyHash, "X-Kin-Signature": b64(sig)
  };
}
async function signed(id, method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(await signHeaders(id, method, path, body)), "Content-Type": "application/json" },
    body: body || undefined
  });
}

async function deriveAesFrom(secret, label) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`kin:${label}`));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`kin-${label}-v1`) },
    material, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
}

/** The room the devices sync through, and the room the person writes notes in. Not the same one. */
async function selfRoom(id) {
  const seed = id.dhPrivateJwk.d;
  const key = await deriveAesFrom(unb64(seed), "self-sync");
  return { id: (await sha256(`kin-self-room:${seed}`)).slice(0, 32), key: b64(await crypto.subtle.exportKey("raw", key)) };
}
async function notesRoom(id) {
  const seed = id.dhPrivateJwk.d;
  const key = await deriveAesFrom(unb64(seed), "self-notes");
  return { id: (await sha256(`kin-self-notes-room:${seed}`)).slice(0, 32), key: b64(await crypto.subtle.exportKey("raw", key)) };
}

async function seal(room, id, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const createdAt = Date.now();
  const messageId = crypto.randomUUID();
  const aes = await crypto.subtle.importKey("raw", unb64(room.key), { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = enc.encode(`${room.id}:${messageId}:${id.deviceId}:${createdAt}`);
  const ciphertext = b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, aes, enc.encode(JSON.stringify(payload))));
  const envelope = {
    kind: "message", id: messageId, conversationId: room.id, senderDeviceId: id.deviceId,
    createdAt, expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000, iv: b64(iv), ciphertext
  };
  const text = [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
  return { ...envelope, signature: b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(text))) };
}
async function open(room, envelope) {
  const aes = await crypto.subtle.importKey("raw", unb64(room.key), { name: "AES-GCM" }, false, ["decrypt"]);
  const aad = enc.encode(`${envelope.conversationId}:${envelope.id}:${envelope.senderDeviceId}:${envelope.createdAt}`);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: aad }, aes, unb64(envelope.ciphertext))));
}

/** One screen's socket onto a room. `session` is what makes two screens of one device distinct. */
async function screen(id, roomId, session) {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/ws`;
  const auth = await signHeaders(id, "GET", path, "");
  const url = new URL(`${base}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("device", id.deviceId);
  url.searchParams.set("time", auth["X-Kin-Time"]);
  url.searchParams.set("nonce", auth["X-Kin-Nonce"]);
  url.searchParams.set("body", auth["X-Kin-Body"]);
  url.searchParams.set("sig", auth["X-Kin-Signature"]);
  url.searchParams.set("session", session);
  const ws = new WebSocket(url);
  const seen = [];
  ws.onmessage = e => { try { seen.push(JSON.parse(e.data)); } catch { /* not ours */ } };
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  return { ws, seen, session, close: () => ws.close() };
}
async function post(room, envelope, session) {
  return fetch(`${base}/api/rooms/${room.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kin-Session": session },
    body: JSON.stringify(envelope)
  });
}
const settle = ms => new Promise(r => setTimeout(r, ms));

// ---------- the ceremony ----------

const ada = await identity("Ada");
const bo = await identity("Bo");

// 1. The room is derived, not created. Two screens of the same person land on the same one, and
//    nobody else's identity can name it — which is the whole of its access control.
const mine = await notesRoom(ada);
check("both of Ada's screens derive the same room", (await notesRoom(ada)).id === mine.id);
check("Bo's identity derives a different one", (await notesRoom(bo)).id !== mine.id);
check("and a different key", (await notesRoom(bo)).key !== mine.key);

// 2. It is emphatically *not* the room the devices sync through: that one prunes every envelope
//    but the newest snapshot on each read, so notes kept in it would be swept away by a sync.
const sync = await selfRoom(ada);
check("the notes room is not the device-sync room", mine.id !== sync.id && mine.key !== sync.key);

// 3. Ada's phone makes it. Kept, because a notepad that emptied itself weekly is not a notepad.
let res = await signed(ada, "PUT", `/api/rooms/${mine.id}`, { kind: "group", title: "Just me", members: [card(ada)], keep: true });
check("Ada's phone makes the room", res.status === 201, `status ${res.status}`);
check("with only her on the roster", (await (await signed(ada, "GET", `/api/rooms/${mine.id}/members`)).json()).length === 1);

// Making it twice is what every boot does, and it has to be a no-op rather than a second room.
res = await signed(ada, "PUT", `/api/rooms/${mine.id}`, { kind: "group", title: "Just me", members: [card(ada)], keep: true });
check("making it again is a no-op", res.status === 200, `status ${res.status}`);

// 4. Bo cannot look in, even handed the id.
res = await signed(bo, "GET", `/api/rooms/${mine.id}/history`);
check("Bo cannot read it even knowing the id", !res.ok, `status ${res.status}`);
res = await signed(bo, "PUT", `/api/rooms/${mine.id}`, { kind: "group", title: "Mine now", members: [card(bo)], keep: true });
check("Bo cannot join himself to it", res.status === 403, `status ${res.status}`);

// 5. The property the feature stands on. Two sockets, one identity: the phone writes a note and
//    the laptop is handed it, while the phone — which already drew its own copy before the relay
//    saw anything — is not handed it back. One note, one bubble, on each screen.
const phone = await screen(ada, mine.id, "phone-session");
const laptop = await screen(ada, mine.id, "laptop-session");
const note = await seal(mine, ada, { type: "text", text: "wifi is hunter2" });
res = await post(mine, note, phone.session);
check("the note is accepted", res.status === 202, `status ${res.status}`);
await settle(400);

const onLaptop = laptop.seen.filter(f => f.kind === "message" && f.id === note.id);
const onPhone = phone.seen.filter(f => f.kind === "message" && f.id === note.id);
check("the other screen is handed the note", onLaptop.length === 1, `${onLaptop.length} copies`);
check("the screen that wrote it is not handed it back", onPhone.length === 0, `${onPhone.length} copies`);
check("and the laptop can read it", onLaptop.length === 1 && (await open(mine, onLaptop[0])).text === "wifi is hunter2");

// 6. A screen that was asleep for it reads the same one note out of history, not two.
const history = await (await signed(ada, "GET", `/api/rooms/${mine.id}/history`)).json();
check("history holds exactly one copy", history.filter(e => e.id === note.id).length === 1, `${history.length} envelopes`);
check("and it opens under the derived key", (await open(mine, history.find(e => e.id === note.id))).text === "wifi is hunter2");

// 7. Kept means kept: no expiry deadline is booked for this room at all.
check("the room is kept", (await (await signed(ada, "PUT", `/api/rooms/${mine.id}`, { kind: "group", title: "Just me", members: [card(ada)], keep: true })).json()).keep === true);

// 8. Emptying it takes the ciphertext off the relay, not merely off the screen.
for (const e of history) {
  const gone = await signed(ada, "DELETE", `/api/rooms/${mine.id}/messages/${e.id}`);
  check(`the relay lets go of ${e.id.slice(0, 8)}`, gone.ok, `status ${gone.status}`);
}
const emptied = await (await signed(ada, "GET", `/api/rooms/${mine.id}/history`)).json();
check("nothing is left on the relay", emptied.length === 0, `${emptied.length} left`);

phone.close(); laptop.close();
await settle(100);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
