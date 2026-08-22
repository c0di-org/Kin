import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { directConversation, encryptFile, encryptPayload, generateIdentity, publicMember, randomId, randomKey, safetyCode, signEnvelope, unwrapConversationKey, wrapConversationKey } from "./lib/crypto";
import { deleteConversation, deleteMessage, dismissDirect, dismissedDirects, getBlob, getIdentity, getMessage, listConversations, listMessages, putConversation, putIdentity, putMessage, undismissDirect } from "./lib/db";
import { currentPushStatus, isAppleTouchDevice, isStandalone, pushStatusLabel, registerPushForRooms, subscribeWebPush, type PushStatus } from "./lib/push";
import { addRoomMember, claimPair, completePair, createPair, createRoom, history as roomHistory, joinPair, pairStatus, relayConfig, removeRoomMember, roomMembers, sendEnvelope, uploadEncryptedFile } from "./lib/relay";
import type { AttachmentPayload, ChatMessage, ChatPayload, CipherEnvelope, Conversation, InvitePreview, LocalIdentity, PublicMember } from "./lib/types";
import { mediaKind, previewLabel, probeImage, rememberLocalFile, saveToDevice } from "./lib/media";
import {
  acceptInvite, canPost, createChannel, createSpace, discoverChannels, isFullMember,
  parseInviteLink, removeChannel, spaceTree
} from "./lib/spaces";
import { deletedIds, firstName, mergeMessages, previewOf, redact } from "./lib/ingest";
import { dayLabel, greeting, listStamp } from "./lib/format";
import { useConversationSync } from "./hooks/useConversationSync";
import { buzz, setSoundsOn, sounds, soundsOn } from "./lib/sound";
import { confetti, emojiBurst, isCelebration } from "./lib/effects";
import Aurora from "./components/Aurora";
import Doodle from "./components/Doodle";
import Onboarding from "./components/Onboarding";
import { Lightbox } from "./components/Media";
import { Avatar, ConversationAvatar, Mark } from "./components/Avatar";
import { FamilyCard } from "./components/FamilyCard";
import { ProfileEditor } from "./components/ProfileEditor";
import { InvitePanel } from "./components/InvitePanel";
import JoinInvite from "./components/JoinInvite";
import NewSpace from "./components/NewSpace";
import { Bubble, type QuotedMessage } from "./components/Bubble";
import { Sheet } from "./components/Sheet";

type Panel = "none" | "pair" | "invite" | "join" | "members" | "settings" | "attach" | "add" | "doodle" | "profile" | "new";
type InstallPrompt = Event & { prompt(): Promise<void> };
const MAX_FILE = 25 * 1024 * 1024;
const REACTIONS = ["❤️", "😂", "👍", "🎉", "😮", "😢"];
const PANEL_LABELS: Record<Panel, string> = {
  none: "", doodle: "Doodle", pair: "Add someone in person", invite: "Share a link",
  join: "Join with a code", members: "Chat details", settings: "Settings",
  attach: "Send something", add: "Start something", profile: "Your look",
  new: "Make a new place"
};


export default function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(new URLSearchParams(location.search).get("conversation"));
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [pair, setPair] = useState<{ code: string; token: string; qr?: string; link?: string; safety?: string } | null>(null);
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get("pair") ?? "");
  const [inviteLanding, setInviteLanding] = useState(() => parseInviteLink(location.hash));
  const [newIn, setNewIn] = useState<Conversation | null>(null);
  const [openSpaces, setOpenSpaces] = useState<Record<string, boolean>>({});
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
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  // Destructive actions confirm in place. A second sheet over the first would have to argue with
  // the first one over focus and inert, for a question that fits on one line.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const identityRef = useRef<LocalIdentity | null>(identity);
  const activeIdRef = useRef<string | null>(activeId);
  const recCancelled = useRef(false);
  const pushStatusRef = useRef<PushStatus>(pushStatus);
  const directCache = useRef(new Map<string, { id: string; key: string }>());
  const probedAt = useRef(new Map<string, number>());
  const sweeping = useRef(false);
  const flushing = useRef(false);
  const discoverRef = useRef<() => void>(() => {});
  const cameraInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  // These mirror state for the async callbacks — sockets, timers, service-worker messages — that
  // outlive the render that created them. Writing them during render is benign today but is a
  // landmine under concurrent React, which may render without committing. The initial values above
  // cover the first render; these keep them current after every commit.
  useEffect(() => { identityRef.current = identity; }, [identity]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { pushStatusRef.current = pushStatus; }, [pushStatus]);

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
    const onOnline = () => { setOnline(true); void flushFailed(); };
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

  const conversationIds = conversations.map(c => c.id).sort().join(",");

  // ---------- realtime ----------
  // The sync layer owns sockets, history replay and decryption; everything it hands back is
  // already verified. What it deliberately does not do is make noise — the reactions below are
  // the app's, which is what lets the message handling be tested without a speaker attached.
  const sync = useConversationSync({
    identity, conversations, activeId, online,
    events: {
      onMessages: (convId, incoming) => setMessages(x => ({ ...x, [convId]: mergeMessages(x[convId] ?? [], incoming) })),
      onConversationsChanged: () => { void refresh(); },
      onTyping: (convId, senderDeviceId, active) => {
        if (convId !== activeIdRef.current) return;
        setTyping(t => active ? [...new Set([...t, senderDeviceId])] : t.filter(x => x !== senderDeviceId));
      },
      onKeyChange: warnKeyChange,
      onIncoming: (convId, { message }) => {
        const payload = message.payload;
        if (payload.type === "event") {
          if (payload.event?.kind === "reaction" && payload.event.value) { emojiBurst(payload.event.value); sounds.react(); }
          return;
        }
        sounds.receive(); buzz(15);
        if (payload.type === "text" && payload.text && isCelebration(payload.text)) confetti();
        if (convId === activeIdRef.current && !document.hidden) sync.sendRead(convId, message.id);
      }
    }
  });
  /**
   * Somebody's device keys changed under us. We keep the keys we paired with, so anything signed
   * with the new one now fails verification and never renders — but that is silent, and a real
   * key change is indistinguishable from an impersonation attempt without a human looking. Say so.
   */
  function warnKeyChange(member: PublicMember): void {
    flash(`⚠️ ${firstName(member.displayName)}'s security keys changed — check with them in person`);
    buzz(40);
  }

  async function markRead(convId: string): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const conv = (await listConversations()).find(c => c.id === convId); if (!conv) return;
    await putConversation({ ...conv, unread: 0, lastReadAt: Date.now() });
    await refresh();
    const msgs = await listMessages(convId);
    const lastIn = [...msgs].reverse().find(m => m.senderDeviceId !== me.deviceId && m.payload.type !== "event");
    if (lastIn) sync.sendRead(convId, lastIn.id);
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
      const dismissed = await dismissedDirects();
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
        // A chat we deleted comes back only if they have said something since.
        const dismissedAt = dismissed[direct.id];
        if (dismissedAt !== undefined) {
          if (Math.max(...stamps) <= dismissedAt) continue;
          await undismissDirect(direct.id);
        }
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
  useEffect(() => { discoverRef.current = () => void discoverDirectChats(true); });

  useEffect(() => {
    if (!ready || !identity) return;
    const sweep = (force: boolean) => {
      if (document.visibilityState !== "visible") return;
      void discoverDirectChats(force);
      void sweepChannels();
      void flushFailed();
    };
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
    setTyping([]); setReactFor(null); setReplyTo(null); setConfirming(null);
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
        lastPreview: previewOf(payload),
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
      // A flush is already going to say how it went, once, rather than once per message.
      if (!flushing.current) flash(navigator.onLine
        ? "Couldn’t send — tap the message to retry"
        : "Saved — this goes out when you’re back online");
    }
  }

  async function sendText(): Promise<void> {
    const text = draft.trim(); if (!text || !active) return;
    const quoting = replyTo;
    setDraft(""); setReplyTo(null);
    if (composer.current) composer.current.style.height = "";
    sync.sendTyping(active.id, false);
    sounds.send(); buzz(8);
    if (isCelebration(text)) { confetti(); sounds.tada(); }
    await send(active, { type: "text", text, ...(quoting ? { replyTo: quoting.id } : {}) });
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

  /**
   * Send a failed message again, as a fresh envelope. Throws if it cannot be reconstructed, so
   * the caller can leave it sitting there as failed rather than dropping it on the floor.
   */
  async function resend(conv: Conversation, m: ChatMessage): Promise<void> {
    const att = m.payload.type === "file" ? m.payload.attachment : undefined;
    // Look for the bytes before deleting anything: an attachment whose blob has been evicted
    // cannot be re-sent, and losing the row as well would lose the fact that it never arrived.
    const stored = att ? await getBlob(att.fileId) : null;
    if (att && !stored) throw new Error("Attachment is no longer on this device");
    await deleteMessage(m.id);
    setMessages(x => ({ ...x, [conv.id]: (x[conv.id] ?? []).filter(y => y.id !== m.id) }));
    if (att && stored) await sendFile(conv, new File([stored.bytes], stored.name, { type: stored.mime }), { durationMs: att.durationMs });
    else if (m.payload.type === "text" && m.payload.text) await send(conv, m.payload);
  }

  async function retry(m: ChatMessage): Promise<void> {
    if (!active || m.status !== "failed") return;
    try { await resend(active, m); } catch { flash("Couldn’t retry that one"); }
  }

  /**
   * Everything that failed to send, sent again.
   *
   * The offline banner promised "messages will send when you're back" and nothing was ever going
   * to do that — a failed send sat there until someone noticed the bubble and tapped it. Since
   * the payload is already on disk, the promise is cheaper to keep than to withdraw.
   */
  async function flushFailed(): Promise<void> {
    const me = identityRef.current;
    if (flushing.current || !me || !navigator.onLine) return;
    flushing.current = true;
    try {
      let sent = 0, stuck = 0;
      for (const conv of await listConversations()) {
        const waiting = (await listMessages(conv.id)).filter(m => m.status === "failed" && m.senderDeviceId === me.deviceId);
        for (const m of waiting) {
          try { await resend(conv, m); sent++; } catch { stuck++; }
        }
      }
      if (sent) flash(sent === 1 ? "Sent the message that was waiting ✉️" : `Sent ${sent} messages that were waiting ✉️`);
      else if (stuck) flash("Some messages couldn’t be sent — tap them to try again");
    } finally { flushing.current = false; }
  }

  async function copyMessage(m: ChatMessage): Promise<void> {
    setReactFor(null);
    if (m.payload.type !== "text" || !m.payload.text) return;
    try { await navigator.clipboard.writeText(m.payload.text); flash("Copied 📋"); }
    catch { flash("Couldn’t copy that"); }
  }

  /**
   * Take a message back. Everyone folds the event in and drops the contents, so this is a real
   * retraction rather than a local hide — but only for messages we sent, since a delete naming
   * somebody else's message is refused on the way in.
   */
  async function deleteMessageForEveryone(m: ChatMessage): Promise<void> {
    const me = identityRef.current;
    setReactFor(null);
    if (!active || !me || m.senderDeviceId !== me.deviceId) return;
    if (replyTo?.id === m.id) setReplyTo(null);
    buzz(12);
    await send(active, { type: "event", event: { kind: "delete", targetId: m.id } });
  }

  function jumpTo(id: string): void {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return flash("That message isn’t loaded any more");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash-jump");
    setTimeout(() => el.classList.remove("flash-jump"), 1400);
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

  // ---------- groups, channels and links ----------

  /** A brand new group of its own, from the + menu rather than from onboarding. */
  async function startGroup(title: string, emoji: string, keep: boolean): Promise<void> {
    const me = identityRef.current; if (!me) return;
    setPanel("none"); setNewIn(null);
    try {
      const space = await createSpace(me, title, { emoji, keep });
      await putConversation(space);
      await refresh();
      setActiveId(space.id);
      confetti(); sounds.tada();
      flash(`${title} is yours — share a link to bring people in 🔗`);
    } catch { flash("Couldn’t make that — are you online?"); }
  }

  /** A channel inside a space. Nobody needs to be online for the rest of the space to get it. */
  async function startChannel(space: Conversation, title: string, emoji: string, keep: boolean): Promise<void> {
    const me = identityRef.current; if (!me) return;
    setPanel("none"); setNewIn(null);
    try {
      const channel = await createChannel(me, space, title, { emoji, keep });
      await putConversation(channel);
      await refresh();
      setOpenSpaces(x => ({ ...x, [space.id]: true }));
      setActiveId(channel.id);
      sounds.tada();
    } catch { flash("Couldn’t make that channel — are you online?"); }
  }

  async function dropChannel(channel: Conversation): Promise<void> {
    const me = identityRef.current;
    const space = conversations.find(c => c.id === channel.spaceId);
    if (!me || !space) return;
    try { await removeChannel(me, space, channel.id); } catch { /* it goes on the next sweep */ }
    await deleteConversation(channel.id);
    setActiveId(space.id); setPanel("none"); setConfirming(null);
    await refresh();
    flash("Channel removed for everyone");
  }

  /**
   * Walk through an invite link.
   *
   * This is the one entry point that may run before there is an identity at all — somebody who
   * has never opened Kin tapping a link is the case it exists for — so it makes one on the way
   * through, under whatever name they chose for *this* room rather than a global one.
   */
  async function takeInvite(preview: InvitePreview, profile: { displayName: string; avatarSeed: string }): Promise<void> {
    let me = identityRef.current;
    if (!me) {
      me = { ...(await generateIdentity(profile.displayName)), avatarSeed: profile.avatarSeed };
      await putIdentity(me);
      identityRef.current = me;
      setIdentity(me);
    }
    try {
      const conv = await acceptInvite(me, inviteLanding!.code, inviteLanding!.secret, preview, profile);
      const existing = (await listConversations()).find(c => c.id === conv.id);
      await putConversation(existing ? { ...existing, key: conv.key, role: conv.role } : conv);
      clearInviteLanding();
      await refresh();
      setActiveId(conv.id);
      confetti(); sounds.tada();
      flash(conv.role === "viewer" ? "You’re in — have a look around 👀" : `Welcome to ${conv.title}! 🎉`);
    } catch {
      flash("That link didn’t work — ask for a fresh one");
      clearInviteLanding();
    }
  }

  function clearInviteLanding(): void {
    setInviteLanding(null);
    window.history.replaceState({}, "", location.pathname);
  }

  /**
   * Pull each space's channel directory and open anything new.
   *
   * A channel created while this device was asleep has no message to announce it — the directory
   * is the announcement, and it is durable precisely so that arriving late still arrives at the
   * same set of channels as everybody else.
   */
  async function sweepChannels(): Promise<void> {
    const me = identityRef.current;
    if (!me || !navigator.onLine) return;
    const convs = await listConversations();
    const known = new Set(convs.map(c => c.id));
    let found = false;
    for (const space of convs) {
      if (space.kind !== "group" || space.spaceId) continue;
      try {
        for (const channel of await discoverChannels(me, space, known)) {
          await putConversation(channel);
          known.add(channel.id);
          found = true;
        }
      } catch { /* not reachable right now — the next sweep tries again */ }
    }
    if (found) { await refresh(); sounds.receive(); }
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

  /**
   * Take this conversation off this device.
   *
   * For a family that also means telling the relay, so the rest of them stop seeing us listed and
   * we stop receiving. A direct chat has no roster to leave — deleting it is local, and the other
   * person messaging again simply starts it over.
   */
  async function leaveConversation(conv: Conversation): Promise<void> {
    const me = identityRef.current; if (!me || busy) return;
    setBusy(true);
    try {
      if (conv.kind === "group") {
        try { await removeRoomMember(me, conv.id, me.deviceId); }
        catch { setBusy(false); return flash("Couldn’t leave — are you online?"); }
      } else {
        // Otherwise the sweep below re-derives this room within thirty seconds and pulls it back.
        await dismissDirect(conv.id);
      }
      await deleteConversation(conv.id);
      setMessages(x => { const { [conv.id]: _gone, ...rest } = x; return rest; });
      setActiveId(null); setPanel("none"); setConfirming(null);
      await refresh();
      flash(conv.kind === "group" ? `You left ${conv.title}` : "Chat deleted");
    } finally { setBusy(false); }
  }

  /** Evict somebody else's device — an old phone, or one that was replaced. */
  async function removeMember(conv: Conversation, member: PublicMember): Promise<void> {
    const me = identityRef.current; if (!me || busy) return;
    setBusy(true);
    try {
      await removeRoomMember(me, conv.id, member.deviceId);
      const current = (await listConversations()).find(c => c.id === conv.id) ?? conv;
      await putConversation({
        ...current,
        members: current.members.filter(m => m.deviceId !== member.deviceId),
        keyAlerts: current.keyAlerts?.filter(id => id !== member.deviceId)
      });
      await refresh();
      setConfirming(null);
      flash(`${firstName(member.displayName)} was removed`);
    } catch { flash("Couldn’t remove them — are you online?"); }
    finally { setBusy(false); }
  }

  async function privateChat(peer: PublicMember): Promise<void> {
    if (!identity) return;
    const d = await directWith(identity, peer);
    const existing = (await listConversations()).find(c => c.id === d.id);
    await undismissDirect(d.id);
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
  const { visible, reactions, deleted } = useMemo(() => {
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
    return { visible: sortedMsgs.filter(m => m.payload.type !== "event"), reactions, deleted: deletedIds(sortedMsgs) };
  }, [activeMessages]);
  // With one or two chats a list is mostly empty space — show a proper card for each instead.
  // Big friendly cards are for the small flat case — a family and a couple of chats. The moment a
  // space has channels there is a hierarchy to show, and a grid of equal cards is the one shape
  // that cannot show it, so the list takes over.
  const tree = useMemo(() => spaceTree(sorted), [sorted]);
  const showCards = sorted.length > 0 && sorted.length <= 3
    && !tree.orphans.length && tree.spaces.every(n => !n.channels.length);
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

  // A tombstone that leaves the text sitting in IndexedDB is not a deletion. Redacting the stored
  // copy also makes it stick: the envelope stays on the relay for its seven days, but a replay
  // skips anything already stored, so the message never comes back with its contents.
  useEffect(() => {
    if (!deleted.size || !activeId) return;
    const stale = visible.filter(m => deleted.has(m.id) && !m.deletedAt);
    if (!stale.length) return;
    void (async () => {
      const redacted = stale.map(redact);
      for (const m of redacted) await putMessage(m);
      setMessages(x => ({ ...x, [activeId]: mergeMessages(x[activeId] ?? [], redacted) }));
    })();
  }, [deleted, visible, activeId]);

  const nameFor = useCallback((deviceId: string): string => {
    if (deviceId === identity?.deviceId) return "You";
    const member = active?.members.find(m => m.deviceId === deviceId);
    return member ? firstName(member.displayName) : "Someone";
  }, [identity?.deviceId, active]);

  const quotedFor = useCallback((m: ChatMessage): QuotedMessage | undefined => {
    const id = m.payload.replyTo;
    if (!id) return undefined;
    const target = visible.find(x => x.id === id);
    if (!target) return { id, name: "", preview: "Message not loaded", gone: true };
    if (deleted.has(id)) return { id, name: nameFor(target.senderDeviceId), preview: "Message deleted", gone: true };
    return { id, name: nameFor(target.senderDeviceId), preview: previewOf(target.payload) || "Message", gone: false };
  }, [visible, deleted, nameFor]);

  const typingNames = typing.map(d => active?.members.find(m => m.deviceId === d)?.displayName).filter(Boolean).map(n => firstName(n!));
  const showIosInstall = isAppleTouchDevice() && !isStandalone();

  /** One row of the sidebar, whether it is a space, a channel under one, or a direct chat. */
  const row = (c: Conversation, rolledUpUnread?: number, nested = false) => {
    const unread = rolledUpUnread ?? c.unread ?? 0;
    const face = c.emoji ?? (c.kind === "group" ? "🏡" : null);
    return <button key={c.id} className={`conversation ${nested ? "is-channel" : ""} ${c.id === activeId ? "active" : ""}`}
      onClick={() => setActiveId(c.id)}>
      {nested ? <span className="channel-face" aria-hidden>{face}</span> : <ConversationAvatar c={c} self={identity!.deviceId}/>}
      <span>
        <strong>{c.kind === "group" && !nested && face ? `${c.title} ${face}` : c.title}</strong>
        <small>{c.lastPreview
          ? `${c.lastPreviewSender ? `${c.lastPreviewSender}: ` : ""}${c.lastPreview}`
          : c.kind === "group" ? `${c.members.length} of you` : "Just the two of you"}</small>
      </span>
      <span className="conversation-meta">
        <time>{c.lastMessageAt ? listStamp(c.lastMessageAt) : ""}</time>
        {unread > 0 && <i className="unread">{unread > 9 ? "9+" : unread}</i>}
      </span>
    </button>;
  };

  if (!ready) return <div className="splash"><Aurora/><Mark/></div>;
  // An invite link is answered before onboarding: somebody who has never opened Kin should be
  // shown what they were invited to, not asked to start a family they were not invited to start.
  if (inviteLanding) return <JoinInvite code={inviteLanding.code} onAccept={takeInvite} onCancel={clearInviteLanding}/>;
  if (!identity) return <Onboarding pairCode={joinCode} create={createFamily} join={(n, a, c) => joinFamily(n, a, c)}/>;

  return <div className={`app ${online ? "" : "is-offline"}`}>
    <Aurora/>
    {!online && <div className="offline-bar" role="status">📡 Offline — we’ll send when you’re back</div>}
    <aside className={`sidebar ${active ? "has-active" : ""}`}>
      <header>
        <h1 className="wordmark"><Mark/><strong>Kin</strong></h1>
        <button className="round" onClick={() => setPanel("settings")} aria-label="Settings"><Avatar member={publicMember(identity)} size={38}/></button>
      </header>
      <p className="greeting">{greeting()} <b>{firstName(identity.displayName)}</b></p>
      <div className={`conversation-list ${showCards ? "as-cards" : ""}`}>
        {showCards && sorted.map(c => <FamilyCard key={c.id} c={c} self={identity.deviceId} active={c.id === activeId}
          recent={recent[c.id] ?? []} onOpen={() => setActiveId(c.id)}
          onInvite={() => { setActiveId(c.id); void startPairing(); }}/>)}
        {!showCards && <>
          {tree.spaces.map(node => {
            const expanded = openSpaces[node.space.id] ?? node.channels.some(c => c.id === activeId);
            return <Fragment key={node.space.id}>
              {row(node.space, node.channels.length ? node.unread : undefined)}
              {/* The twisty only exists once there is something behind it — a plain group stays a
                  plain row, and nothing hints at a hierarchy that has not been asked for yet. */}
              {node.channels.length > 0 && <>
                <button className="channel-toggle" aria-expanded={expanded}
                  onClick={() => setOpenSpaces(x => ({ ...x, [node.space.id]: !expanded }))}>
                  {expanded ? "▾" : "▸"} {node.channels.length} {node.channels.length === 1 ? "channel" : "channels"}
                </button>
                {expanded && node.channels.map(c => row(c, undefined, true))}
              </>}
              {expanded && isFullMember(node.space) && <button className="channel-add"
                onClick={() => { setNewIn(node.space); setPanel("new"); }}>+ New channel</button>}
            </Fragment>;
          })}
          {tree.orphans.map(c => row(c))}
          {tree.directs.map(c => row(c))}
        </>}
      </div>
      <button className="new-chat" onClick={() => setPanel("add")} aria-label="Add">+</button>
    </aside>

    <main className={`chat ${active ? "open" : ""}`}>
      {active ? <>
        <header className="chat-head">
          <button className="back" onClick={() => setActiveId(null)} aria-label="Back">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5"/></svg>
          </button>
          <button className="chat-person" onClick={() => { setConfirming(null); setPanel("members"); }}>
            <ConversationAvatar c={active} self={identity.deviceId} small/>
            <span>
              <strong>{active.kind === "group" ? `${active.title} ${active.emoji ?? "🏡"}` : active.title}</strong>
              <small>{typingNames.length
                ? `${typingNames.join(" and ")} is typing…`
                : active.spaceId
                  ? `${conversations.find(c => c.id === active.spaceId)?.title ?? "Channel"} · ${active.members.length}`
                  : active.kind === "group" ? active.members.map(m => firstName(m.displayName)).join(", ") : "Private chat"}</small>
            </span>
          </button>
          {active.kind === "group" && isFullMember(active) &&
            <button className="round" onClick={() => setPanel("invite")} aria-label="Invite">💌</button>}
        </header>

        <div className="messages" ref={scroll} onClick={() => setReactFor(null)}>
          {active.kind === "group" && active.members.length === 1 && <div className="invite-card">
            <span className="invite-emoji">{active.emoji ?? "👋"}</span>
            <strong>It’s just you so far!</strong>
            <p>Send a link to whoever belongs here. It keeps working whether or not you’re online when they open it.</p>
            <button className="primary" onClick={() => setPanel("invite")}>Share a link 🔗</button>
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
                last={i === visible.length - 1}
                deleted={deleted.has(m.id)}
                quoted={quotedFor(m)}
                onReactBar={() => setReactFor(x => x === m.id ? null : m.id)}
                onReact={(emoji, at) => void react(m, emoji, at)}
                onOpenMedia={(att, url) => setLightbox({ att, url })}
                onRetry={() => void retry(m)}
                onReply={() => { setReactFor(null); setReplyTo(m); composer.current?.focus(); }}
                onCopy={() => void copyMessage(m)}
                onDelete={() => void deleteMessageForEveryone(m)}
                onJump={jumpTo}/>
            </Fragment>;
          })}
          {typingNames.length > 0 && <div className="typing"><i/><i/><i/></div>}
        </div>

        {!canPost(active)
          ? <div className="composer read-only" ref={composerBox}>
              <p>👀 You’re here to look around. {firstName(active.members.find(m => m.deviceId !== identity.deviceId)?.displayName ?? "Whoever")} shared this with you to see.</p>
            </div>
          : <div className="composer" ref={composerBox}>
          {replyTo && !rec && <div className="reply-chip">
            <span><b>Replying to {nameFor(replyTo.senderDeviceId)}</b><em>{previewOf(replyTo.payload) || "Message"}</em></span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button>
          </div>}
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
              onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(130, e.target.scrollHeight)}px`; sync.sendTyping(active.id, !!e.target.value); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendText(); } }}/>
            {draft.trim()
              ? <button className="send" onClick={() => void sendText()} aria-label="Send">↑</button>
              : <button className="composer-btn mic" onClick={() => void startRecording()} aria-label="Record voice note">🎤</button>}
          </>}
            </div>}
      </> : <div className="empty"><Mark/><span>Pick a chat to get cozy</span></div>}
    </main>

    {panel === "doodle" && active && <Doodle onClose={() => setPanel("none")} onSend={blob => {
      setPanel("none");
      void sendFile(active, new File([blob], `doodle-${Date.now()}.png`, { type: "image/png" }));
    }}/>}

    {lightbox && <Lightbox att={lightbox.att} url={lightbox.url} onClose={() => setLightbox(null)}/>}

    {shareIntake && <Sheet label="Send to" onClose={() => setShareIntake(null)}>
      <h2>Send to…</h2>
      <p className="sheet-sub">{shareIntake.files.length ? `${shareIntake.files.length} file${shareIntake.files.length > 1 ? "s" : ""} to share` : "Shared text"}</p>
      {sorted.map(c => <button key={c.id} className="member" onClick={() => void deliverShare(c)}>
        <ConversationAvatar c={c} self={identity.deviceId}/><span><strong>{c.title}</strong><small>{c.kind === "group" ? `${c.members.length} of you` : "Private chat"}</small></span>
      </button>)}
    </Sheet>}

    {panel !== "none" && panel !== "doodle" && <Sheet label={PANEL_LABELS[panel]} onClose={() => setPanel("none")}>
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
        <h2>Start something</h2>
        <button className="member" onClick={() => { setNewIn(null); setPanel("new"); }}>
          <span className="member-emoji">✨</span><span><strong>New group</strong><small>Name it, then send a link to whoever should be in it</small></span>
        </button>
        {tree.spaces.filter(n => isFullMember(n.space)).map(n => <button key={n.space.id} className="member"
          onClick={() => { setNewIn(n.space); setPanel("new"); }}>
          <span className="member-emoji">{n.space.emoji ?? "🏡"}</span>
          <span><strong>New channel in {n.space.title}</strong><small>A room of its own inside the group</small></span>
        </button>)}
        {sorted.filter(c => c.kind === "group" && isFullMember(c)).map(c => <button key={c.id} className="member"
          onClick={() => { setActiveId(c.id); setPanel("invite"); }}>
          <span className="member-emoji">🔗</span><span><strong>Invite to {c.title}</strong><small>Share a link that works whenever they open it</small></span>
        </button>)}
        <button className="member" onClick={() => setPanel("join")}><span className="member-emoji">🎟️</span><span><strong>Join with a code</strong><small>Someone read you a code in person</small></span></button>
      </>}
      {panel === "new" && identity && <NewSpace space={newIn}
        onCancel={() => { setPanel("none"); setNewIn(null); }}
        onCreate={(title, emoji, keep) => newIn ? startChannel(newIn, title, emoji, keep) : startGroup(title, emoji, keep)}/>}
      {panel === "invite" && active && identity && <InvitePanel identity={identity} conversation={active} onFlash={flash}/>}
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
      {panel === "members" && active && (active.kind === "group" ? <>
        <div className="sheet-title">
          <h2>{active.title} {active.emoji ?? "🏡"}</h2>
          {isFullMember(active) && <button onClick={() => setPanel("invite")} aria-label="Invite">💌</button>}
        </div>
        {active.keep && <p className="sheet-sub">🖼️ Everything here is kept until someone deletes it.</p>}
        {active.role === "viewer" && <p className="sheet-sub">👀 You’re here to look — you can’t post in this one.</p>}
        {active.role === "guest" && <p className="sheet-sub">💬 You’re a guest here. You can join in, but not invite others.</p>}
        {active.members.map(m => {
          const alerted = active.keyAlerts?.includes(m.deviceId);
          const me = m.deviceId === identity.deviceId;
          return <div className="member-row" key={m.deviceId}>
            <button className={`member${alerted ? " member-alert" : ""}`} disabled={me} onClick={() => void privateChat(m)}>
              <Avatar member={m}/><span>
                <strong>{alerted ? "⚠️ " : ""}{m.displayName}{me ? " · you" : ""}</strong>
                <small>{alerted ? "Security keys changed — check with them in person" : me ? "This device" : "Tap for a private chat"}</small>
              </span>
            </button>
            {!me && <button className="member-remove" aria-label={`Remove ${m.displayName}`}
              onClick={() => setConfirming(x => x === `member:${m.deviceId}` ? null : `member:${m.deviceId}`)}>✕</button>}
            {confirming === `member:${m.deviceId}` && <div className="confirm">
              <p><b>Remove {firstName(m.displayName)}?</b> They stop getting new messages here. The ones already on their phone stay there — Kin can’t reach into a device it has lost touch with.</p>
              <div className="confirm-actions">
                <button className="chip-btn" onClick={() => setConfirming(null)}>Keep them</button>
                <button className="danger-btn" disabled={busy} onClick={() => void removeMember(active, m)}>Remove</button>
              </div>
            </div>}
          </div>;
        })}
        {isFullMember(active) && <button className="setting" onClick={() => void startPairing()}>
          <span>🤝</span>
          <span className="setting-body">
            <strong>Add someone in person</strong>
            <small>Show a code to scan while you’re both here</small>
          </span>
        </button>}
        <div className="sheet-foot">
          {active.spaceId
            ? <>
                <button className="danger-row" onClick={() => setConfirming(x => x === "channel" ? null : "channel")}>
                  <span>🗑️</span>Delete this channel
                </button>
                {confirming === "channel" && <div className="confirm">
                  <p><b>Delete {active.title}?</b> It goes from everyone’s Kin, along with whatever is still in it. The rest of {conversations.find(c => c.id === active.spaceId)?.title ?? "the group"} is untouched.</p>
                  <div className="confirm-actions">
                    <button className="chip-btn" onClick={() => setConfirming(null)}>Keep it</button>
                    <button className="danger-btn" onClick={() => void dropChannel(active)}>Delete</button>
                  </div>
                </div>}
              </>
            : <>
          <button className="danger-row" onClick={() => setConfirming(x => x === "leave" ? null : "leave")}>
            <span>🚪</span>Leave this family
          </button>
          {confirming === "leave" && <div className="confirm">
            <p><b>Leave {active.title}?</b> This family and everything in it goes off this device, and the others stop seeing you here. You’d need a fresh invite to come back.</p>
            <div className="confirm-actions">
              <button className="chip-btn" onClick={() => setConfirming(null)}>Stay</button>
              <button className="danger-btn" disabled={busy} onClick={() => void leaveConversation(active)}>Leave</button>
            </div>
          </div>}
            </>}
        </div>
      </> : <>
        <h2>{active.title}</h2>
        <p className="sheet-sub">Just the two of you · end-to-end encrypted</p>
        <div className="sheet-foot">
          <button className="danger-row" onClick={() => setConfirming(x => x === "leave" ? null : "leave")}>
            <span>🗑</span>Delete this chat
          </button>
          {confirming === "leave" && <div className="confirm">
            <p><b>Delete this chat?</b> Every message and photo in it goes off this device. {firstName(active.title)} keeps their own copy, and messaging you again starts a new one.</p>
            <div className="confirm-actions">
              <button className="chip-btn" onClick={() => setConfirming(null)}>Keep it</button>
              <button className="danger-btn" disabled={busy} onClick={() => void leaveConversation(active)}>Delete</button>
            </div>
          </div>}
        </div>
      </>)}
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
    </Sheet>}
    {/* Toasts are the only channel for a failed send or a key-change warning, and a screen
        reader was never told about any of them. */}
    <div className="toast-live" role="status" aria-live="polite">{toast}</div>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

