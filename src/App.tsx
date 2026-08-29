import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { directConversation, encryptFile, encryptPayload, generateIdentity, publicMember, randomId, randomKey, safetyCode, signEnvelope, unwrapConversationKey, wrapConversationKey } from "./lib/crypto";
import { clearEverything, deleteConversation, deleteMessage, dismissDirect, dismissedDirects, getBlob, getIdentity, getMessage, getSetting, listConversations, listMessages, putConversation, putIdentity, putMessage, putSetting, undismissDirect } from "./lib/db";
import { currentPushStatus, isAppleTouchDevice, isStandalone, pushStatusLabel, registerPushForRooms, subscribeWebPush, type PushStatus } from "./lib/push";
import { addRoomMember, claimPair, completePair, createPair, createRoom, dropEncryptedFile, dropEnvelope, history as roomHistory, joinPair, pairStatus, relayConfig, removeRoomMember, renameRoom, roomMembers, sendEnvelope, uploadEncryptedFile } from "./lib/relay";
import type { AttachmentPayload, ChatMessage, ChatPayload, CipherEnvelope, Conversation, DeviceLinkBundle, InvitePreview, ListItem, LocalIdentity, PublicMember } from "./lib/types";
import { applySnapshot, buildSnapshot, parseDeviceLink, publishSnapshot, pullSnapshot, snapshotSignature, worthPublishing } from "./lib/devices";
import { mediaKind, previewLabel, probeImage, rememberLocalFile, resolveAttachment, saveToDevice } from "./lib/media";
import {
  acceptInvite, canPost, createChannel, createSpace, discoverChannels, isFullMember,
  parseInviteLink, removeChannel, republishChannel, spaceTree
} from "./lib/spaces";
import { deletedIds, firstName, foldLists, isSystemEvent, mergeMessages, pinnedIds, previewOf, previewOfEvent, redact } from "./lib/ingest";
import { rememberDeparted } from "./lib/roster";
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
import LinkDevice from "./components/LinkDevice";
import DevicesPanel from "./components/DevicesPanel";
import NewSpace from "./components/NewSpace";
import NewList from "./components/NewList";
import { PinnedStrip } from "./components/PinnedStrip";
import { Bubble, type QuotedMessage } from "./components/Bubble";
import { ChannelBar } from "./components/ChannelBar";
import { ChannelSheet } from "./components/ChannelSheet";
import { SpaceEditor } from "./components/SpaceEditor";
import { Gallery, type GalleryTab } from "./components/Gallery";
import { toneClass } from "./lib/tones";
import { Sheet } from "./components/Sheet";
import { SafetyCheck } from "./components/SafetyCheck";

type Panel = "none" | "pair" | "invite" | "join" | "members" | "settings" | "attach" | "add" | "doodle" | "profile" | "new" | "safety" | "list" | "edit" | "gallery" | "channels" | "devices";
type InstallPrompt = Event & { prompt(): Promise<void> };
const MAX_FILE = 25 * 1024 * 1024;
// One shared empty array, so a thread we have not read yet keeps the same identity across renders
// and the memo below it does not recompute for nothing.
const NO_MESSAGES: ChatMessage[] = [];
const REACTIONS = ["❤️", "😂", "👍", "🎉", "😮", "😢"];
const PANEL_LABELS: Record<Panel, string> = {
  none: "", doodle: "Doodle", pair: "Add someone in person", invite: "Share a link",
  join: "Join with a code", members: "Chat details", settings: "Settings",
  attach: "Send something", add: "Start something", profile: "Your look",
  new: "Make a new place", safety: "Safety check", list: "Start a list", edit: "Edit this place",
  gallery: "Photos and links", channels: "Channels", devices: "Your devices"
};


export default function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(new URLSearchParams(location.search).get("conversation"));
  /** The conversation Kin opens into, when the URL is not asking for a particular one. */
  const [homeId, setHomeId] = useState<string | null>(null);
  /**
   * Where the unread began when this thread was opened, for the line that says so.
   *
   * Captured before `markRead` moves `lastReadAt` to now — a moment later there is nothing left
   * to draw a line from, which is why this is state of its own rather than read off the row.
   */
  const [readMark, setReadMark] = useState<number | null>(null);
  const [galleryTab, setGalleryTab] = useState<GalleryTab>("photos");
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [pair, setPair] = useState<{ code: string; token: string; qr?: string; link?: string; safety?: string } | null>(null);
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get("pair") ?? "");
  const [inviteLanding, setInviteLanding] = useState(() => parseInviteLink(location.hash));
  /** A link one of this person's own devices left, waiting to be picked up by this one. */
  const [linkLanding, setLinkLanding] = useState(() => parseDeviceLink(location.hash));
  const [newIn, setNewIn] = useState<Conversation | null>(null);
  const [safety, setSafety] = useState<{ code: string; title: string } | null>(null);
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
  /**
   * Pictures pasted into the chat, waiting on the send button.
   *
   * Staged rather than sent on the spot, because a paste is not a decision — it is halfway
   * through one. A screenshot goes out with "look at this" after it, and a wrong one wants
   * taking back before anybody sees it rather than after. The object urls are ours to revoke,
   * which is why they live in state next to the file instead of being made at render time.
   */
  const [staged, setStaged] = useState<{ id: string; file: File; url: string | null }[]>([]);
  /**
   * The picture the doodle pad is currently opened on top of, if any.
   *
   * The url is an object url for a blob already on this device, resolved before the pad opens —
   * the canvas has to paint it in its first frame, and a pad that started blank and gained the
   * photo a moment later would let somebody draw underneath it.
   */
  const [doodleOn, setDoodleOn] = useState<{ url: string; replyTo: string } | null>(null);
  // Destructive actions confirm in place. A second sheet over the first would have to argue with
  // the first one over focus and inert, for a question that fits on one line.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Messages that turned up while we were looking at this thread — the only ones that should play
   * the entry animation.
   *
   * Opening a chat mounts the whole backlog at once, and an animation meant for one arriving
   * message then fires on every bubble on screen simultaneously. Kept per open thread and cleared
   * on the way in, so it never grows past a sitting.
   */
  const [entering, setEntering] = useState<Set<string>>(new Set());

  const identityRef = useRef<LocalIdentity | null>(identity);
  const activeIdRef = useRef<string | null>(activeId);
  const recCancelled = useRef(false);
  const pushStatusRef = useRef<PushStatus>(pushStatus);
  const directCache = useRef(new Map<string, { id: string; key: string }>());
  const probedAt = useRef(new Map<string, number>());
  const sweeping = useRef(false);
  // The device-sync trio: whether this session has read the other screen's picture yet, what it
  // last saw or wrote, and a guard so two sweeps do not publish over each other.
  const pulledDevices = useRef(false);
  const publishedSnapshot = useRef<string | null>(null);
  const lastKnownRooms = useRef(0);
  const syncingDevices = useRef(false);
  const publishingDevices = useRef(false);
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
  const activeMessages = messages[activeId ?? ""] ?? NO_MESSAGES;
  // Absent means "not read off disk yet"; an empty array means "read, and there is nothing in it".
  // Collapsing the two is what made a full thread claim to be empty for a moment on the way in.
  const threadLoaded = !!activeId && messages[activeId] !== undefined;

  /**
   * Open a conversation, or go back to the list.
   *
   * Kin used to start on the list, so the list was where the browser's own back button went: out
   * of the app. Starting inside a conversation makes that wrong — on Android the back gesture
   * would close Kin from the screen people spend all their time on. So the list is the entry the
   * app is launched on and a conversation is pushed on top of it, which is what makes back mean
   * "show me my chats" and only then "leave".
   *
   * Moving sideways — one channel to the next — replaces rather than pushes, or backing out of a
   * space would walk you through every channel you glanced at on the way in.
   */
  const openChat = useCallback((id: string | null): void => {
    // What the history entry says, rather than what React last rendered: push and replace take
    // effect this instant, so two switches in one tick cannot disagree about where we are.
    const shown = (history.state as { conversationId?: string } | null)?.conversationId ?? null;
    if (id === shown) return;
    if (!id) {
      if (shown) return history.back(); // popstate does the rest, and the stack stays two deep
      setActiveId(null);
      return;
    }
    const url = `${location.pathname}?conversation=${encodeURIComponent(id)}`;
    if (shown) history.replaceState({ conversationId: id }, "", url);
    else history.pushState({ conversationId: id }, "", url);
    setActiveId(id);
  }, []);

  // The back gesture, and the one the chat header draws. Both land here, and neither one of them
  // may push: `popstate` fires *after* the entry is gone, so pushing would put it straight back.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const id = (e.state as { conversationId?: string } | null)?.conversationId ?? null;
      setActiveId(id);
      setPanel("none");
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(""), 2400); };
  const noteEntering = (id: string) => setEntering(s => new Set(s).add(id));
  async function refresh() { setConversations(await listConversations()); }
  async function refreshPush() { setPushStatus(await currentPushStatus()); }

  /**
   * Which conversation the app opens into.
   *
   * Kin used to open onto a list of chats, on a phone every single time. A list is the right
   * answer for an app whose job is to be a filing cabinet, and the wrong one for the app a family
   * has one main conversation in: it put a screen with nothing on it between somebody and the
   * only room they wanted. So the answer is the place they said to open in, and failing that the
   * group they have been in longest — the family, in every case that matters, since it is the one
   * onboarding makes.
   */
  function landingConversation(cs: Conversation[], home: string | null): string | null {
    if (home && cs.some(c => c.id === home)) return home;
    const spaces = cs.filter(c => c.kind === "group" && !c.spaceId);
    const oldest = [...spaces].sort((a, b) => a.createdAt - b.createdAt)[0];
    return oldest?.id ?? [...cs].sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))[0]?.id ?? null;
  }

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      const id = await getIdentity();
      setIdentity(id);
      const cs = await listConversations();
      setConversations(cs);
      const home = await getSetting<string>("home");
      setHomeId(home);
      // A link or a notification asking for a particular conversation outranks the standing answer,
      // and anything asking for one this device does not hold is ignored rather than obeyed.
      const asked = activeIdRef.current;
      const landing = asked && cs.some(c => c.id === asked) ? asked : landingConversation(cs, home);
      // Two entries, always: the list underneath and the conversation on top. That is what gives
      // the back gesture somewhere to go other than out of the app.
      history.replaceState({ conversationId: null }, "", location.pathname);
      if (landing) {
        history.pushState({ conversationId: landing }, "", `${location.pathname}?conversation=${encodeURIComponent(landing)}`);
      }
      setActiveId(landing);
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
      if (data?.type === "kin-open" && data.conversationId) openChat(data.conversationId);
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
      openChat(activeIdRef.current ?? conversations[0].id);
      setPanel("doodle");
      dropLaunchQuery();
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
      dropLaunchQuery();
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
      onRemoved: convId => void (async () => {
        const gone = (await listConversations()).find(c => c.id === convId);
        if (gone) flash(`You’re no longer in ${gone.title}`);
        buzz(30);
      })(),
      // A channel appeared in a space we are in — pull the directory now rather than waiting out
      // the sweep, which is the difference between "instantly" and "within thirty seconds".
      onChannelAdded: () => { void sweepChannels(); },
      onChannelRemoved: (spaceId, channelId) => void (async () => {
        const gone = (await listConversations()).find(c => c.id === channelId && c.spaceId === spaceId);
        if (!gone) return;
        await forgetChannel(channelId);
        await refresh();
        flash(`${gone.title} was removed`);
      })(),
      onIncoming: (convId, { message }) => {
        const payload = message.payload;
        if (payload.type !== "event" && convId === activeIdRef.current) noteEntering(message.id);
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
    await putConversation({ ...conv, unread: 0, nudge: false, lastReadAt: Date.now() });
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

  // ---------- this person's other devices ----------
  /**
   * Kin on a laptop as well as a phone.
   *
   * A linked device is the same member on a second screen — same keys, same row on every roster —
   * so nothing about a room changes when one appears. What does have to be arranged is the list
   * of rooms itself: the relay will not enumerate what a device is in, because being able to ask
   * "which rooms is this device on" is a question about a family that ought to need the family's
   * own keys to answer. So each screen leaves the other a sealed picture of what it holds, in a
   * room with one member in it, and reads whatever the other one left.
   *
   * Additive, always: a screen that has been shut for a fortnight cannot take away the group its
   * owner joined on Tuesday by failing to mention it. Leaving is the one thing said out loud.
   */
  async function deviceContext(): Promise<{ home: string | null; gone: Record<string, number>; profileAt: number }> {
    return {
      home: await getSetting<string>("home"),
      gone: (await getSetting<Record<string, number>>("leftRooms")) ?? {},
      profileAt: (await getSetting<number>("profileAt")) ?? 0
    };
  }

  /**
   * Write down that a room was left here, so the other screen lets go of it too.
   *
   * Dated, and that is the whole of the rule: absence from a picture never means "gone", because
   * the two screens are allowed to disagree about what they have yet heard of. Only this says so.
   */
  async function noteGone(...ids: string[]): Promise<void> {
    const gone = (await getSetting<Record<string, number>>("leftRooms")) ?? {};
    const at = Date.now();
    await putSetting("leftRooms", { ...gone, ...Object.fromEntries(ids.map(id => [id, at])) });
  }

  /** Merge two devices' tombstone lists, keeping the later of any two claims about a room. */
  function mergeGone(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
    const out = { ...a };
    for (const [id, at] of Object.entries(b)) out[id] = Math.max(out[id] ?? 0, at);
    // Ninety days after a room was left, nothing anywhere still holds a copy to be told about.
    const floor = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return Object.fromEntries(Object.entries(out).filter(([, at]) => at > floor));
  }

  async function pullDevices(): Promise<boolean> {
    const me = identityRef.current;
    if (!me || !navigator.onLine) return false;
    const { reached, snapshot } = await pullSnapshot(me);
    if (!reached) return false;
    pulledDevices.current = true;
    if (!snapshot) return true;
    lastKnownRooms.current = Math.max(lastKnownRooms.current, snapshot.rooms.length);

    const local = await listConversations();
    const context = await deviceContext();
    const { add, remove, profile, home } = applySnapshot(me, local, snapshot, context);
    for (const conv of add) await putConversation(conv);
    for (const id of remove) {
      await deleteConversation(id);
      setMessages(x => { const { [id]: _gone, ...rest } = x; return rest; });
      if (activeIdRef.current === id) { openChat(null); setPanel("none"); }
    }
    if (profile) {
      const next: LocalIdentity = { ...me, displayName: profile.displayName, avatarSeed: profile.avatarSeed };
      await putIdentity(next);
      await putSetting("profileAt", profile.at);
      identityRef.current = next;
      setIdentity(next);
    }
    if (home) { await putSetting("home", home); setHomeId(home); }
    const gone = mergeGone(context.gone, snapshot.gone ?? {});
    await putSetting("leftRooms", gone);
    // What we have just read is what is on the relay, so there is nothing to write back over it —
    // unless this device holds something the picture did not, which the next comparison catches.
    publishedSnapshot.current = snapshotSignature({ ...snapshot, gone });
    if (add.length || remove.length) {
      await refresh();
      if (add.length) {
        sounds.receive();
        flash(add.length === 1 ? `${add[0].title} came over from your other device` : `${add.length} chats came over from your other device`);
      }
    }
    return true;
  }

  async function pushDevices(): Promise<void> {
    const me = identityRef.current;
    // The sweep and the debounce below both reach for this, and a room made while a sweep is
    // running would otherwise put two pictures up at once for the prune to sort out afterwards.
    if (!me || !navigator.onLine || publishingDevices.current) return;
    publishingDevices.current = true;
    try { await publishDevices(me); } finally { publishingDevices.current = false; }
  }

  async function publishDevices(me: LocalIdentity): Promise<void> {
    // Never write before reading. A screen that has only just been linked holds nothing, and
    // publishing that would take every room off every other screen until they noticed and put
    // them back — which is a bad half-minute for something nobody asked for.
    if (!pulledDevices.current && !(await pullDevices())) return;
    const snapshot = buildSnapshot(me, await listConversations(), await deviceContext());
    const signature = snapshotSignature(snapshot);
    if (signature === publishedSnapshot.current) return;
    if (!worthPublishing(snapshot, lastKnownRooms.current)) return;
    try {
      await publishSnapshot(me, snapshot);
      publishedSnapshot.current = signature;
      lastKnownRooms.current = Math.max(lastKnownRooms.current, snapshot.rooms.length);
    } catch { /* the next sweep tries again */ }
  }

  async function syncDevices(): Promise<void> {
    if (syncingDevices.current) return;
    syncingDevices.current = true;
    try { if (await pullDevices()) await pushDevices(); }
    finally { syncingDevices.current = false; }
  }

  /**
   * Become the identity another of this person's screens sealed up for us.
   *
   * Everything already here goes first, and it has to: those rooms belong to a different set of
   * keys, which are on none of their rosters and can decrypt none of their messages. Keeping them
   * would furnish the sidebar with places that no longer answer.
   */
  async function adoptIdentity(bundle: DeviceLinkBundle): Promise<void> {
    await clearEverything();
    await putIdentity(bundle.identity);
    if (bundle.home) await putSetting("home", bundle.home);
    identityRef.current = bundle.identity;
    pulledDevices.current = false;
    publishedSnapshot.current = null;
    directCache.current.clear();
    probedAt.current.clear();
    setMessages({});
    setIdentity(bundle.identity);
    setHomeId(bundle.home);
    clearLinkLanding();
    await pullDevices();
    const cs = await listConversations();
    setConversations(cs);
    openChat(landingConversation(cs, bundle.home));
    confetti(); sounds.tada();
    flash("This device is yours now 🎉");
  }

  function clearLinkLanding(): void {
    setLinkLanding(null);
    dropLaunchQuery();
  }


  useEffect(() => {
    if (!ready || !identity) return;
    const sweep = (force: boolean) => {
      if (document.visibilityState !== "visible") return;
      void discoverDirectChats(force);
      void sweepChannels();
      void syncDevices();
      void flushFailed();
    };
    sweep(true);
    const timer = setInterval(() => sweep(false), 30_000);
    const onVisible = () => sweep(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [ready, identity?.deviceId, conversationIds, online]);

  /**
   * Anything that changes which rooms this person is in, or what they are called, is news for
   * their other screen — so it goes out as soon as it settles rather than waiting for the sweep.
   *
   * Keyed on a signature of the rooms rather than on the list itself: the list is rewritten on
   * every arriving message, and a debounce that reset on each of those would never fire in a busy
   * family. Nothing is sent if the picture has not actually changed.
   */
  const roomsSignature = conversations
    .map(c => [c.id, c.title, c.emoji ?? "", c.color ?? "", c.role ?? "", c.spaceId ?? ""].join("|")).sort().join(",");
  useEffect(() => {
    if (!ready || !identity || !online) return;
    const timer = setTimeout(() => { void pushDevices(); }, 1500);
    return () => clearTimeout(timer);
  }, [ready, online, identity?.deviceId, identity?.displayName, identity?.avatarSeed, roomsSignature]);

  // ---------- open conversation ----------
  useEffect(() => {
    if (!identity || !activeId) return;
    void (async () => {
      const cached = await listMessages(activeId);
      setMessages(x => ({ ...x, [activeId]: mergeMessages(cached, x[activeId] ?? []) }));
      // Read off the row before markRead moves it, and only when there was actually something
      // waiting — a line saying "new messages" above a thread nobody has missed is noise.
      const conv = (await listConversations()).find(c => c.id === activeId);
      setReadMark(conv && (conv.unread ?? 0) > 0 ? conv.lastReadAt ?? null : null);
      await markRead(activeId);
    })();
    // Staged pictures do not follow you into another chat. A draft that ends up in the wrong
    // room is a typo; a photo that does is something else.
    setTyping([]); setReactFor(null); setReplyTo(null); setConfirming(null); setEntering(new Set()); clearStaged();
    const onVisible = () => { if (!document.hidden && activeIdRef.current === activeId) void markRead(activeId); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [identity?.deviceId, activeId]);

  // Layout, not passive: a plain effect runs after the browser has painted, so the thread was
  // painted at the top and then yanked to the bottom a few frames later. This lands the scroll in
  // the same frame the bubbles appear in.
  useLayoutEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [activeMessages.length, typing.length, activeId]);

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
    if (payload.type !== "event" && conv.id === activeIdRef.current) noteEntering(env.id);
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

  /**
   * Tell a room something about itself — that somebody arrived, or is leaving.
   *
   * Deliberately not `send`: there is no optimistic row to draw (the news is about the sender, so
   * their own copy would only ever say "you"), nothing to retry, and nothing worth a failure
   * toast in the middle of walking into or out of a room. If it does not land, the roster still
   * carries the fact — this only decides whether anybody is *told*.
   */
  async function announce(conv: Conversation, payload: ChatPayload): Promise<void> {
    const me = identityRef.current; if (!me) return;
    try {
      const env = await signEnvelope(me, await encryptPayload(conv.id, conv.key, me.deviceId, payload));
      await sendEnvelope(conv.id, env);
    } catch { /* the room finds out from the roster instead */ }
  }

  /** Put files on the shelf above the composer, previewing the ones that can be looked at. */
  function stageFiles(files: File[]): void {
    const wanted = files.filter(f => f.size <= MAX_FILE);
    if (wanted.length < files.length) flash("That’s too big — 25 MB max");
    if (!wanted.length) return;
    setStaged(x => [...x, ...wanted.map(file => ({
      id: randomId(), file,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null
    }))]);
  }

  // The revoke happens out here rather than inside the updater: a state updater is called during
  // render and may be called twice, and freeing a url is not a thing to do twice by accident.
  function unstage(id: string): void {
    const going = staged.find(s => s.id === id);
    if (going?.url) URL.revokeObjectURL(going.url);
    setStaged(x => x.filter(s => s.id !== id));
  }

  function clearStaged(): void {
    staged.forEach(s => s.url && URL.revokeObjectURL(s.url));
    setStaged([]);
  }

  /**
   * Paste a picture straight into the conversation.
   *
   * Listened for on the window rather than on the textarea: on a laptop the reflex is Cmd-V at
   * whatever is on screen, and the composer is often not the focused thing when a screenshot has
   * just been taken. Only files are taken — anything else is left to paste as text, including
   * the plain-text half that a webpage image usually arrives alongside.
   */
  useEffect(() => {
    // Not while a sheet is open, and not mid-recording: both would stage a picture onto a shelf
    // that is not on screen, and a paste you cannot see is a paste you have lost.
    if (!active || !canPost(active) || panel !== "none" || rec) return;
    const onPaste = (e: ClipboardEvent): void => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      stageFiles(files);
      composer.current?.focus();
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, [activeId, active?.role, active?.removedAt, panel, rec]);

  /**
   * Everything the composer is holding, in one go: the pictures first, then whatever was typed.
   *
   * Two messages rather than one because a file payload has nowhere to put a caption — see
   * `Bubble`, which draws the picture and nothing else. Sending the picture first is the order
   * somebody typing "look at this" means, and the order the thread reads in afterwards.
   */
  async function sendComposer(): Promise<void> {
    const text = draft.trim();
    const files = staged;
    if (!active || (!text && !files.length)) return;
    const quoting = replyTo;
    setDraft(""); setReplyTo(null); setStaged([]);
    if (composer.current) composer.current.style.height = "";
    sync.sendTyping(active.id, false);
    for (const [i, s] of files.entries()) {
      // The reply is attached to the first thing out, so a pasted answer to somebody still
      // points at what it is answering.
      await sendFile(active, s.file, quoting && i === 0 ? { replyTo: quoting.id } : undefined);
      if (s.url) URL.revokeObjectURL(s.url);
    }
    if (!text) return;
    sounds.send(); buzz(8);
    if (isCelebration(text)) { confetti(); sounds.tada(); }
    await send(active, { type: "text", text, ...(quoting && !files.length ? { replyTo: quoting.id } : {}) });
  }

  async function sendFile(conv: Conversation, file: File, extra?: { durationMs?: number; replyTo?: string }): Promise<void> {
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
    await send(conv, { type: "file", attachment, ...(extra?.replyTo ? { replyTo: extra.replyTo } : {}) }, () =>
      uploadEncryptedFile(me, conv.id, fileId, encrypted.ciphertext, encrypted.sha256));
  }

  /**
   * Send a failed message again, as a fresh envelope. Throws if it cannot be reconstructed, so
   * the caller can leave it sitting there as failed rather than dropping it on the floor.
   */
  async function resend(conv: Conversation, m: ChatMessage): Promise<void> {
    // Taken back before it ever went out: the row is a tombstone with nothing in it, and sending
    // it would put an empty bubble in front of everybody.
    if (m.deletedAt) { await deleteMessage(m.id); setMessages(x => ({ ...x, [conv.id]: (x[conv.id] ?? []).filter(y => y.id !== m.id) })); return; }
    const att = m.payload.type === "file" ? m.payload.attachment : undefined;
    // Look for the bytes before deleting anything: an attachment whose blob has been evicted
    // cannot be re-sent, and losing the row as well would lose the fact that it never arrived.
    const stored = att ? await getBlob(att.fileId) : null;
    if (att && !stored) throw new Error("Attachment is no longer on this device");
    await deleteMessage(m.id);
    setMessages(x => ({ ...x, [conv.id]: (x[conv.id] ?? []).filter(y => y.id !== m.id) }));
    if (att && stored) await sendFile(conv, new File([stored.bytes], stored.name, { type: stored.mime }), { durationMs: att.durationMs, replyTo: m.payload.replyTo });
    // Anything that is not a file goes back out as the payload it already is — a list, a tick, or
    // a line of text. Reconstructing only text quietly dropped everything else on a retry.
    else if (m.payload.type !== "file") await send(conv, m.payload);
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
   *
   * The tombstone is what other devices act on; the two relay calls are what stop the ciphertext
   * outliving it. In an ordinary room they only bring forward an expiry that was coming anyway, but
   * a kept room has no expiry at all, so without them "delete" there left the message on the relay
   * for good — and left its bytes counted against an album that could then never be emptied.
   */
  async function deleteMessageForEveryone(m: ChatMessage): Promise<void> {
    const me = identityRef.current;
    setReactFor(null);
    if (!active || !me || m.senderDeviceId !== me.deviceId) return;
    if (replyTo?.id === m.id) setReplyTo(null);
    buzz(12);
    await send(active, { type: "event", event: { kind: "delete", targetId: m.id } });
    const att = m.payload.attachment;
    // Best effort, and deliberately after the tombstone: the retraction is the part everyone sees,
    // and it should not wait on — or be lost to — a relay that is briefly unreachable.
    await Promise.allSettled([
      dropEnvelope(me, active.id, m.id),
      ...(att ? [dropEncryptedFile(me, active.id, att.fileId)] : [])
    ]);
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

  /**
   * Pin or unpin a message for everybody.
   *
   * Deliberately not restricted to the sender the way a delete is: a pin does not change what
   * anybody said, it only says which of the things already said is the one that matters this week,
   * and in a family the person who needs the wifi password pinned is rarely the one who sent it.
   */
  async function togglePin(m: ChatMessage, pinned: boolean): Promise<void> {
    if (!active) return;
    setReactFor(null);
    buzz(10);
    flash(pinned ? "Unpinned" : "Pinned 📌");
    await send(active, { type: "event", event: { kind: "pin", targetId: m.id, value: pinned ? "off" : "on" } });
  }

  /**
   * Open something from the gallery full size.
   *
   * A tile may be showing the blurred preview that rode inside the payload, and a video tile has
   * nothing at all — so the bytes are fetched here rather than assumed, and the failure is said
   * out loud instead of opening an empty lightbox.
   */
  async function openFromGallery(att: AttachmentPayload): Promise<void> {
    if (!active || !identityRef.current) return;
    const url = await resolveAttachment(identityRef.current, active, att);
    if (!url) return flash("Couldn’t open that one — it may be off the relay by now");
    setLightbox({ att, url });
  }

  /**
   * Put a file from the gallery on the device.
   *
   * The bytes may only exist on the relay, so this fetches before it saves — `saveToDevice` reads
   * the local cache and nothing else, and a Save that silently did nothing for anything older
   * than this device's history would be worse than no button.
   */
  async function saveFromGallery(att: AttachmentPayload): Promise<void> {
    if (!active || !identityRef.current) return;
    flash("Fetching it…");
    if (!(await resolveAttachment(identityRef.current, active, att))) return flash("Couldn’t fetch that one");
    try { await saveToDevice(att.fileId, att.name); flash("Saved to your device 📎"); }
    catch { flash("Couldn’t save that one"); }
  }

  /** Open the doodle pad on top of a picture from the thread, replying to it. */
  async function startDoodleOn(m: ChatMessage, att: AttachmentPayload): Promise<void> {
    if (!active || !identityRef.current) return;
    setReactFor(null);
    const url = await resolveAttachment(identityRef.current, active, att);
    if (!url) return flash("Couldn’t open that picture to draw on");
    setDoodleOn({ url, replyTo: m.id });
    setPanel("doodle");
  }

  // ---------- shared lists ----------
  async function sendList(title: string, items: ListItem[]): Promise<void> {
    if (!active) return;
    setPanel("none");
    sounds.send(); buzz(8);
    await send(active, { type: "list", list: { title, items } });
  }

  async function tickItem(listId: string, itemId: string, done: boolean, text?: string): Promise<void> {
    if (!active) return;
    buzz(6);
    if (done) sounds.react();
    // The line's text rides along so the sidebar can say "ticked off milk" without holding the
    // list it belongs to — the fold still works off the id, and an event from an older build that
    // carries no text simply says "something".
    await send(active, { type: "event", event: { kind: "check", targetId: listId, value: itemId, done, ...(text ? { item: { id: itemId, text } } : {}) } });
  }

  async function addListItem(listId: string, text: string): Promise<void> {
    if (!active) return;
    buzz(6);
    await send(active, { type: "event", event: { kind: "additem", targetId: listId, item: { id: randomId(), text: text.slice(0, 120) } } });
  }

  async function removeListItem(listId: string, itemId: string, text?: string): Promise<void> {
    if (!active) return;
    await send(active, { type: "event", event: { kind: "removeitem", targetId: listId, value: itemId, ...(text ? { item: { id: itemId, text } } : {}) } });
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
    // Stamped, because a name belongs to the person rather than to the screen they changed it on:
    // the other one adopts it, and the stamp is what stops the two of them arguing about it.
    await putSetting("profileAt", Date.now());
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
      openChat(space.id);
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
      openChat(channel.id);
      sounds.tada();
    } catch { flash("Couldn’t make that channel — are you online?"); }
  }

  /**
   * Rename, reface and recolour a group or a channel, for everybody.
   *
   * A name lives in more places than it looks. The copy on this device is what the sidebar reads;
   * an event in the room is what every other device folds in; a channel's space keeps a sealed
   * copy so that somebody joining next month arrives at the same names as everyone else; and the
   * relay keeps a plaintext one purely so a push notification can say which room it is about.
   *
   * Only the first two matter for correctness, so they go first and the rest are best-effort: a
   * rename that could not reach the relay is still a rename, and the sweep or the next edit will
   * carry the rest of it. What is never done is the reverse — telling somebody it worked when the
   * event itself did not go out.
   */
  async function savePlace(conv: Conversation, next: { title: string; emoji: string; color: string; home: boolean }): Promise<void> {
    const me = identityRef.current; if (!me) return;
    const at = Date.now();
    const color = next.color === "candy" ? undefined : next.color;
    const updated: Conversation = { ...conv, title: next.title, emoji: next.emoji, metaAt: at, ...(color ? { color } : {}) };
    if (!color) delete updated.color;
    setPanel("none");

    await putConversation(updated);
    if (next.home !== (homeId === conv.id)) {
      const home = next.home ? conv.id : null;
      await putSetting("home", home);
      setHomeId(home);
    }
    await refresh();
    await send(updated, { type: "event", event: { kind: "meta", targetId: conv.id, meta: { title: next.title, emoji: next.emoji, color: color ?? "candy" } } });

    const space = conv.spaceId ? (await listConversations()).find(c => c.id === conv.spaceId) : null;
    const carried = await Promise.allSettled([
      renameRoom(me, conv.id, next.title),
      ...(space ? [republishChannel(me, space, updated)] : [])
    ]);
    flash(carried.some(r => r.status === "rejected")
      ? "Saved — the rest of it catches up when you’re back online"
      : "Looking good! ✨");
  }

  async function dropChannel(channel: Conversation): Promise<void> {
    const me = identityRef.current;
    const space = conversations.find(c => c.id === channel.spaceId);
    if (!me || !space) return;
    // The directory is what makes this stick for everyone else, so a failure to take the channel
    // out of it has to stop here. Deleting our own copy anyway would take it off one device, put
    // it back on the next sweep, and tell the user it had gone from everybody's.
    try { await removeChannel(me, space, channel.id); }
    catch { return flash("Couldn’t remove that channel — are you online?"); }
    await noteGone(channel.id);
    await forgetChannel(channel.id);
    openChat(space.id); setPanel("none"); setConfirming(null);
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
      openChat(conv.id);
      if (!existing) void announce(conv, { type: "event", event: { kind: "joined", targetId: conv.id } });
      confetti(); sounds.tada();
      flash(conv.role === "viewer" ? "You’re in — have a look around 👀" : `Welcome to ${conv.title}! 🎉`);
    } catch {
      flash("That link didn’t work — ask for a fresh one");
      clearInviteLanding();
    }
  }

  function clearInviteLanding(): void {
    setInviteLanding(null);
    dropLaunchQuery();
  }

  /**
   * Drop whatever the app was launched with — a share, a shortcut, an invite fragment — without
   * losing where we are. Rewriting the URL to "/" also rewrote the history entry's state, so the
   * back gesture then landed on a conversation the app no longer thought it was in.
   */
  function dropLaunchQuery(): void {
    const id = activeIdRef.current;
    history.replaceState({ conversationId: id }, "", id ? `${location.pathname}?conversation=${encodeURIComponent(id)}` : location.pathname);
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
    const known = new Map(convs.map(c => [c.id, c]));
    let found = false;
    let pruned = false;
    let refaced = false;
    for (const space of convs) {
      if (space.kind !== "group" || space.spaceId) continue;
      try {
        const { joined, renamed, present } = await discoverChannels(me, space, known);
        for (const channel of joined) {
          await putConversation(channel);
          known.set(channel.id, channel);
          found = true;
        }
        // A channel this device already has, called something else since. The directory carries
        // the stamp of the edit, so this can only ever move a name forwards.
        for (const { id, meta } of renamed) {
          const mine = known.get(id);
          if (!mine) continue;
          await putConversation({ ...mine, title: meta.title, emoji: meta.emoji, metaAt: meta.at ?? Date.now(), ...(meta.color ? { color: meta.color } : {}) });
          refaced = true;
        }
        // And drop what the directory no longer lists. The removal broadcast only reaches whoever
        // was connected at the time; this is how it reaches a device that was asleep — and without
        // it, "delete this channel" deleted it for the one person who tapped the button.
        for (const c of convs) {
          if (c.spaceId !== space.id || present.has(c.id)) continue;
          await forgetChannel(c.id);
          pruned = true;
        }
      } catch { /* not reachable right now — the next sweep tries again */ }
    }
    if (found || pruned || refaced) await refresh();
    if (found) sounds.receive();
  }

  /** A channel that has gone from its space's directory, off this device too. */
  async function forgetChannel(channelId: string): Promise<void> {
    await deleteConversation(channelId);
    setMessages(x => { const { [channelId]: _gone, ...rest } = x; return rest; });
    if (activeIdRef.current === channelId) { openChat(null); setPanel("none"); }
  }

  // ---------- family lifecycle ----------
  async function createFamily(name: string, avatar: string, familyName: string, familyEmoji: string): Promise<void> {
    const id = { ...(await generateIdentity(name)), avatarSeed: `e:${avatar}` };
    const group: Conversation = { id: randomId(), kind: "group", title: familyName, emoji: familyEmoji, key: randomKey(), members: [publicMember(id)], createdAt: Date.now() };
    await putIdentity(id); await putConversation(group);
    // The first group is the one Kin opens into from now on, without anybody having to say so.
    await putSetting("home", group.id);
    setHomeId(group.id);
    try { await createRoom(id, group.id, "group", group.title, group.members); } catch { /* retried on next connect */ }
    setIdentity(id); await refresh(); openChat(group.id);
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
          await putConversation(c); await refresh(); openChat(c.id);
          void announce(c, { type: "event", event: { kind: "joined", targetId: c.id } });
          dropLaunchQuery();
          confetti(); sounds.tada();
          // Worked out here, from the card that actually arrived, rather than read off the package.
          // `pkg.safetyCode` is a string the relay carried: displaying it made the check agree with
          // whoever wrote it, so it agreed even when that was somebody sitting in the middle.
          setSafety({ code: await safetyCode(pkg.creator, publicMember(id)), title: `You’re in — welcome to ${pkg.group.title}` });
          setPanel("safety");
          return;
        } catch { await new Promise(r => setTimeout(r, 1000)); }
      }
      flash("That took too long — ask for a fresh code");
    } catch { flash("Hmm, that code didn’t work"); }
  }

  /**
   * `conv` is passed rather than read off `active`, because the family card sets the active
   * conversation and starts pairing in the same tick — and `active` is a render-time value, so it
   * was still null when this ran. On a wide screen the first chat is already selected and nobody
   * noticed; on a phone, tapping 💌 on a card did nothing at all until you tapped it twice.
   */
  async function startPairing(conv: Conversation | null = active): Promise<void> {
    if (!identity || !conv || conv.kind !== "group") return;
    setPanel("pair"); setPair(null);
    try {
      const p = await createPair(publicMember(identity), { id: conv.id, title: conv.title });
      const link = `${location.origin}${location.pathname}?pair=${encodeURIComponent(p.code)}`;
      setPair({ code: p.code, token: p.creatorToken, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 260 }) });
      for (let i = 0; i < 150; i++) {
        try {
          const status = await pairStatus(p.code, p.creatorToken);
          if (status.joiner) {
            const wrap = await wrapConversationKey(identity, status.joiner, conv.key);
            await addRoomMember(identity, conv.id, status.joiner);
            // Worked out here for this phone to show, and deliberately not sent: the joiner derives
            // their own from the card they receive, which is what makes the two agreeing mean anything.
            const code = await safetyCode(publicMember(identity), status.joiner);
            await completePair(p.code, { creator: publicMember(identity), group: { id: conv.id, title: conv.title, ...wrap } }, p.creatorToken);
            const current = (await listConversations()).find(c => c.id === conv.id) ?? conv;
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
        // Say goodbye before going, while we are still allowed to post: afterwards the relay
        // refuses our envelopes, and the room would simply find one day that we were not in it.
        if (canPost(conv)) await announce(conv, { type: "event", event: { kind: "left", targetId: conv.id } });
        try { await removeRoomMember(me, conv.id, me.deviceId); }
        catch { setBusy(false); return flash("Couldn’t leave — are you online?"); }
        // A space's channels are rooms of their own, and leaving only the space left every one of
        // them on this device: still connected, still pushing, and unreachable from a sidebar that
        // had nothing left to file them under.
        const channels = (await listConversations()).filter(c => c.spaceId === conv.id);
        for (const channel of channels) {
          try { await removeRoomMember(me, channel.id, me.deviceId); } catch { /* it goes locally regardless */ }
          await deleteConversation(channel.id);
          setMessages(x => { const { [channel.id]: _gone, ...rest } = x; return rest; });
        }
        await noteGone(conv.id, ...channels.map(c => c.id));
      } else {
        // Otherwise the sweep below re-derives this room within thirty seconds and pulls it back.
        await dismissDirect(conv.id);
        await noteGone(conv.id);
      }
      await deleteConversation(conv.id);
      setMessages(x => { const { [conv.id]: _gone, ...rest } = x; return rest; });
      openChat(null); setPanel("none"); setConfirming(null);
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
        keyAlerts: current.keyAlerts?.filter(id => id !== member.deviceId),
        // Off the roster, but not forgotten: what they sent before today still has to verify.
        ...rememberDeparted(current, current.members.filter(m => m.deviceId === member.deviceId))
      });
      await refresh();
      setConfirming(null);
      void announce(conv, { type: "event", event: { kind: "left", targetId: conv.id, value: member.deviceId } });
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
    if (existing) return openChat(existing.id); // don't clobber the history we already have
    const c: Conversation = { id: d.id, kind: "direct", title: peer.displayName, key: d.key, members: [publicMember(identity), peer], createdAt: Date.now() };
    try { await createRoom(identity, c.id, "direct", c.title, c.members); } catch { /* offline */ }
    await putConversation(c); await refresh(); openChat(c.id);
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
    setShareIntake(null); openChat(conv.id);
    for (const f of intake.files) await sendFile(conv, f);
    if (intake.text) setDraft(intake.text);
  }

  // ---------- derived ----------
  const sorted = useMemo(() => [...conversations].sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)), [conversations]);
  const { visible, news, reactions, deleted, pins, lists } = useMemo(() => {
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
    return {
      visible: sortedMsgs.filter(m => m.payload.type !== "event"), reactions,
      // Renames, arrivals and departures are events like any other, but unlike a reaction they are
      // about the room rather than about a message — so they get a line of their own instead of
      // being folded invisibly into something else.
      news: sortedMsgs.filter(m => isSystemEvent(m.payload)),
      deleted: deletedIds(sortedMsgs), pins: pinnedIds(sortedMsgs), lists: foldLists(sortedMsgs)
    };
  }, [activeMessages]);
  // A pin outlives the message only in the pin event; the thing itself can be deleted, or can have
  // scrolled out of the window we are holding, and the strip should not point at either.
  const pinnedMessages = useMemo(
    () => pins.flatMap(id => { const m = visible.find(x => x.id === id); return m && !deleted.has(id) ? [m] : []; }),
    [pins, visible, deleted]);
  // With one or two chats a list is mostly empty space — show a proper card for each instead.
  // Big friendly cards are for the small flat case — a family and a couple of chats. The moment a
  // space has channels there is a hierarchy to show, and a grid of equal cards is the one shape
  // that cannot show it, so the list takes over.
  const tree = useMemo(() => spaceTree(sorted), [sorted]);
  /**
   * The space the open conversation sits in, if it sits in one — whether it *is* the space or is
   * a channel of it. This is what the bar along the top of the chat draws, and what makes moving
   * between channels a sideways step rather than a trip out to the sidebar and back.
   */
  const openSpace = useMemo(() => {
    if (!active) return null;
    const node = tree.spaces.find(n => n.space.id === (active.spaceId ?? active.id));
    return node && node.channels.length ? node : null;
  }, [active, tree]);
  /** What every room of this space but the one you are standing in is owed, for the header. */
  const elsewhere = useMemo(() => {
    const rooms = openSpace ? [openSpace.space, ...openSpace.channels].filter(c => c.id !== activeId) : [];
    return {
      count: rooms.reduce((n, c) => n + (c.unread ?? 0), 0),
      nudge: rooms.some(c => c.nudge)
    };
  }, [openSpace, activeId]);
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
    // Somebody who has left is still the author of everything they said, and of the line saying
    // they left — looking only at the current roster called all of it "Someone".
    const member = active?.members.find(m => m.deviceId === deviceId)
      ?? active?.pastMembers?.find(m => m.deviceId === deviceId);
    return member ? firstName(member.displayName) : "Someone";
  }, [identity?.deviceId, active]);

  /** What a piece of the room's own news says, with the people in it named. */
  const newsLine = useCallback((m: ChatMessage): string => {
    const ev = m.payload.event;
    const who = nameFor(m.senderDeviceId);
    if (ev?.kind === "left" && ev.value) return `${nameFor(ev.value)} was removed by ${who.toLowerCase() === "you" ? "you" : who}`;
    return `${who} ${previewOfEvent(m.payload) ?? "changed something"}`;
  }, [nameFor]);

  /**
   * The thread as it is actually drawn: messages, the room's own news, day headings, and the line
   * marking where the unread began.
   *
   * Built in one pass rather than three overlaid maps, because they all have to agree about order
   * — a "renamed this" that floats above the message it followed is worse than not saying it.
   * A system line also breaks up a run of messages from one person, so what follows it gets its
   * name and face back instead of appearing to be part of what came before.
   */
  type Row =
    | { kind: "msg"; at: number; m: ChatMessage; prev?: ChatMessage; last: boolean }
    | { kind: "news"; at: number; m: ChatMessage }
    | { kind: "day"; at: number }
    | { kind: "mark"; at: number };
  const timeline = useMemo(() => {
    const merged = [
      ...visible.map(m => ({ m, system: false })),
      ...news.map(m => ({ m, system: true }))
    ].sort((a, b) => a.m.createdAt - b.m.createdAt || (a.system ? 1 : -1));
    const lastId = visible[visible.length - 1]?.id;
    const rows: Row[] = [];
    let prev: ChatMessage | undefined;
    let day = "";
    let marked = readMark === null;
    for (const { m, system } of merged) {
      const stamp = new Date(m.createdAt).toDateString();
      if (stamp !== day) { rows.push({ kind: "day", at: m.createdAt }); day = stamp; prev = undefined; }
      if (!marked && m.createdAt > readMark! && m.senderDeviceId !== identity?.deviceId) {
        rows.push({ kind: "mark", at: m.createdAt });
        marked = true;
      }
      if (system) { rows.push({ kind: "news", at: m.createdAt, m }); prev = undefined; }
      else { rows.push({ kind: "msg", at: m.createdAt, m, prev, last: m.id === lastId }); prev = m; }
    }
    return rows;
  }, [visible, news, readMark, identity?.deviceId]);

  const quotedFor = useCallback((m: ChatMessage): QuotedMessage | undefined => {
    const id = m.payload.replyTo;
    if (!id) return undefined;
    const target = visible.find(x => x.id === id);
    if (!target) return { id, name: "", preview: "Message not loaded", gone: true };
    if (deleted.has(id)) return { id, name: nameFor(target.senderDeviceId), preview: "Message deleted", gone: true };
    return { id, name: nameFor(target.senderDeviceId), preview: previewOf(target.payload) || "Message", gone: false };
  }, [visible, deleted, nameFor]);

  const typingNames = typing.map(d => active?.members.find(m => m.deviceId === d)?.displayName).filter(Boolean).map(n => firstName(n!));
  // Two people typing at once used to read "Ann and Bo is typing…", and five of them listed all five.
  const typingSays = typingNames.length === 1 ? `${typingNames[0]} is typing…`
    : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…`
    : `${typingNames.length} people are typing…`;
  // "Only for 7 days" stopped being true the moment a room could be kept, and settings is where
  // somebody goes to check what the relay is holding — so name the exceptions rather than
  // flatly contradicting the sheet that says an album keeps things forever.
  const kept = conversations.filter(c => c.keep);
  const keptTitles = kept.map(c => c.title).join(", ");
  const showIosInstall = isAppleTouchDevice() && !isStandalone();

  /** One row of the sidebar, whether it is a space, a channel under one, or a direct chat. */
  const row = (c: Conversation, rolledUpUnread?: number, nested = false) => {
    const unread = rolledUpUnread ?? c.unread ?? 0;
    const face = c.emoji ?? (c.kind === "group" ? "🏡" : null);
    return <button key={c.id} className={`conversation ${toneClass(c.color)} ${nested ? "is-channel" : ""} ${c.id === activeId ? "active" : ""}`}
      onClick={() => openChat(c.id)}>
      {nested ? <span className="channel-face" aria-hidden>{face}</span> : <ConversationAvatar c={c} self={identity!.deviceId}/>}
      <span>
        <strong>{c.kind === "group" && !nested && face ? `${c.title} ${face}` : c.title}</strong>
        <small>{c.lastPreview
          ? `${c.lastPreviewSender ? `${c.lastPreviewSender}: ` : ""}${c.lastPreview}`
          : c.kind === "group" ? `${c.members.length} of you` : "Just the two of you"}</small>
      </span>
      <span className="conversation-meta">
        <time>{c.lastMessageAt ? listStamp(c.lastMessageAt) : ""}</time>
        {unread > 0
          ? <i className="unread">{unread > 9 ? "9+" : unread}</i>
          /* Something happened that is not a message — a list ticked, a rename. Worth a dot, not
             a number: the number is also the badge on the app icon. */
          : c.nudge && <i className="unread quiet" aria-label="Something happened here"/>}
      </span>
    </button>;
  };

  if (!ready) return <div className="splash"><Aurora/><Mark/></div>;
  // An invite link is answered before onboarding: somebody who has never opened Kin should be
  // shown what they were invited to, not asked to start a family they were not invited to start.
  if (inviteLanding) return <JoinInvite code={inviteLanding.code} onAccept={takeInvite} onCancel={clearInviteLanding}/>;
  // And a device link before either: it is somebody's own second screen being handed the keys,
  // and asking them to make an identity first would be asking them to make the wrong one.
  if (linkLanding) return <LinkDevice code={linkLanding.code} secret={linkLanding.secret}
    replacing={!!identity} onAdopt={adoptIdentity} onCancel={clearLinkLanding}/>;
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
          recent={recent[c.id] ?? []} onOpen={() => openChat(c.id)}
          onInvite={() => { openChat(c.id); void startPairing(c); }}/>)}
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

    <main className={`chat ${toneClass(active?.color)} ${active ? "open" : ""}`}>
      {active ? <>
        <header className="chat-head">
          <button className="back" onClick={() => openChat(null)} aria-label="Back">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5"/></svg>
          </button>
          <button className="chat-person" onClick={() => { setConfirming(null); setPanel("members"); }}>
            <ConversationAvatar c={active} self={identity.deviceId} small/>
            <span>
              <strong>{active.kind === "group" ? `${active.title} ${active.emoji ?? "🏡"}` : active.title}</strong>
              <small>{typingNames.length
                ? typingSays
                : active.spaceId
                  ? `${conversations.find(c => c.id === active.spaceId)?.title ?? "Channel"} · ${active.members.length}`
                  : active.kind === "group" ? active.members.map(m => firstName(m.displayName)).join(", ") : "Private chat"}</small>
            </span>
          </button>
          {/* The way into the rest of the space, costing a button rather than a row. It carries
              what every other room is owed between them, so a glance at the header answers
              "is anything happening elsewhere" without opening anything. */}
          {openSpace && <button className="round channels" onClick={() => { setConfirming(null); setPanel("channels"); }}
            aria-label={`Channels in ${openSpace.space.title}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 20V9.2L12 4l8 5.2V20"/><path d="M10 20v-5.5h4V20"/>
            </svg>
            {elsewhere.count > 0
              ? <i className="unread">{elsewhere.count > 9 ? "9+" : elsewhere.count}</i>
              : elsewhere.nudge && <i className="unread quiet"/>}
          </button>}
          {/* No invite button up here. It was the second round button in a 70px header, next to
              the one that changes rooms, and the two read as a pair when only one of them is
              something you do every day. Inviting somebody is a once-a-year act and it lives
              where the group's other once-a-year acts live: tap the name, and it is in there. */}
        </header>

        {openSpace && <ChannelBar space={openSpace.space} channels={openSpace.channels} activeId={activeId}
          onOpen={openChat} onMore={() => { setConfirming(null); setPanel("channels"); }}/>}

        <PinnedStrip pins={pinnedMessages} nameFor={nameFor} canEdit={canPost(active)}
          onJump={jumpTo} onUnpin={m => void togglePin(m, true)}/>

        <div className="messages" ref={scroll} onClick={() => setReactFor(null)}>
          {active.kind === "group" && active.members.length === 1 && <div className="invite-card">
            <span className="invite-emoji">{active.emoji ?? "👋"}</span>
            <strong>It’s just you so far!</strong>
            <p>Send a link to whoever belongs here. It keeps working whether or not you’re online when they open it.</p>
            <button className="primary" onClick={() => setPanel("invite")}>Share a link 🔗</button>
          </div>}
          {threadLoaded && visible.length === 0 && active.members.length > 1 && <div className="hello-card">👋<p>Say hi!</p></div>}
          {timeline.map((row, i) => {
            if (row.kind === "day") return <div className="day" key={`day-${row.at}-${i}`}><span>{dayLabel(row.at)}</span></div>;
            if (row.kind === "mark") return <div className="day unread-mark" key={`mark-${row.at}`}><span>New messages</span></div>;
            if (row.kind === "news") return <div className="news" key={row.m.id}><span>{newsLine(row.m)}</span></div>;
            const m = row.m;
            return <Bubble key={m.id} m={m} prev={row.prev} me={identity.deviceId} identity={identity} c={active}
              reactions={reactions.get(m.id)}
              reacting={reactFor === m.id}
              last={row.last}
              entrance={entering.has(m.id)}
              deleted={deleted.has(m.id)}
              quoted={quotedFor(m)}
              list={lists.get(m.id)}
              pinned={pins.includes(m.id)}
              canEdit={canPost(active)}
              nameFor={nameFor}
              onReactBar={() => setReactFor(x => x === m.id ? null : m.id)}
              onReact={(emoji, at) => void react(m, emoji, at)}
              onOpenMedia={(att, url) => setLightbox({ att, url })}
              onRetry={() => void retry(m)}
              onReply={() => { setReactFor(null); setReplyTo(m); composer.current?.focus(); }}
              onCopy={() => void copyMessage(m)}
              onDelete={() => void deleteMessageForEveryone(m)}
              onJump={jumpTo}
              onPin={() => void togglePin(m, pins.includes(m.id))}
              onDoodleOn={att => void startDoodleOn(m, att)}
              onListToggle={(itemId, done, text) => void tickItem(m.id, itemId, done, text)}
              onListAdd={text => void addListItem(m.id, text)}
              onListRemove={(itemId, text) => void removeListItem(m.id, itemId, text)}/>;
          })}
          {typingNames.length > 0 && <div className="typing"><i/><i/><i/></div>}
        </div>

        {!canPost(active)
          ? <div className="composer read-only" ref={composerBox}>
              {active.removedAt
                ? <p>🚪 You’re no longer in {active.title}. Everything here stays on this device — you’d need a fresh invite to join in again.</p>
                : <p>👀 You’re here to look around. {firstName(active.members.find(m => m.deviceId !== identity.deviceId)?.displayName ?? "Whoever")} shared this with you to see.</p>}
            </div>
          : <div className="composer" ref={composerBox}>
          {replyTo && !rec && <div className="reply-chip">
            <span><b>Replying to {nameFor(replyTo.senderDeviceId)}</b><em>{previewOf(replyTo.payload) || "Message"}</em></span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button>
          </div>}
          {staged.length > 0 && !rec && <div className="staged">
            {staged.map(s => <span key={s.id} className="staged-item">
              {s.url
                ? <img src={s.url} alt={s.file.name}/>
                : <b className="staged-file">{s.file.type.startsWith("video/") ? "🎬" : "📄"}<em>{s.file.name}</em></b>}
              <button onClick={() => unstage(s.id)} aria-label={`Don’t send ${s.file.name}`}>✕</button>
            </span>)}
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
            <button className="composer-btn" onClick={() => { setDoodleOn(null); setPanel("doodle"); }} aria-label="Doodle">🖍️</button>
            <textarea ref={composer} rows={1} placeholder={`Message ${active.kind === "direct" ? firstName(active.title) : "everyone"}…`} value={draft}
              onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(130, e.target.scrollHeight)}px`; sync.sendTyping(active.id, !!e.target.value); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendComposer(); } }}/>
            {draft.trim() || staged.length
              ? <button className="send" onClick={() => void sendComposer()} aria-label="Send">↑</button>
              : <button className="composer-btn mic" onClick={() => void startRecording()} aria-label="Record voice note">🎤</button>}
          </>}
            </div>}
      </> : <div className="empty"><Mark/><span>Pick a chat to get cozy</span></div>}
    </main>

    {panel === "doodle" && active && <Doodle backdrop={doodleOn?.url}
      onClose={() => { setPanel("none"); setDoodleOn(null); }}
      onSend={blob => {
        const on = doodleOn;
        setPanel("none"); setDoodleOn(null);
        void sendFile(active, new File([blob], `doodle-${Date.now()}.png`, { type: "image/png" }), on ? { replyTo: on.replyTo } : undefined);
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
          <button onClick={() => { setDoodleOn(null); setPanel("doodle"); }}><span>🖍️</span>Doodle</button>
          <button onClick={() => setPanel("list")}><span>✅</span>List</button>
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
          onClick={() => { openChat(c.id); setPanel("invite"); }}>
          <span className="member-emoji">🔗</span><span><strong>Invite to {c.title}</strong><small>Share a link that works whenever they open it</small></span>
        </button>)}
        <button className="member" onClick={() => setPanel("join")}><span className="member-emoji">🎟️</span><span><strong>Join with a code</strong><small>Someone read you a code in person</small></span></button>
      </>}
      {panel === "new" && identity && <NewSpace space={newIn}
        onCancel={() => { setPanel("none"); setNewIn(null); }}
        onCreate={(title, emoji, keep) => newIn ? startChannel(newIn, title, emoji, keep) : startGroup(title, emoji, keep)}/>}
      {panel === "channels" && openSpace && <ChannelSheet space={openSpace.space} channels={openSpace.channels}
        activeId={activeId}
        onOpen={id => { setPanel("none"); openChat(id); }}
        onNew={isFullMember(openSpace.space) ? () => { setNewIn(openSpace.space); setPanel("new"); } : undefined}/>}
      {panel === "gallery" && active && <Gallery identity={identity} conversation={active} deleted={deleted}
        tab={galleryTab} onTab={setGalleryTab} nameFor={nameFor}
        onBack={() => setPanel("members")}
        onJump={id => { setPanel("none"); setTimeout(() => jumpTo(id), 60); }}
        onOpen={shot => void openFromGallery(shot.att)}
        onSave={att => void saveFromGallery(att)}/>}
      {panel === "edit" && active && <SpaceEditor conversation={active} isChannel={!!active.spaceId}
        isHome={homeId === active.id}
        onCancel={() => setPanel("members")}
        onSave={next => savePlace(active, next)}/>}
      {panel === "list" && active && <NewList onCancel={() => setPanel("none")} onSend={(t, items) => void sendList(t, items)}/>}
      {panel === "invite" && active && identity && <InvitePanel identity={identity} conversation={active} onFlash={flash}/>}
      {panel === "pair" && <>
        <h2>Add a family member</h2>
        {!pair && <div className="hello-card">⏳<p>Getting your code…</p></div>}
        {pair && (pair.safety
          ? <SafetyCheck code={pair.safety} title="They’re in!"/>
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
          {isFullMember(active) && <button onClick={() => setPanel("edit")} aria-label="Edit this group">✏️</button>}
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
            {!me && isFullMember(active) && <button className="member-remove" aria-label={`Remove ${m.displayName}`}
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
        <button className="setting" onClick={() => { setGalleryTab("photos"); setPanel("gallery"); }}>
          <span>📷</span>
          <span className="setting-body">
            <strong>Photos &amp; links</strong>
            <small>Everything sent here, without scrolling back through it</small>
          </span>
        </button>
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
        <button className="setting" onClick={() => { setGalleryTab("photos"); setPanel("gallery"); }}>
          <span>📷</span>
          <span className="setting-body">
            <strong>Photos &amp; links</strong>
            <small>Everything sent here, without scrolling back through it</small>
          </span>
        </button>
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
      {panel === "safety" && safety && <>
        <SafetyCheck code={safety.code} title={safety.title}/>
        <button className="primary" onClick={() => { setSafety(null); setPanel("none"); }}>They match 👍</button>
      </>}
      {panel === "devices" && <DevicesPanel identity={identity} home={homeId} onFlash={flash}
        onDone={() => setPanel("settings")}/>}
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
        <button className="setting" onClick={() => setPanel("devices")}>
          <span>💻</span>
          <span className="setting-body">
            <strong>Your devices</strong>
            <small>Use Kin on your laptop as well as your phone</small>
          </span>
        </button>
        <button className="setting" onClick={() => setPanel("join")}><span>🔗</span>Join with a code</button>
        <small className="privacy">
          🔒 End-to-end encrypted · the relay only holds scrambled messages, and only for 7 days
          {kept.length > 0 && ` — except ${keptTitles}, which ${kept.length === 1 ? "keeps" : "keep"} everything until you delete it`}
          {" "}· photos &amp; doodles live safely on your devices
        </small>
      </>}
    </Sheet>}
    {/* Toasts are the only channel for a failed send or a key-change warning, and a screen
        reader was never told about any of them. */}
    <div className="toast-live" role="status" aria-live="polite">{toast}</div>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

