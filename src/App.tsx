import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { decryptPayload, directConversation, encryptFile, encryptPayload, generateIdentity, publicMember, randomId, randomKey, safetyCode, signEnvelope, unwrapConversationKey, verifyEnvelope, wrapConversationKey } from "./lib/crypto";
import { deleteMessage, getBlob, getIdentity, getMessage, listConversations, listMessages, putConversation, putIdentity, putMessage } from "./lib/db";
import { currentPushStatus, isAppleTouchDevice, isStandalone, pushStatusLabel, registerPushForRooms, subscribeWebPush, type PushStatus } from "./lib/push";
import { addRoomMember, claimPair, completePair, createPair, createRoom, history as roomHistory, joinPair, pairStatus, relayConfig, roomMembers, sendEnvelope, uploadEncryptedFile, websocketUrl } from "./lib/relay";
import type { AttachmentPayload, ChatMessage, ChatPayload, CipherEnvelope, Conversation, LocalIdentity, PublicMember } from "./lib/types";
import { mediaKind, previewLabel, probeImage, rememberLocalFile, saveToDevice } from "./lib/media";
import { applyRoster } from "./lib/roster";
import { buzz, setSoundsOn, sounds, soundsOn } from "./lib/sound";
import { confetti, emojiBurst, isCelebration } from "./lib/effects";
import Aurora from "./components/Aurora";
import Doodle from "./components/Doodle";
import Onboarding, { ANIMALS } from "./components/Onboarding";
import { FileContent, ImageContent, Lightbox, useAttachmentUrl, VideoContent, VoiceContent } from "./components/Media";

type Panel = "none" | "pair" | "join" | "members" | "settings" | "attach" | "add" | "doodle" | "profile";
type InstallPrompt = Event & { prompt(): Promise<void> };
const MAX_FILE = 25 * 1024 * 1024;
const REACTIONS = ["❤️", "😂", "👍", "🎉", "😮", "😢"];

const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join("") || "•";
const hue = (s: string) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;
const seedEmoji = (seed: string) => seed.startsWith("e:") ? seed.slice(2) : null;
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s;
const time = (n: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(n);
const dayLabel = (n: number): string => {
  const d = new Date(n); const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(n);
};
const emojiOnly = (t: string): boolean => {
  const chars = Array.from(t.replace(/[‍️\s]/gu, ""));
  return chars.length > 0 && chars.length <= 6 && chars.every(c => /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u.test(c));
};
const greeting = (): string => {
  const h = new Date().getHours();
  return h < 5 ? "Up late? 🌙" : h < 12 ? "Good morning ☀️" : h < 18 ? "Good afternoon 🌤️" : "Good evening 🌙";
};

function Avatar({ member, size = 44 }: { member: PublicMember; size?: number }) {
  const emoji = seedEmoji(member.avatarSeed);
  return <span className="avatar" style={{ width: size, height: size, fontSize: emoji ? size * 0.56 : size * 0.36, background: `hsl(${hue(member.avatarSeed)} 65% var(--avatar-l))` }}>
    {emoji ?? initials(member.displayName)}
  </span>;
}

function Mark() { return <span className="mark"><i/><i/><i/></span>; }

export default function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(new URLSearchParams(location.search).get("conversation"));
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [pair, setPair] = useState<{ code: string; token: string; qr?: string; link?: string; safety?: string } | null>(null);
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get("pair") ?? "");
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [toast, setToast] = useState("");
  const [typing, setTyping] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [pushStatus, setPushStatus] = useState<PushStatus>("off");
  const [soundPref, setSoundPref] = useState(soundsOn());
  const [lightbox, setLightbox] = useState<{ att: AttachmentPayload; url: string } | null>(null);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const [shareIntake, setShareIntake] = useState<{ files: File[]; text: string } | null>(null);
  const [recent, setRecent] = useState<Record<string, ChatMessage[]>>({});

  const sockets = useRef(new Map<string, WebSocket>());
  const wanted = useRef(new Set<string>());
  const connecting = useRef(new Set<string>());
  const identityRef = useRef<LocalIdentity | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const recCancelled = useRef(false);
  const pushStatusRef = useRef<PushStatus>("off");
  const directCache = useRef(new Map<string, { id: string; key: string }>());
  const probedAt = useRef(new Map<string, number>());
  const sweeping = useRef(false);
  const discoverRef = useRef<() => void>(() => {});
  const cameraInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  identityRef.current = identity;
  activeIdRef.current = activeId;
  pushStatusRef.current = pushStatus;
  const active = conversations.find(c => c.id === activeId) ?? null;
  const activeMessages = messages[activeId ?? ""] ?? [];

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(""), 2400); };
  async function refresh() { setConversations(await listConversations()); }
  async function refreshPush() { setPushStatus(await currentPushStatus()); }

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      const id = await getIdentity();
      setIdentity(id);
      const cs = await listConversations();
      setConversations(cs);
      if (!activeIdRef.current && innerWidth > 760) setActiveId(cs[0]?.id ?? null);
      if (id && joinCode) setPanel("join");
      setReady(true);
      setPushStatus(await currentPushStatus());
    })();
    const onInstall = (e: Event) => { e.preventDefault(); setInstallPrompt(e as InstallPrompt); };
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    addEventListener("beforeinstallprompt", onInstall);
    addEventListener("online", onOnline);
    addEventListener("offline", onOffline);
    return () => { removeEventListener("beforeinstallprompt", onInstall); removeEventListener("online", onOnline); removeEventListener("offline", onOffline); };
  }, []);

  // ---------- service worker messages: push taps + background pushes ----------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; conversationId?: string } | undefined;
      if (data?.type === "kin-open" && data.conversationId) setActiveId(data.conversationId);
      if (data?.type === "kin-push" && data.conversationId && data.conversationId !== activeIdRef.current) {
        void (async () => {
          const current = (await listConversations()).find(c => c.id === data.conversationId);
          if (!current) return discoverRef.current();
          await putConversation({ ...current, unread: (current.unread ?? 0) + 1, lastPreview: current.lastPreview || "New message", lastMessageAt: Date.now() });
          await refresh();
        })();
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  // keep the push subscription registered on every room
  useEffect(() => {
    if (!identity || pushStatus !== "on") return;
    const ids = conversations.map(c => c.id);
    if (!ids.length) return;
    void registerPushForRooms(identity, ids).catch(() => { /* re-attempted next change */ });
  }, [identity?.deviceId, conversations.map(c => c.id).join(","), pushStatus]);

  // ---------- deep links: share target + shortcuts ----------
  useEffect(() => {
    if (!ready || !identity) return;
    const q = new URLSearchParams(location.search);
    if (q.get("shared") === "1") void intakeShare();
    if (q.get("compose") === "doodle" && conversations.length) {
      setActiveId(activeIdRef.current ?? conversations[0].id);
      setPanel("doodle");
      window.history.replaceState({}, "", "/");
    }
  }, [ready, identity?.deviceId, conversations.length]);

  async function intakeShare(): Promise<void> {
    try {
      const cache = await caches.open("kin-share");
      const files: File[] = []; let text = "";
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (res) {
          const url = new URL(req.url);
          if (url.pathname.endsWith("/text")) text = await res.text();
          else {
            const blob = await res.blob();
            files.push(new File([blob], decodeURIComponent(url.searchParams.get("name") ?? "shared"), { type: blob.type }));
          }
        }
        await cache.delete(req);
      }
      window.history.replaceState({}, "", "/");
      if (files.length || text) setShareIntake({ files, text });
    } catch { /* nothing shared */ }
  }

  // ---------- realtime: one socket per conversation ----------
  const conversationIds = conversations.map(c => c.id).sort().join(",");
  useEffect(() => {
    if (!identity) return;
    wanted.current = new Set(conversations.map(c => c.id));
    for (const id of wanted.current) if (!sockets.current.has(id)) void connect(id);
  }, [identity?.deviceId, conversationIds, online]);

  useEffect(() => () => {
    wanted.current.clear();
    sockets.current.forEach(s => s.close());
    sockets.current.clear();
  }, []);

  async function connect(convId: string): Promise<void> {
    const id = identityRef.current;
    if (!id || !wanted.current.has(convId) || connecting.current.has(convId) || sockets.current.has(convId)) return;
    connecting.current.add(convId);
    try {
      try { for (const env of await roomHistory(id, convId)) await ingest(convId, env, false); } catch { /* offline */ }
      const conv = (await listConversations()).find(c => c.id === convId);
      if (conv?.kind === "group") {
        try {
          const { conversation, refused } = applyRoster(conv, await roomMembers(id, convId));
          refused.forEach(warnKeyChange);
          await putConversation(conversation);
          await refresh();
        } catch { /* offline */ }
      }
      const socket = new WebSocket(await websocketUrl(id, convId));
      socket.onmessage = ev => { void handleFrame(convId, String(ev.data)); };
      socket.onclose = () => {
        sockets.current.delete(convId);
        if (wanted.current.has(convId)) setTimeout(() => void connect(convId), 4000);
      };
      sockets.current.set(convId, socket);
      if (!wanted.current.has(convId)) socket.close();
    } catch {
      if (wanted.current.has(convId)) setTimeout(() => void connect(convId), 6000);
    } finally { connecting.current.delete(convId); }
  }

  async function handleFrame(convId: string, raw: string): Promise<void> {
    const me = identityRef.current; if (!me) return;
    let f: { kind?: string; member?: PublicMember; senderDeviceId?: string; active?: boolean; messageId?: string };
    try { f = JSON.parse(raw); } catch { return; }
    if (f.kind === "message") await ingest(convId, f as unknown as CipherEnvelope, true);
    if (f.kind === "member" && f.member) {
      const member = f.member;
      const conv = (await listConversations()).find(c => c.id === convId);
      if (conv) {
        const { conversation, refused } = applyRoster(conv, [member]);
        if (refused.length) warnKeyChange(refused[0]);
        // a direct chat is titled after the other person, so a rename has to move the title too
        const peerRenamed = conv.kind === "direct" && member.deviceId !== me.deviceId && !refused.length;
        await putConversation({ ...conversation, ...(peerRenamed ? { title: member.displayName } : {}) });
        await refresh();
      }
    }
    if (f.kind === "typing" && f.senderDeviceId && f.senderDeviceId !== me.deviceId && convId === activeIdRef.current) {
      const sender = f.senderDeviceId;
      setTyping(t => f.active ? [...new Set([...t, sender])] : t.filter(x => x !== sender));
    }
    if (f.kind === "read" && f.senderDeviceId && f.messageId) await applyRead(convId, f.messageId);
  }

  async function ingest(convId: string, env: CipherEnvelope, fresh: boolean): Promise<void> {
    const me = identityRef.current; if (!me) return;
    if (await getMessage(env.id)) return;
    const conv = (await listConversations()).find(c => c.id === convId); if (!conv) return;
    const sender = conv.members.find(m => m.deviceId === env.senderDeviceId);
    if (!sender || !(await verifyEnvelope(env, sender))) return;
    try {
      const payload = await decryptPayload(env, conv.key);
      const m: ChatMessage = { id: env.id, conversationId: convId, senderDeviceId: env.senderDeviceId, createdAt: env.createdAt, payload, status: "delivered" };
      await putMessage(m);
      setMessages(x => ({ ...x, [convId]: [...(x[convId] ?? []).filter(y => y.id !== m.id), m].sort((a, b) => a.createdAt - b.createdAt) }));
      const mine = env.senderDeviceId === me.deviceId;
      if (payload.type === "event") {
        if (fresh && !mine && payload.event?.kind === "reaction" && payload.event.value) { emojiBurst(payload.event.value); sounds.react(); }
        return;
      }
      const activeAndVisible = convId === activeIdRef.current && !document.hidden;
      const unread = !mine && !activeAndVisible && env.createdAt > (conv.lastReadAt ?? 0) ? (conv.unread ?? 0) + 1 : conv.unread ?? 0;
      await putConversation({
        ...conv, lastMessageAt: m.createdAt, unread,
        lastPreview: payload.type === "text" ? payload.text ?? "" : payload.attachment ? previewLabel(payload.attachment) : "",
        lastPreviewSender: mine ? "You" : firstName(sender.displayName)
      });
      await refresh();
      if (fresh && !mine) {
        sounds.receive(); buzz(15);
        if (payload.type === "text" && payload.text && isCelebration(payload.text)) confetti();
        if (activeAndVisible) sendReadFrame(convId, m.id);
      }
    } catch { /* not for us */ }
  }

  /**
   * Somebody's device keys changed under us. We keep the keys we paired with, so anything signed
   * with the new one now fails verifyEnvelope and never renders — but that is silent, and a real
   * key change is indistinguishable from an impersonation attempt without a human looking. Say so.
   */
  function warnKeyChange(member: PublicMember): void {
    flash(`⚠️ ${firstName(member.displayName)}'s security keys changed — check with them in person`);
    buzz(40);
  }

  function sendReadFrame(convId: string, messageId: string): void {
    const s = sockets.current.get(convId);
    if (s?.readyState === 1) s.send(JSON.stringify({ kind: "read", messageId }));
  }

  async function applyRead(convId: string, messageId: string): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const target = await getMessage(messageId); if (!target) return;
    const msgs = await listMessages(convId);
    const updated: ChatMessage[] = [];
    for (const m of msgs) {
      if (m.senderDeviceId === me.deviceId && m.createdAt <= target.createdAt && m.status !== "read") {
        const r = { ...m, status: "read" as const };
        await putMessage(r); updated.push(r);
      }
    }
    if (updated.length) setMessages(x => ({ ...x, [convId]: (x[convId] ?? []).map(m => updated.find(u => u.id === m.id) ?? m) }));
  }

  async function markRead(convId: string): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const conv = (await listConversations()).find(c => c.id === convId); if (!conv) return;
    await putConversation({ ...conv, unread: 0, lastReadAt: Date.now() });
    await refresh();
    const msgs = await listMessages(convId);
    const lastIn = [...msgs].reverse().find(m => m.senderDeviceId !== me.deviceId && m.payload.type !== "event");
    if (lastIn) sendReadFrame(convId, lastIn.id);
  }

  // ---------- private chats someone else started ----------
  // A direct room id is derived from both device keys, so we can go looking for the rooms our family
  // members may have opened with us. The relay only answers for rooms we are already a member of,
  // which is exactly the ones they created naming us.
  const PROBE_EVERY = 90_000;

  async function directWith(me: LocalIdentity, peer: PublicMember): Promise<{ id: string; key: string }> {
    const hit = directCache.current.get(peer.deviceId);
    if (hit) return hit;
    const derived = await directConversation(me, peer);
    directCache.current.set(peer.deviceId, derived);
    return derived;
  }

  async function discoverDirectChats(force = false): Promise<void> {
    const me = identityRef.current;
    if (!me || !navigator.onLine || sweeping.current) return;
    if (force) probedAt.current.clear(); // opening the app, or a push we can't place, means look now
    sweeping.current = true;
    try {
      const convs = await listConversations();
      const known = new Set(convs.map(c => c.id));
      const peers = new Map<string, PublicMember>();
      for (const c of convs) for (const m of c.members) if (m.deviceId !== me.deviceId) peers.set(m.deviceId, m);
      const now = Date.now();
      for (const peer of peers.values()) {
        if (now - (probedAt.current.get(peer.deviceId) ?? 0) < PROBE_EVERY) continue;
        const direct = await directWith(me, peer);
        if (known.has(direct.id)) continue;
        probedAt.current.set(peer.deviceId, now);
        let envelopes: CipherEnvelope[];
        try { envelopes = await roomHistory(me, direct.id); }
        catch { continue; } // no such room yet — they haven't started one
        // The room exists: subscribe for pushes even while it is empty, so their first message nudges us.
        if (pushStatusRef.current === "on") void registerPushForRooms(me, [direct.id]).catch(() => { /* next sweep */ });
        if (!envelopes.length) continue;
        const stamps = envelopes.map(e => e.createdAt);
        await putConversation({
          id: direct.id, kind: "direct", title: peer.displayName, key: direct.key,
          members: [publicMember(me), peer],
          createdAt: Math.min(...stamps), lastMessageAt: Math.max(...stamps)
        });
        // refresh() hands it to the socket effect, which pulls the history and counts the unreads
        await refresh();
        sounds.receive(); buzz(15);
        flash(`${firstName(peer.displayName)} started a private chat 💬`);
      }
    } finally { sweeping.current = false; }
  }
  discoverRef.current = () => void discoverDirectChats(true);

  useEffect(() => {
    if (!ready || !identity) return;
    const sweep = (force: boolean) => { if (document.visibilityState === "visible") void discoverDirectChats(force); };
    sweep(true);
    const timer = setInterval(() => sweep(false), 30_000);
    const onVisible = () => sweep(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [ready, identity?.deviceId, conversationIds, online]);

  // ---------- open conversation ----------
  useEffect(() => {
    if (!identity || !activeId) return;
    void (async () => {
      setMessages(x => ({ ...x, [activeId]: x[activeId] ?? [] }));
      const cached = await listMessages(activeId);
      setMessages(x => ({ ...x, [activeId]: cached }));
      await markRead(activeId);
    })();
    setTyping([]); setReactFor(null);
    const onVisible = () => { if (!document.hidden && activeIdRef.current === activeId) void markRead(activeId); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [identity?.deviceId, activeId]);

  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [activeMessages.length, typing.length, activeId]);

  // The composer floats over the message list rather than pushing it up, so the list reserves room
  // for it in padding — which only works if we tell CSS how tall the composer actually is right now
  // (it grows with a long draft, and again while recording).
  const composerSize = useRef<ResizeObserver | null>(null);
  const composerBox = useCallback((el: HTMLDivElement | null) => {
    composerSize.current?.disconnect();
    composerSize.current = null;
    const root = document.documentElement.style;
    if (!el) { root.removeProperty("--composer-h"); return; }
    const measure = () => {
      root.setProperty("--composer-h", `${Math.round(el.offsetHeight)}px`);
      const list = scroll.current;
      // re-pin only if we were already at the bottom, so growing the draft never yanks the reader up
      if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 120) list.scrollTop = list.scrollHeight;
    };
    measure();
    composerSize.current = new ResizeObserver(measure);
    composerSize.current.observe(el);
  }, []);

  // the keyboard shrinks the viewport under us — keep the newest message in sight
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const onResize = () => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // ---------- app badge ----------
  useEffect(() => {
    const total = conversations.reduce((n, c) => n + (c.unread ?? 0), 0);
    const nav = navigator as Navigator & { setAppBadge?(n: number): void; clearAppBadge?(): void };
    if (total > 0) nav.setAppBadge?.(total); else nav.clearAppBadge?.();
  }, [conversations]);

  // ---------- sending ----------
  /** beforeSend runs after the payload is already sealed — it may upload, but must not mutate `payload`. */
  async function send(conv: Conversation, payload: ChatPayload, beforeSend?: () => Promise<void>): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const env = await signEnvelope(me, await encryptPayload(conv.id, conv.key, me.deviceId, payload));
    const optimistic: ChatMessage = { id: env.id, conversationId: conv.id, senderDeviceId: me.deviceId, createdAt: env.createdAt, payload, status: "sending" };
    await putMessage(optimistic);
    setMessages(x => ({ ...x, [conv.id]: [...(x[conv.id] ?? []), optimistic] }));
    if (payload.type !== "event") {
      await putConversation({
        ...conv, lastMessageAt: env.createdAt, lastReadAt: env.createdAt,
        lastPreview: payload.type === "text" ? payload.text ?? "" : payload.attachment ? previewLabel(payload.attachment) : "",
        lastPreviewSender: "You"
      });
      await refresh();
    }
    try {
      await beforeSend?.();
      await sendEnvelope(conv.id, env);
      const sent = { ...optimistic, status: "sent" as const };
      await putMessage(sent);
      setMessages(x => ({ ...x, [conv.id]: (x[conv.id] ?? []).map(m => m.id === env.id ? sent : m) }));
    } catch {
      const failed = { ...optimistic, status: "failed" as const };
      await putMessage(failed);
      setMessages(x => ({ ...x, [conv.id]: (x[conv.id] ?? []).map(m => m.id === env.id ? failed : m) }));
      flash(online ? "Couldn’t send — tap the message to retry" : "You’re offline — tap the message to retry");
    }
  }

  async function sendText(): Promise<void> {
    const text = draft.trim(); if (!text || !active) return;
    setDraft("");
    if (composer.current) composer.current.style.height = "";
    const s = sockets.current.get(active.id);
    if (s?.readyState === 1) s.send(JSON.stringify({ kind: "typing", active: false }));
    sounds.send(); buzz(8);
    if (isCelebration(text)) { confetti(); sounds.tada(); }
    await send(active, { type: "text", text });
  }

  async function sendFile(conv: Conversation, file: File, extra?: { durationMs?: number }): Promise<void> {
    const me = identityRef.current; if (!me) return;
    if (file.size > MAX_FILE) return flash("That’s too big — 25 MB max");
    const mime = file.type || "application/octet-stream";
    const fileId = randomId();
    const dims = mime.startsWith("image/") ? await probeImage(file) : null;
    await rememberLocalFile(fileId, file, file.name, mime);
    // Encrypt before building the payload: send() seals the payload immediately, so the file key has
    // to be in it already. Filling it in from beforeSend would ship an unopenable attachment.
    const encrypted = await encryptFile(file);
    const attachment: AttachmentPayload = {
      fileId, name: file.name, mime, size: file.size,
      iv: encrypted.iv, key: encrypted.key, sha256: encrypted.sha256,
      ...(dims ? { width: dims.width, height: dims.height, thumb: dims.thumb } : {}),
      ...(extra?.durationMs ? { durationMs: extra.durationMs } : {})
    };
    sounds.send(); buzz(8);
    await send(conv, { type: "file", attachment }, () =>
      uploadEncryptedFile(me, conv.id, fileId, encrypted.ciphertext, encrypted.sha256));
  }

  async function retry(m: ChatMessage): Promise<void> {
    if (!active || m.status !== "failed") return;
    await deleteMessage(m.id);
    setMessages(x => ({ ...x, [active.id]: (x[active.id] ?? []).filter(y => y.id !== m.id) }));
    if (m.payload.type === "file" && m.payload.attachment) {
      const stored = await getBlob(m.payload.attachment.fileId);
      if (!stored) return flash("Couldn’t retry that one");
      await sendFile(active, new File([stored.bytes], stored.name, { type: stored.mime }), { durationMs: m.payload.attachment.durationMs });
    } else if (m.payload.type === "text" && m.payload.text) {
      await send(active, m.payload);
    }
  }

  async function react(m: ChatMessage, emoji: string, at?: { x: number; y: number }): Promise<void> {
    if (!active) return;
    setReactFor(null);
    emojiBurst(emoji, at?.x, at?.y); sounds.react(); buzz(8);
    if (emoji === "🎉") confetti();
    await send(active, { type: "event", event: { kind: "reaction", targetId: m.id, value: emoji } });
  }

  // ---------- voice notes ----------
  useEffect(() => {
    if (!rec) return;
    setRecElapsed(0);
    const t = setInterval(() => setRecElapsed(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [rec]);

  async function startRecording(): Promise<void> {
    if (!active) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      const conv = active;
      const startedAt = Date.now();
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        setRec(null);
        const durationMs = Date.now() - startedAt;
        if (recCancelled.current || durationMs < 600 || !chunks.length) return;
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        void sendFile(conv, new File([new Blob(chunks, { type })], `voice-${startedAt}.${ext}`, { type }), { durationMs });
      };
      recCancelled.current = false;
      recorder.start();
      setRec(recorder);
      buzz(20);
    } catch { flash("Microphone not available"); }
  }

  // ---------- profile ----------
  async function saveProfile(name: string, avatar: string): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const next: LocalIdentity = { ...me, displayName: name.trim().slice(0, 32) || me.displayName, avatarSeed: `e:${avatar}` };
    await putIdentity(next);
    setIdentity(next);
    const mine = publicMember(next);
    const convs = await listConversations();
    for (const c of convs) {
      if (c.members.some(m => m.deviceId === next.deviceId)) {
        await putConversation({ ...c, members: c.members.map(m => m.deviceId === next.deviceId ? mine : m) });
      }
    }
    await refresh();
    setPanel("settings");
    // Every room re-broadcasts the updated member card to whoever is connected.
    const pushed = await Promise.allSettled(convs.map(c => addRoomMember(next, c.id, mine)));
    flash(pushed.some(r => r.status === "rejected") ? "Saved — your family will see it next time you’re online" : "Looking good! ✨");
  }

  // ---------- family lifecycle ----------
  async function createFamily(name: string, avatar: string, familyName: string): Promise<void> {
    const id = { ...(await generateIdentity(name)), avatarSeed: `e:${avatar}` };
    const group: Conversation = { id: randomId(), kind: "group", title: familyName, key: randomKey(), members: [publicMember(id)], createdAt: Date.now() };
    await putIdentity(id); await putConversation(group);
    try { await createRoom(id, group.id, "group", group.title, group.members); } catch { /* retried on next connect */ }
    setIdentity(id); await refresh(); setActiveId(group.id);
    confetti(); sounds.tada();
  }

  async function joinFamily(name: string | undefined, avatar: string | undefined, rawCode?: string): Promise<void> {
    let id = identity;
    if (!id) {
      id = { ...(await generateIdentity(name ?? "Family")), avatarSeed: avatar ? `e:${avatar}` : `e:🐻` };
      await putIdentity(id); setIdentity(id);
    }
    const code = (rawCode ?? joinCode).trim().toUpperCase(); if (!code) return;
    try {
      const { claimToken } = await joinPair(code, publicMember(id));
      flash("Knock knock… waiting to be let in 🚪");
      for (let i = 0; i < 90; i++) {
        try {
          const pkg = await claimPair(code, claimToken);
          const key = await unwrapConversationKey(id, pkg.creator, pkg.group.wrappedKey, pkg.group.wrapIv);
          let members = [pkg.creator, publicMember(id)];
          try { members = await roomMembers(id, pkg.group.id); } catch { /* keep pair members */ }
          const c: Conversation = { id: pkg.group.id, kind: "group", title: pkg.group.title, key, members, createdAt: Date.now() };
          await putConversation(c); await refresh(); setActiveId(c.id); setPanel("none");
          window.history.replaceState({}, "", "/");
          confetti(); sounds.tada(); flash(`You’re in! Safety check: ${pkg.safetyCode}`);
          return;
        } catch { await new Promise(r => setTimeout(r, 1000)); }
      }
      flash("That took too long — ask for a fresh code");
    } catch { flash("Hmm, that code didn’t work"); }
  }

  async function startPairing(): Promise<void> {
    if (!identity || !active || active.kind !== "group") return;
    setPanel("pair"); setPair(null);
    try {
      const p = await createPair(publicMember(identity), { id: active.id, title: active.title });
      const link = `${location.origin}${location.pathname}?pair=${encodeURIComponent(p.code)}`;
      setPair({ code: p.code, token: p.creatorToken, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 260 }) });
      for (let i = 0; i < 150; i++) {
        try {
          const status = await pairStatus(p.code, p.creatorToken);
          if (status.joiner) {
            const wrap = await wrapConversationKey(identity, status.joiner, active.key);
            await addRoomMember(identity, active.id, status.joiner);
            const code = await safetyCode(publicMember(identity), status.joiner);
            await completePair(p.code, { creator: publicMember(identity), group: { id: active.id, title: active.title, ...wrap }, safetyCode: code }, p.creatorToken);
            const current = (await listConversations()).find(c => c.id === active.id) ?? active;
            await putConversation({ ...current, members: [...current.members.filter(m => m.deviceId !== status.joiner!.deviceId), status.joiner] });
            await refresh();
            setPair(x => x ? { ...x, safety: code } : x);
            confetti(); sounds.tada();
            return;
          }
        } catch { /* keep polling */ }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch { flash("Couldn’t start pairing — are you online?"); }
  }

  async function privateChat(peer: PublicMember): Promise<void> {
    if (!identity) return;
    const d = await directWith(identity, peer);
    const existing = (await listConversations()).find(c => c.id === d.id);
    setPanel("none");
    if (existing) return setActiveId(existing.id); // don't clobber the history we already have
    const c: Conversation = { id: d.id, kind: "direct", title: peer.displayName, key: d.key, members: [publicMember(identity), peer], createdAt: Date.now() };
    try { await createRoom(identity, c.id, "direct", c.title, c.members); } catch { /* offline */ }
    await putConversation(c); await refresh(); setActiveId(c.id);
  }

  async function shareInvite(): Promise<void> {
    if (!pair?.link) return;
    try {
      if (navigator.share) await navigator.share({ title: "Join our family on Kin", text: `Join our family on Kin! Code: ${pair.code}`, url: pair.link });
      else { await navigator.clipboard.writeText(pair.link); flash("Invite link copied!"); }
    } catch { /* dismissed */ }
  }

  async function enableNotifications(): Promise<void> {
    const status = await currentPushStatus();
    if (status === "unavailable") return flash("Notifications aren’t available here");
    if (status === "needs-install") return flash("Add Kin to your Home Screen first");
    if (status === "blocked") return flash("Notifications are blocked in browser settings");
    if (!identity) return;
    try {
      const cfg = await relayConfig();
      if (!cfg.vapidPublicKey) return flash("Push not configured");
      const sub = await subscribeWebPush();
      const rooms = await listConversations();
      await registerPushForRooms(identity, rooms.map(c => c.id), sub);
      await refreshPush();
      flash("You’ll get a nudge for new messages 🔔");
    } catch (err) {
      await refreshPush();
      flash(err instanceof Error && err.message === "Permission denied" ? "Notifications were declined" : "Couldn’t enable notifications");
    }
  }

  async function deliverShare(conv: Conversation): Promise<void> {
    const intake = shareIntake; if (!intake) return;
    setShareIntake(null); setActiveId(conv.id);
    for (const f of intake.files) await sendFile(conv, f);
    if (intake.text) setDraft(intake.text);
  }

  // ---------- derived ----------
  const sorted = useMemo(() => [...conversations].sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)), [conversations]);
  const { visible, reactions } = useMemo(() => {
    const sortedMsgs = [...activeMessages].sort((a, b) => a.createdAt - b.createdAt);
    const reactions = new Map<string, Record<string, string[]>>();
    for (const m of sortedMsgs) {
      const ev = m.payload.event;
      if (m.payload.type !== "event" || !ev || ev.kind !== "reaction" || !ev.value) continue;
      const rec = reactions.get(ev.targetId) ?? {};
      const arr = rec[ev.value] ?? [];
      rec[ev.value] = arr.includes(m.senderDeviceId) ? arr.filter(d => d !== m.senderDeviceId) : [...arr, m.senderDeviceId];
      reactions.set(ev.targetId, rec);
    }
    return { visible: sortedMsgs.filter(m => m.payload.type !== "event"), reactions };
  }, [activeMessages]);
  // With one or two chats a list is mostly empty space — show a proper card for each instead.
  const showCards = sorted.length > 0 && sorted.length <= 3;
  // Reload on every conversation refresh rather than off a digest: a chat can gain messages without
  // its summary changing (history arriving for a chat we just discovered, for one).
  useEffect(() => {
    if (!showCards) return;
    let live = true;
    void (async () => {
      const rows = await Promise.all(sorted.map(async c =>
        [c.id, (await listMessages(c.id)).filter(m => m.payload.type !== "event").slice(-3)] as const));
      if (live) setRecent(Object.fromEntries(rows));
    })();
    return () => { live = false; };
  }, [showCards, sorted]);

  const typingNames = typing.map(d => active?.members.find(m => m.deviceId === d)?.displayName).filter(Boolean).map(n => firstName(n!));
  const showIosInstall = isAppleTouchDevice() && !isStandalone();

  if (!ready) return <div className="splash"><Aurora/><Mark/></div>;
  if (!identity) return <Onboarding pairCode={joinCode} create={createFamily} join={(n, a, c) => joinFamily(n, a, c)}/>;

  return <div className="app">
    <Aurora/>
    {!online && <div className="offline-bar">📡 You’re offline — messages will send when you’re back</div>}
    <aside className={`sidebar ${active ? "has-active" : ""}`}>
      <header>
        <div className="wordmark"><Mark/><strong>Kin</strong></div>
        <button className="round" onClick={() => setPanel("settings")} aria-label="Settings"><Avatar member={publicMember(identity)} size={38}/></button>
      </header>
      <p className="greeting">{greeting()} <b>{firstName(identity.displayName)}</b></p>
      <div className={`conversation-list ${showCards ? "as-cards" : ""}`}>
        {showCards && sorted.map(c => <FamilyCard key={c.id} c={c} self={identity.deviceId} active={c.id === activeId}
          recent={recent[c.id] ?? []} onOpen={() => setActiveId(c.id)}
          onInvite={() => { setActiveId(c.id); void startPairing(); }}/>)}
        {!showCards && sorted.map(c => <button key={c.id} className={`conversation ${c.id === activeId ? "active" : ""}`} onClick={() => setActiveId(c.id)}>
          <ConversationAvatar c={c} self={identity.deviceId}/>
          <span>
            <strong>{c.kind === "group" ? `${c.title} 🏡` : c.title}</strong>
            <small>{c.lastPreview ? `${c.lastPreviewSender ? `${c.lastPreviewSender}: ` : ""}${c.lastPreview}` : c.kind === "group" ? `${c.members.length} of you` : "Just the two of you"}</small>
          </span>
          <span className="conversation-meta">
            <time>{c.lastMessageAt ? time(c.lastMessageAt) : ""}</time>
            {(c.unread ?? 0) > 0 && <i className="unread">{(c.unread ?? 0) > 9 ? "9+" : c.unread}</i>}
          </span>
        </button>)}
      </div>
      <button className="new-chat" onClick={() => setPanel("add")} aria-label="Add">+</button>
    </aside>

    <main className={`chat ${active ? "open" : ""}`}>
      {active ? <>
        <header className="chat-head">
          <button className="back" onClick={() => setActiveId(null)} aria-label="Back">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5"/></svg>
          </button>
          <button className="chat-person" onClick={() => active.kind === "group" && setPanel("members")}>
            <ConversationAvatar c={active} self={identity.deviceId} small/>
            <span>
              <strong>{active.kind === "group" ? `${active.title} 🏡` : active.title}</strong>
              <small>{typingNames.length ? `${typingNames.join(" and ")} is typing…` : active.kind === "group" ? active.members.map(m => firstName(m.displayName)).join(", ") : "Private chat"}</small>
            </span>
          </button>
          {active.kind === "group" && <button className="round" onClick={() => void startPairing()} aria-label="Invite">💌</button>}
        </header>

        <div className="messages" ref={scroll} onClick={() => setReactFor(null)}>
          {active.kind === "group" && active.members.length === 1 && <div className="invite-card">
            <span className="invite-emoji">👨‍👩‍👧‍👦</span>
            <strong>It’s just you so far!</strong>
            <p>Invite your family — open Kin on their phone, scan your code, and you’re together.</p>
            <button className="primary" onClick={() => void startPairing()}>Invite my family 💌</button>
          </div>}
          {visible.length === 0 && active.members.length > 1 && <div className="hello-card">👋<p>Say hi!</p></div>}
          {visible.map((m, i) => {
            const prev = visible[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return <Fragment key={m.id}>
              {newDay && <div className="day"><span>{dayLabel(m.createdAt)}</span></div>}
              <Bubble m={m} prev={newDay ? undefined : prev} me={identity.deviceId} identity={identity} c={active}
                reactions={reactions.get(m.id)}
                reacting={reactFor === m.id}
                onReactBar={() => setReactFor(x => x === m.id ? null : m.id)}
                onReact={(emoji, at) => void react(m, emoji, at)}
                onOpenMedia={(att, url) => setLightbox({ att, url })}
                onRetry={() => void retry(m)}/>
            </Fragment>;
          })}
          {typingNames.length > 0 && <div className="typing"><i/><i/><i/></div>}
        </div>

        <div className="composer" ref={composerBox}>
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={e => { const f = e.target.files?.[0]; if (f && active) void sendFile(active, f); e.currentTarget.value = ""; }}/>
          <input ref={mediaInput} type="file" accept="image/*,video/*" multiple hidden onChange={e => { const fs = [...(e.target.files ?? [])]; if (active) fs.forEach(f => void sendFile(active, f)); e.currentTarget.value = ""; }}/>
          <input ref={fileInput} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f && active) void sendFile(active, f); e.currentTarget.value = ""; }}/>
          {rec ? <div className="recording">
            <button className="round rec-cancel" onClick={() => { recCancelled.current = true; rec.stop(); }} aria-label="Cancel">✕</button>
            <span className="rec-live"><i/>Recording… {Math.floor(recElapsed / 60)}:{String(recElapsed % 60).padStart(2, "0")}</span>
            <button className="send rec-send" onClick={() => rec.stop()} aria-label="Send voice note">↑</button>
          </div> : <>
            <button className="composer-btn" onClick={() => setPanel("attach")} aria-label="Attach">＋</button>
            <button className="composer-btn" onClick={() => setPanel("doodle")} aria-label="Doodle">🖍️</button>
            <textarea ref={composer} rows={1} placeholder={`Message ${active.kind === "direct" ? firstName(active.title) : "everyone"}…`} value={draft}
              onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(130, e.target.scrollHeight)}px`; const s = sockets.current.get(active.id); if (s?.readyState === 1) s.send(JSON.stringify({ kind: "typing", active: !!e.target.value })); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendText(); } }}/>
            {draft.trim()
              ? <button className="send" onClick={() => void sendText()} aria-label="Send">↑</button>
              : <button className="composer-btn mic" onClick={() => void startRecording()} aria-label="Record voice note">🎤</button>}
          </>}
        </div>
      </> : <div className="empty"><Mark/><span>Pick a chat to get cozy</span></div>}
    </main>

    {panel === "doodle" && active && <Doodle onClose={() => setPanel("none")} onSend={blob => {
      setPanel("none");
      void sendFile(active, new File([blob], `doodle-${Date.now()}.png`, { type: "image/png" }));
    }}/>}

    {lightbox && <Lightbox att={lightbox.att} url={lightbox.url} onClose={() => setLightbox(null)}/>}

    {shareIntake && <div className="scrim" onMouseDown={e => e.target === e.currentTarget && setShareIntake(null)}><section className="sheet"><div className="grab"/>
      <h2>Send to…</h2>
      <p className="sheet-sub">{shareIntake.files.length ? `${shareIntake.files.length} file${shareIntake.files.length > 1 ? "s" : ""} to share` : "Shared text"}</p>
      {sorted.map(c => <button key={c.id} className="member" onClick={() => void deliverShare(c)}>
        <ConversationAvatar c={c} self={identity.deviceId}/><span><strong>{c.title}</strong><small>{c.kind === "group" ? `${c.members.length} of you` : "Private chat"}</small></span>
      </button>)}
    </section></div>}

    {panel !== "none" && panel !== "doodle" && <div className="scrim" onMouseDown={e => e.target === e.currentTarget && setPanel("none")}><section className="sheet"><div className="grab"/>
      {panel === "attach" && active && <>
        <h2>Send something fun</h2>
        <div className="attach-grid">
          <button onClick={() => { setPanel("none"); cameraInput.current?.click(); }}><span>📸</span>Camera</button>
          <button onClick={() => { setPanel("none"); mediaInput.current?.click(); }}><span>🖼️</span>Photos</button>
          <button onClick={() => setPanel("doodle")}><span>🖍️</span>Doodle</button>
          <button onClick={() => { setPanel("none"); fileInput.current?.click(); }}><span>📎</span>File</button>
        </div>
      </>}
      {panel === "add" && <>
        <h2>Bring people in</h2>
        {sorted.filter(c => c.kind === "group").map(c => <button key={c.id} className="member" onClick={() => { setActiveId(c.id); void startPairing(); }}>
          <span className="member-emoji">💌</span><span><strong>Invite to {c.title}</strong><small>Show a code or QR to scan</small></span>
        </button>)}
        <button className="member" onClick={() => setPanel("join")}><span className="member-emoji">🔗</span><span><strong>Join with a code</strong><small>Someone sent you an invite</small></span></button>
      </>}
      {panel === "pair" && <>
        <h2>Add a family member</h2>
        {!pair && <div className="hello-card">⏳<p>Getting your code…</p></div>}
        {pair && (pair.safety
          ? <div className="paired"><b>🎉</b><strong>They’re in!</strong><div>{pair.safety}</div><small>See these same emoji on both phones? You’re safely connected.</small></div>
          : <><img className="qr" src={pair.qr} alt="Invite QR code"/><div className="code">{pair.code}</div><small>Scan the QR on their phone, or type the code into Kin</small>
              <div className="pair-actions">
                <button className="chip-btn" onClick={() => { void navigator.clipboard.writeText(pair.link ?? pair.code); flash("Copied!"); }}>Copy link</button>
                <button className="chip-btn" onClick={() => void shareInvite()}>Share invite</button>
              </div></>)}
      </>}
      {panel === "join" && <>
        <h2>Join a family</h2>
        <input className="code-input" autoFocus placeholder="Invite code" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && void joinFamily(undefined, undefined, joinCode)}/>
        <button className="primary" onClick={() => void joinFamily(undefined, undefined, joinCode)}>Join 🎉</button>
      </>}
      {panel === "members" && active && <>
        <div className="sheet-title"><h2>{active.title} 🏡</h2><button onClick={() => void startPairing()} aria-label="Invite">💌</button></div>
        {active.members.map(m => {
          const alerted = active.keyAlerts?.includes(m.deviceId);
          return <button className={`member${alerted ? " member-alert" : ""}`} key={m.deviceId} disabled={m.deviceId === identity.deviceId} onClick={() => void privateChat(m)}>
            <Avatar member={m}/><span>
              <strong>{alerted ? "⚠️ " : ""}{m.displayName}{m.deviceId === identity.deviceId ? " · you" : ""}</strong>
              <small>{alerted ? "Security keys changed — check with them in person" : m.deviceId === identity.deviceId ? "This device" : "Tap for a private chat"}</small>
            </span>
          </button>;
        })}
      </>}
      {panel === "profile" && <ProfileEditor identity={identity} onCancel={() => setPanel("settings")} onSave={(n, a) => void saveProfile(n, a)}/>}
      {panel === "settings" && <>
        <button className="profile" onClick={() => setPanel("profile")}>
          <Avatar member={publicMember(identity)} size={64}/>
          <span><strong>{identity.displayName}</strong><small>That’s you — tap to change your name or animal</small></span>
          <b className="profile-edit">✏️</b>
        </button>
        <button className="setting" onClick={() => { const on = !soundPref; setSoundsOn(on); setSoundPref(on); if (on) sounds.react(); }}><span>🔊</span>Sounds<b>{soundPref ? "On" : "Off"}</b></button>
        {installPrompt && <button className="setting" onClick={() => void installPrompt.prompt()}><span>📲</span>Install Kin on this device</button>}
        {showIosInstall && <div className="hint"><strong>📲 Install Kin</strong><small>Tap Share, then Add to Home Screen. Open the icon to get notifications.</small></div>}
        <button className="setting" onClick={() => void enableNotifications()}><span>🔔</span>Notifications<b>{pushStatusLabel(pushStatus)}</b></button>
        <button className="setting" onClick={() => setPanel("join")}><span>🔗</span>Join with a code</button>
        <small className="privacy">🔒 End-to-end encrypted · the relay only holds scrambled messages, and only for 7 days · photos & doodles live safely on your devices</small>
      </>}
    </section></div>}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function FamilyRing({ c, self }: { c: Conversation; self: string }) {
  const others = c.members.filter(m => m.deviceId !== self);
  const shown = (others.length ? others : c.members).slice(0, 6);
  // One face has nothing to ring around — sit it in the middle and tuck the badge into the corner.
  const solo = shown.length < 2;
  const radius = solo ? 0 : shown.length === 2 ? 34 : 38;
  const size = solo ? 66 : shown.length < 4 ? 42 : 34;
  // a pair reads better side by side than stacked
  const start = shown.length === 2 ? Math.PI : -Math.PI / 2;
  return <span className={`ring ${solo ? "solo" : ""}`} aria-hidden="true">
    <b className="ring-core">{c.kind === "group" ? "🏡" : "💌"}</b>
    {shown.map((m, i) => {
      const angle = (i / shown.length) * Math.PI * 2 + start;
      return <i key={m.deviceId} style={{
        margin: -size / 2,
        transform: `translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius}px)`
      }}>
        <Avatar member={m} size={size}/>
      </i>;
    })}
  </span>;
}

function FamilyCard({ c, self, active, recent, onOpen, onInvite }: {
  c: Conversation; self: string; active: boolean; recent: ChatMessage[]; onOpen(): void; onInvite(): void;
}) {
  const others = c.members.filter(m => m.deviceId !== self);
  const alone = c.kind === "group" && others.length === 0;
  const unread = c.unread ?? 0;
  const nameOf = (deviceId: string): string =>
    deviceId === self ? "You" : firstName(c.members.find(m => m.deviceId === deviceId)?.displayName ?? "Someone");
  return <div className={`family-card ${active ? "active" : ""} ${unread > 0 ? "buzzing" : ""}`}>
    <button className="family-open" onClick={onOpen}>
      <FamilyRing c={c} self={self}/>
      <span className="family-head">
        <strong>{c.kind === "group" ? `${c.title} 🏡` : c.title}</strong>
        <small>{alone ? "Just you so far" : c.kind === "group"
          ? `${c.members.length} of you · ${others.map(m => firstName(m.displayName)).join(", ")}`
          : "Private chat"}</small>
      </span>
      {unread > 0 && <i className="unread">{unread > 9 ? "9+" : unread}</i>}
    </button>
    {recent.length > 0 && <button className="family-recent" onClick={onOpen}>
      {recent.map(m => <span key={m.id} className="family-line">
        <b>{nameOf(m.senderDeviceId)}</b>
        <em>{m.payload.type === "file" && m.payload.attachment ? previewLabel(m.payload.attachment) : m.payload.text}</em>
        <time>{time(m.createdAt)}</time>
      </span>)}
    </button>}
    {alone
      ? <button className="family-invite" onClick={onInvite}>💌 Invite your family</button>
      : recent.length === 0 && <span className="family-empty">Nothing yet — say hi 👋</span>}
  </div>;
}

function ProfileEditor({ identity, onSave, onCancel }: { identity: LocalIdentity; onSave(name: string, avatar: string): void; onCancel(): void }) {
  const [name, setName] = useState(identity.displayName);
  const [avatar, setAvatar] = useState(() => seedEmoji(identity.avatarSeed) ?? ANIMALS[0]);
  const changed = name.trim() !== identity.displayName || `e:${avatar}` !== identity.avatarSeed;
  return <>
    <h2>Your look</h2>
    <div className="profile-preview"><span className="brand-blob">{avatar}</span></div>
    <label className="onboard-label">Pick your animal</label>
    <div className="animal-grid">
      {ANIMALS.map(a => <button key={a} className={`animal ${avatar === a ? "picked" : ""}`} onClick={() => setAvatar(a)} aria-label={a}>{a}</button>)}
    </div>
    <label className="onboard-label">Your name</label>
    <input className="name-input" placeholder="What’s your name?" maxLength={24} value={name}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && name.trim()) onSave(name, avatar); }}/>
    <div className="profile-actions">
      <button className="chip-btn" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={!name.trim() || !changed} onClick={() => onSave(name, avatar)}>Save ✨</button>
    </div>
  </>;
}

function ConversationAvatar({ c, self, small = false }: { c: Conversation; self: string; small?: boolean }) {
  const peer = c.members.find(m => m.deviceId !== self) ?? c.members[0];
  if (c.kind === "direct") return peer ? <Avatar member={peer} size={small ? 38 : 52}/> : <span className="avatar"/>;
  const people = c.members.filter(m => m.deviceId !== self).slice(0, 3);
  if (!people.length && c.members[0]) people.push(c.members[0]);
  return <span className={`stack ${small ? "small" : ""}`}>{people.map(p => <Avatar key={p.deviceId} member={p} size={small ? 27 : 34}/>)}</span>;
}

function Bubble({ m, prev, me, identity, c, reactions, reacting, onReactBar, onReact, onOpenMedia, onRetry }: {
  m: ChatMessage; prev?: ChatMessage; me: string; identity: LocalIdentity; c: Conversation;
  reactions?: Record<string, string[]>; reacting: boolean;
  onReactBar(): void; onReact(emoji: string, at?: { x: number; y: number }): void;
  onOpenMedia(att: AttachmentPayload, url: string): void; onRetry(): void;
}) {
  const mine = m.senderDeviceId === me;
  const sender = c.members.find(x => x.deviceId === m.senderDeviceId);
  const grouped = !!prev && prev.senderDeviceId === m.senderDeviceId && m.createdAt - prev.createdAt < 5 * 60_000;
  const showName = c.kind === "group" && !mine && !grouped;
  const press = useRef<number | null>(null);
  const chips = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  const big = m.payload.type === "text" && !!m.payload.text && emojiOnly(m.payload.text);

  const startPress = (e: React.PointerEvent): void => {
    if (e.button === 2) return;
    press.current = window.setTimeout(() => { press.current = null; onReactBar(); buzz(10); }, 420);
  };
  const endPress = (): void => { if (press.current) { clearTimeout(press.current); press.current = null; } };

  return <div className={`row ${mine ? "mine" : "theirs"} ${grouped ? "grouped" : ""}`}>
    {c.kind === "group" && !mine && <span className="row-avatar">{!grouped && sender && <Avatar member={sender} size={30}/>}</span>}
    <div className="bubble-wrap" onClick={e => e.stopPropagation()}>
      {reacting && <div className="react-bar">
        {REACTIONS.map(r => <button key={r} onClick={e => onReact(r, { x: e.clientX, y: e.clientY })}>{r}</button>)}
      </div>}
      <div className={`bubble ${big ? "big-emoji" : ""} ${m.payload.type === "file" ? "media-bubble" : ""} ${m.status === "sending" ? "pending" : ""} ${m.status === "failed" ? "failed" : ""}`}
        onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
        onContextMenu={e => { e.preventDefault(); onReactBar(); }}
        onClick={() => { if (m.status === "failed") onRetry(); }}>
        {showName && sender && <small className="sender" style={{ color: `hsl(${hue(sender.avatarSeed)} 55% var(--name-l))` }}>{firstName(sender.displayName)}</small>}
        {m.payload.type === "text" && <span className="text">{m.payload.text}</span>}
        {m.payload.type === "file" && m.payload.attachment && <MediaBody att={m.payload.attachment} identity={identity} c={c} onOpenMedia={onOpenMedia}/>}
        <small className="stamp">{time(m.createdAt)}{mine && <b className={`tick ${m.status ?? ""}`}>{m.status === "failed" ? " ⚠ tap to retry" : m.status === "sending" ? " ◌" : m.status === "read" ? " ✓✓" : " ✓"}</b>}</small>
      </div>
      {chips.length > 0 && <div className={`chips ${mine ? "chips-mine" : ""}`}>
        {chips.map(([emoji, who]) => <button key={emoji} className={who.includes(me) ? "me" : ""} onClick={e => onReact(emoji, { x: e.clientX, y: e.clientY })}>{emoji}{who.length > 1 && <b>{who.length}</b>}</button>)}
      </div>}
      <button className="react-hint" aria-label="React" onClick={onReactBar}>☺</button>
    </div>
  </div>;
}

function MediaBody({ att, identity, c, onOpenMedia }: { att: AttachmentPayload; identity: LocalIdentity; c: Conversation; onOpenMedia(att: AttachmentPayload, url: string): void }) {
  const gone = useAttachmentUrl(identity, c, att);
  const kind = mediaKind(att);
  if (kind === "image") return <ImageContent {...gone} att={att} onOpen={() => gone.url && onOpenMedia(att, gone.url)}/>;
  if (kind === "video") return <VideoContent {...gone} att={att}/>;
  if (kind === "audio") return <VoiceContent {...gone} att={att}/>;
  return <FileContent {...gone} att={att} onOpen={() => void saveToDevice(att.fileId, att.name)}/>;
}
