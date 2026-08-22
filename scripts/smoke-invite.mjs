/**
 * End-to-end smoke test for spaces, channels and invite links against a running relay.
 *
 * The unit tests drive the Durable Objects as plain classes against a fake storage, which is the
 * right place to pin their rules but says nothing about whether the routes, the cross-object RPC
 * and the real signing agree with each other. This does the whole ceremony over HTTP: Ada makes a
 * group and a channel, mints a link, and Bo — who has never touched the relay — walks in on it.
 *
 *   node scripts/smoke-invite.mjs [http://localhost:8787]
 */
const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const enc = new TextEncoder();

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
    signPublicJwk: await crypto.subtle.exportKey("jwk", sign.publicKey),
    signPrivate: sign.privateKey
  };
}
const card = id => ({
  deviceId: id.deviceId, displayName: id.displayName, avatarSeed: id.avatarSeed,
  dhPublicJwk: id.dhPublicJwk, signPublicJwk: id.signPublicJwk
});

async function signed(id, method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = b64(crypto.getRandomValues(new Uint8Array(8)));
  const bodyHash = await sha256(body);
  const canonical = [method.toUpperCase(), path, ts, nonce, bodyHash].join("\n");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.signPrivate, enc.encode(canonical));
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Kin-Device": id.deviceId, "X-Kin-Time": ts, "X-Kin-Nonce": nonce,
      "X-Kin-Body": bodyHash, "X-Kin-Signature": b64(sig), "Content-Type": "application/json"
    },
    body: body || undefined
  });
  return res;
}

async function deriveAesFrom(secret, label, extractable = true) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`kin:${label}`));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`kin-${label}-v1`) },
    material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]
  );
}
const deriveChannelKey = async (spaceKey, channelId) =>
  b64(await crypto.subtle.exportKey("raw", await deriveAesFrom(unb64(spaceKey), `channel:${channelId}`)));

async function sealChannelMeta(spaceKey, meta) {
  const key = await deriveAesFrom(unb64(spaceKey), "channel-directory", false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { blob: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(meta)))), iv: b64(iv) };
}
async function openChannelMeta(spaceKey, blob, iv) {
  const key = await deriveAesFrom(unb64(spaceKey), "channel-directory", false);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(blob))));
}

const inviteCodeFor = async secret => (await sha256(`kin-invite-code:${secret}`)).slice(0, 16);
async function inviteMaterial(code, secret) {
  return { proof: await sha256(`kin-invite-proof:${code}:${secret}`), key: await deriveAesFrom(unb64(secret), `invite:${code}`, false) };
}
async function sealInvite(code, secret, roomKey) {
  const { proof, key } = await inviteMaterial(code, secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { proof, wrappedKey: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, unb64(roomKey))), iv: b64(iv) };
}
async function openInvite(code, secret, wrappedKey, iv) {
  const { proof, key } = await inviteMaterial(code, secret);
  return { proof, roomKey: b64(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(wrappedKey))) };
}

// ---------- the ceremony ----------

const ada = await identity("Ada");
const bo = await identity("Bo");

// 1. Ada makes a group.
const spaceId = crypto.randomUUID();
const spaceKey = randomKey();
let res = await signed(ada, "PUT", `/api/rooms/${spaceId}`, { kind: "group", title: "Japan trip", members: [card(ada)] });
check("Ada creates a group", res.status === 201, `status ${res.status}`);

// 2. Ada opens a channel in it. No key distribution — the key falls out of the space key.
const channelId = crypto.randomUUID();
const channelKey = await deriveChannelKey(spaceKey, channelId);
res = await signed(ada, "PUT", `/api/rooms/${channelId}`, { kind: "group", title: "Photos", members: [card(ada)], spaceId, keep: true });
check("Ada opens a kept channel in it", res.status === 201, `status ${res.status}`);

const sealedName = await sealChannelMeta(spaceKey, { title: "Photos", emoji: "📸" });
res = await signed(ada, "POST", `/api/rooms/${spaceId}/channels`, { id: channelId, ...sealedName });
check("the channel lands in the directory", res.ok, `status ${res.status}`);

res = await signed(ada, "GET", `/api/rooms/${spaceId}/channels`);
const directory = await res.json();
check("the relay stores a name it cannot read", !JSON.stringify(directory).includes("Photos"));
check("but a member can read it", (await openChannelMeta(spaceKey, directory[0].blob, directory[0].iv)).title === "Photos");

// 3. Ada mints a link to the group and goes away. Nothing below waits on her.
const secret = randomKey();
const code = await inviteCodeFor(secret);
const sealed = await sealInvite(code, secret, spaceKey);
res = await signed(ada, "PUT", `/api/invite/${code}`, {
  proof: sealed.proof, room: { id: spaceId, kind: "group", title: "Japan trip" },
  inviter: card(ada), role: "guest", wrappedKey: sealed.wrappedKey, iv: sealed.iv,
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, maxUses: 1
});
check("Ada mints a standing invite", res.status === 201, `status ${res.status}`);

// 4. Bo, who the relay has never seen, opens the link.
const preview = await (await fetch(`${base}/api/invite/${code}`)).json();
check("Bo can see what he was invited to", preview.room.title === "Japan trip");
check("the preview withholds the proof", preview.proof === undefined);

const opened = await openInvite(code, secret, preview.wrappedKey, preview.iv);
check("the secret in the fragment opens the room key", opened.roomKey === spaceKey);

res = await signed(bo, "POST", `/api/invite/${code}/redeem`, { proof: opened.proof, member: { ...card(bo), displayName: "Guest Otter" } });
check("Bo redeems it and is enrolled", res.ok, `status ${res.status}`);

res = await signed(bo, "GET", `/api/rooms/${spaceId}/members`);
const roster = await res.json();
check("Bo is on the roster as a guest", roster.find(m => m.deviceId === bo.deviceId)?.role === "guest");

// 5. Being in the space is enough to walk into its channels.
res = await signed(bo, "GET", `/api/rooms/${spaceId}/channels`);
const seen = await res.json();
check("Bo sees the channel directory", seen.length === 1, `${seen.length} channels`);
check("Bo can open the channel name", (await openChannelMeta(opened.roomKey, seen[0].blob, seen[0].iv)).title === "Photos");
check("Bo derives the same channel key Ada has", await deriveChannelKey(opened.roomKey, seen[0].id) === channelKey);

res = await signed(bo, "POST", `/api/rooms/${channelId}/join`, { ...card(bo), displayName: "Guest Otter" });
check("Bo walks into the channel unaided", res.ok, `status ${res.status}`);

// 6. A guest cannot hand out invites of their own.
const bosSecret = randomKey();
const bosCode = await inviteCodeFor(bosSecret);
const bosSeal = await sealInvite(bosCode, bosSecret, spaceKey);
res = await signed(bo, "PUT", `/api/invite/${bosCode}`, {
  proof: bosSeal.proof, room: { id: spaceId, kind: "group", title: "Japan trip" },
  inviter: card(bo), role: "guest", wrappedKey: bosSeal.wrappedKey, iv: bosSeal.iv,
  expiresAt: Date.now() + 60_000, maxUses: null
});
check("a guest cannot mint invites of their own", res.status === 403, `status ${res.status}`);

// 7. A one-use link is spent, and holding only the code gets nobody in.
const cass = await identity("Cass");
res = await signed(cass, "POST", `/api/invite/${code}/redeem`, { proof: opened.proof, member: card(cass) });
check("a spent one-use link turns the next person away", res.status === 410, `status ${res.status}`);

const dee = await identity("Dee");
const openSecret = randomKey();
const openCode = await inviteCodeFor(openSecret);
const openSeal = await sealInvite(openCode, openSecret, spaceKey);
await signed(ada, "PUT", `/api/invite/${openCode}`, {
  proof: openSeal.proof, room: { id: spaceId, kind: "group", title: "Japan trip" },
  inviter: card(ada), role: "viewer", wrappedKey: openSeal.wrappedKey, iv: openSeal.iv,
  expiresAt: Date.now() + 60_000, maxUses: null
});
res = await signed(dee, "POST", `/api/invite/${openCode}/redeem`, { proof: "not-the-proof", member: card(dee) });
check("knowing the code without the secret gets nobody in", res.status === 403, `status ${res.status}`);

res = await signed(dee, "POST", `/api/invite/${openCode}/redeem`, { proof: (await openInvite(openCode, openSecret, openSeal.wrappedKey, openSeal.iv)).proof, member: card(dee) });
check("Dee comes in on the viewer link", res.ok, `status ${res.status}`);

// 8. A viewer's messages are refused by the relay, not merely hidden by the client.
const createdAt = Date.now();
const envelope = {
  kind: "message", id: crypto.randomUUID(), conversationId: spaceId, senderDeviceId: dee.deviceId,
  createdAt, expiresAt: createdAt + 7 * 24 * 60 * 60 * 1000, iv: "aXY", ciphertext: "Y2lwaGVy"
};
const envText = [envelope.id, envelope.conversationId, envelope.senderDeviceId, envelope.createdAt, envelope.expiresAt, envelope.iv, envelope.ciphertext].join("\n");
envelope.signature = b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dee.signPrivate, enc.encode(envText)));
res = await fetch(`${base}/api/rooms/${spaceId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
check("the relay refuses a viewer's message", res.status === 401, `status ${res.status}`);

// 9. Revoking kills a link that still had uses left.
res = await signed(ada, "POST", `/api/invite/${openCode}/revoke`, { member: card(ada) });
check("Ada revokes the open link", res.ok, `status ${res.status}`);
const eve = await identity("Eve");
res = await signed(eve, "POST", `/api/invite/${openCode}/redeem`, { proof: (await openInvite(openCode, openSecret, openSeal.wrappedKey, openSeal.iv)).proof, member: card(eve) });
check("a revoked link lets nobody else in", res.status === 410, `status ${res.status}`);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
