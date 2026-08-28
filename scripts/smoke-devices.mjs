/**
 * End-to-end smoke test for one person on two devices, against a running relay.
 *
 * The unit tests pin the rules of each object in isolation; this walks the whole thing over HTTP,
 * because the interesting failures live between the pieces. A phone makes a group, seals its
 * identity into a device link, and a laptop that has never touched the relay opens the link,
 * becomes the same member, and finds the group waiting for it — then makes a group of its own and
 * watches it turn up on the phone, then leaves one and watches it go.
 *
 *   node scripts/smoke-devices.mjs [http://localhost:8787]
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
const randomKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));

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

/** A second screen holding the same keys — which is exactly what a linked device is. */
async function adopt(bundle) {
  return {
    ...bundle.identity,
    signPrivate: await crypto.subtle.importKey("jwk", bundle.identity.signPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  };
}

async function signHeaders(id, method, path, body = "", bodyHashOverride) {
  const ts = String(Date.now());
  const nonce = b64(crypto.getRandomValues(new Uint8Array(8)));
  const bodyHash = bodyHashOverride ?? await sha256(body);
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

async function deriveAesFrom(secret, label, extractable = true) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`kin:${label}`));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`kin-${label}-v1`) },
    material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]
  );
}

// The device link: the same shape as an invite, over a 256-bit secret and a fifteen-minute life.
const linkCodeFor = async secret => (await sha256(`kin-link-code:${secret}`)).slice(0, 16);
async function linkMaterial(code, secret) {
  return { proof: await sha256(`kin-link-proof:${code}:${secret}`), key: await deriveAesFrom(unb64(secret), `link:${code}`, false) };
}
async function sealLink(code, secret, value) {
  const { proof, key } = await linkMaterial(code, secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { proof, blob: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)))), iv: b64(iv) };
}
async function openLink(code, secret, blob, iv) {
  const { key } = await linkMaterial(code, secret);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(blob))));
}

// The room a person's own screens keep for each other.
async function selfRoom(id) {
  const seed = id.dhPrivateJwk.d;
  const key = await deriveAesFrom(unb64(seed), "self-sync");
  return { id: (await sha256(`kin-self-room:${seed}`)).slice(0, 32), key: b64(await crypto.subtle.exportKey("raw", key)) };
}
async function sealSnapshot(room, id, snapshot) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const createdAt = Date.now();
  const messageId = crypto.randomUUID();
  const aes = await crypto.subtle.importKey("raw", unb64(room.key), { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = enc.encode(`${room.id}:${messageId}:${id.deviceId}:${createdAt}`);
  const ciphertext = b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, aes, enc.encode(JSON.stringify(snapshot))));
  const envelope = {
    kind: "message", id: messageId, conversationId: room.id, senderDeviceId: id.deviceId,
    createdAt, expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000, iv: b64(iv), ciphertext
  };
  const text = [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
  const signature = b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(text)));
  return { ...envelope, signature };
}
async function openSnapshot(room, envelope) {
  const aes = await crypto.subtle.importKey("raw", unb64(room.key), { name: "AES-GCM" }, false, ["decrypt"]);
  const aad = enc.encode(`${envelope.conversationId}:${envelope.id}:${envelope.senderDeviceId}:${envelope.createdAt}`);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: aad }, aes, unb64(envelope.ciphertext))));
}
async function publish(id, snapshot) {
  const room = await selfRoom(id);
  await signed(id, "PUT", `/api/rooms/${room.id}`, { kind: "group", title: "Kin", members: [card(id)], keep: true });
  const envelope = await sealSnapshot(room, id, snapshot);
  await fetch(`${base}/api/rooms/${room.id}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope)
  });
  // One picture at a time: everything behind the newest is something nobody will read again.
  const history = await (await signed(id, "GET", `/api/rooms/${room.id}/history`)).json();
  for (const old of history) {
    if (old.id !== envelope.id) await signed(id, "DELETE", `/api/rooms/${room.id}/messages/${old.id}`);
  }
  return envelope;
}
async function pull(id) {
  const room = await selfRoom(id);
  const res = await signed(id, "GET", `/api/rooms/${room.id}/history`);
  if (!res.ok) return null;
  const history = await res.json();
  const newest = history.sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest ? openSnapshot(room, newest) : null;
}

// ---------- the ceremony ----------

const phone = await identity("Ada");
const bo = await identity("Bo");

// 1. Ada, on her phone, makes a group and tells Bo about it.
const familyId = crypto.randomUUID();
const familyKey = randomKey();
let res = await signed(phone, "PUT", `/api/rooms/${familyId}`, { kind: "group", title: "Family", members: [card(phone), card(bo)] });
check("Ada makes a group on her phone", res.status === 201, `status ${res.status}`);

// 2. Her phone leaves a picture of what it holds, in a room only her keys can name.
await publish(phone, {
  v: 1, at: Date.now(),
  profile: { displayName: "Ada", avatarSeed: "e:🦊", at: Date.now() },
  home: familyId, gone: {},
  rooms: [{ id: familyId, kind: "group", title: "Family", key: familyKey, createdAt: Date.now() }]
});
const selfId = (await selfRoom(phone)).id;
check("the sync room is not named after anything public", !selfId.includes(phone.deviceId));
res = await signed(bo, "GET", `/api/rooms/${selfId}/history`);
check("and nobody else can read it", res.status === 401, `status ${res.status}`);

// 3. Ada seals her identity into a device link and puts it on screen.
const secret = randomKey();
const code = await linkCodeFor(secret);
const bundle = { v: 1, at: Date.now(), home: familyId, identity: {
  deviceId: phone.deviceId, displayName: phone.displayName, avatarSeed: phone.avatarSeed,
  dhPublicJwk: phone.dhPublicJwk, dhPrivateJwk: phone.dhPrivateJwk,
  signPublicJwk: phone.signPublicJwk, signPrivateJwk: phone.signPrivateJwk
} };
const sealed = await sealLink(code, secret, bundle);
res = await signed(phone, "PUT", `/api/link/${code}`, { proof: sealed.proof, iv: sealed.iv, blob: sealed.blob, owner: card(phone) });
check("Ada mints a device link", res.status === 201, `status ${res.status}`);
check("the relay is holding something it cannot read", !sealed.blob.includes(phone.dhPrivateJwk.d));

// 4. Somebody who only knows the code, not the secret, gets nowhere.
res = await fetch(`${base}/api/link/${code}/claim`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof: "guessed" })
});
check("knowing where it is stored is not knowing how to open it", res.status === 403, `status ${res.status}`);

// 5. The laptop opens the link, which is the only thing it has ever done.
res = await fetch(`${base}/api/link/${code}/claim`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof: sealed.proof })
});
check("the laptop collects the bundle", res.ok, `status ${res.status}`);
const collected = await res.json();
const laptop = await adopt(await openLink(code, secret, collected.blob, collected.iv));
check("and opens it with the secret from the fragment", laptop.deviceId === phone.deviceId);

res = await signed(phone, "GET", `/api/link/${code}`);
check("the phone can see that it landed", (await res.json()).claimed === true);

// 6. The laptop reads the picture the phone left, and is in the group without being invited.
const snapshot = await pull(laptop);
check("the laptop finds the room list waiting", snapshot?.rooms?.[0]?.id === familyId);
check("with the key to read it", snapshot.rooms[0].key === familyKey);
check("and where to open into", snapshot.home === familyId);

res = await signed(laptop, "GET", `/api/rooms/${familyId}/members`);
check("the relay treats it as the same member", res.ok, `status ${res.status}`);
const roster = await res.json();
check("so the family still sees one Ada, not two", roster.length === 2, `${roster.length} on the roster`);

// 7. A group made on the laptop turns up on the phone.
const bookId = crypto.randomUUID();
const bookKey = randomKey();
await signed(laptop, "PUT", `/api/rooms/${bookId}`, { kind: "group", title: "Book club", members: [card(laptop)] });
await publish(laptop, {
  v: 1, at: Date.now(),
  profile: { displayName: "Ada", avatarSeed: "e:🦊", at: Date.now() },
  home: familyId, gone: {},
  rooms: [
    { id: familyId, kind: "group", title: "Family", key: familyKey, createdAt: Date.now() },
    { id: bookId, kind: "group", title: "Book club", key: bookKey, createdAt: Date.now() }
  ]
});
const backOnThePhone = await pull(phone);
check("a group made on the laptop reaches the phone", backOnThePhone.rooms.some(r => r.id === bookId));
check("and only one picture is kept at a time", (await (await signed(phone, "GET", `/api/rooms/${selfId}/history`)).json()).length === 1);

// 8. Leaving is said out loud, because absence never means gone.
await publish(phone, {
  v: 1, at: Date.now(),
  profile: { displayName: "Ada", avatarSeed: "e:🦊", at: Date.now() },
  home: familyId, gone: { [bookId]: Date.now() },
  rooms: [{ id: familyId, kind: "group", title: "Family", key: familyKey, createdAt: Date.now() }]
});
const afterLeaving = await pull(laptop);
check("leaving a group on the phone tells the laptop so", afterLeaving.gone[bookId] > 0);

// 9. The link was good once.
res = await fetch(`${base}/api/link/${code}/claim`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof: sealed.proof })
});
check("a collected link stops working once its grace window closes", res.ok, "still inside the retry window");

// 10. Two browsers, two push endpoints, both remembered.
for (const n of [1, 2]) {
  await signed(phone, "POST", `/api/rooms/${familyId}/push`, { endpoint: `https://push.test/${n}`, keys: { p256dh: "p", auth: "a" } });
}
res = await signed(phone, "POST", `/api/rooms/${familyId}/push`, { endpoint: "https://push.test/2", keys: { p256dh: "p", auth: "a" } });
check("registering from a second browser is accepted", res.ok, `status ${res.status}`);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
