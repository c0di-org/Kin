import { useEffect, useRef } from "react";
import type { ChatMessage, CipherEnvelope, Conversation, LocalIdentity, PublicMember } from "../lib/types";
import { getMessage, knownMessageIds, listConversations, markOwnMessagesRead, putConversation, putMessage, putMessages } from "../lib/db";
import { history as roomHistory, roomMembers, websocketUrl } from "../lib/relay";
import { applyRoster, rememberDeparted } from "../lib/roster";
import { mergeMessages, openEnvelope, openEnvelopes, reconnectDelay, summarize, type OpenedMessage } from "../lib/ingest";

/**
 * Everything the transport hands back to the UI.
 *
 * The sync layer deliberately makes no noise of its own: sounds, haptics, confetti and read
 * receipts are the app's business, not the socket's. Keeping them here as callbacks is what lets
 * the message handling be tested without a speaker attached.
 */
export type SyncEvents = {
  /** Verified, decrypted messages to fold into the open conversation. */
  onMessages(conversationId: string, messages: ChatMessage[]): void;
  /** A conversation row changed on disk — preview, unread count or roster. */
  onConversationsChanged(): void;
  /** A live message arrived from someone else. The moment to react, not just render. */
  onIncoming(conversationId: string, opened: OpenedMessage): void;
  onTyping(conversationId: string, senderDeviceId: string, active: boolean): void;
  /** Someone's device keys changed under us and we refused the change. */
  onKeyChange(member: PublicMember): void;
  /**
   * A channel appeared in or vanished from a space we are in.
   *
   * The relay broadcasts both, and until now nothing listened to either: a new channel waited on
   * the thirty-second sweep to be noticed, and a deleted one was never noticed at all — so
   * "removed for everyone" removed it for exactly one person.
   */
  onChannelAdded(spaceId: string): void;
  onChannelRemoved(spaceId: string, channelId: string): void;
};

export type ConversationSync = {
  sendRead(conversationId: string, messageId: string): void;
  sendTyping(conversationId: string, active: boolean): void;
  isOpen(conversationId: string): boolean;
};

type Options = {
  identity: LocalIdentity | null;
  conversations: Conversation[];
  activeId: string | null;
  online: boolean;
  events: SyncEvents;
};

export function useConversationSync({ identity, conversations, activeId, online, events }: Options): ConversationSync {
  const sockets = useRef(new Map<string, WebSocket>());
  const wanted = useRef(new Set<string>());
  const connecting = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Sockets and timers outlive the render that created them, so what they read has to be a ref.
  const identityRef = useRef(identity);
  const activeIdRef = useRef(activeId);
  const eventsRef = useRef(events);
  useEffect(() => { identityRef.current = identity; }, [identity]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { eventsRef.current = events; });

  function scheduleReconnect(conversationId: string): void {
    if (!wanted.current.has(conversationId)) return;
    const attempt = retries.current.get(conversationId) ?? 0;
    retries.current.set(conversationId, attempt + 1);
    clearTimeout(retryTimers.current.get(conversationId));
    retryTimers.current.set(conversationId, setTimeout(() => {
      retryTimers.current.delete(conversationId);
      void connect(conversationId);
    }, reconnectDelay(attempt)));
  }

  async function connect(conversationId: string): Promise<void> {
    const me = identityRef.current;
    if (!me || !wanted.current.has(conversationId)) return;
    if (connecting.current.has(conversationId) || sockets.current.has(conversationId)) return;
    connecting.current.add(conversationId);
    try {
      // Roster first, then history. An envelope is only opened if it verifies against a member we
      // already hold, and history is fetched once — so ingesting first silently drops every
      // message from anyone this device has not met yet, permanently. A device that has been in
      // the room for years never notices; one that just walked in on an invite link knows only
      // whoever invited it, and would find the room empty of everybody else.
      await pullRoster(me, conversationId);
      try { await ingestHistory(conversationId, await roomHistory(me, conversationId)); } catch { /* offline */ }

      const socket = new WebSocket(await websocketUrl(me, conversationId));
      socket.onopen = () => { retries.current.delete(conversationId); };
      socket.onmessage = ev => { void handleFrame(conversationId, String(ev.data)); };
      socket.onclose = () => {
        sockets.current.delete(conversationId);
        scheduleReconnect(conversationId);
      };
      sockets.current.set(conversationId, socket);
      if (!wanted.current.has(conversationId)) socket.close();
    } catch {
      scheduleReconnect(conversationId);
    } finally { connecting.current.delete(conversationId); }
  }

  /** Group rosters can gain members while we were away; direct chats are fixed at two. */
  async function pullRoster(me: LocalIdentity, conversationId: string): Promise<void> {
    const conv = (await listConversations()).find(c => c.id === conversationId);
    if (conv?.kind !== "group") return;
    try {
      const roster = await roomMembers(me, conversationId);
      const { conversation, refused } = applyRoster(conv, roster, { authoritative: true });
      refused.forEach(m => eventsRef.current.onKeyChange(m));
      await putConversation(conversation);
      eventsRef.current.onConversationsChanged();
    } catch { /* offline */ }
  }

  async function handleFrame(conversationId: string, raw: string): Promise<void> {
    const me = identityRef.current;
    if (!me) return;
    let frame: { kind?: string; member?: PublicMember; senderDeviceId?: string; active?: boolean; messageId?: string; deviceId?: string; channelId?: string };
    try { frame = JSON.parse(raw); } catch { return; }

    if (frame.kind === "message") return void await ingestOne(conversationId, frame as unknown as CipherEnvelope);
    if (frame.kind === "member" && frame.member) return void await applyMember(me, conversationId, frame.member);
    if (frame.kind === "member-removed" && frame.deviceId) return void await applyRemoval(me, conversationId, frame.deviceId);
    if (frame.kind === "channel") return void eventsRef.current.onChannelAdded(conversationId);
    if (frame.kind === "channel-removed" && frame.channelId) {
      return void eventsRef.current.onChannelRemoved(conversationId, frame.channelId);
    }
    if (frame.kind === "typing" && frame.senderDeviceId && frame.senderDeviceId !== me.deviceId) {
      eventsRef.current.onTyping(conversationId, frame.senderDeviceId, !!frame.active);
    }
    if (frame.kind === "read" && frame.senderDeviceId && frame.messageId) {
      await applyRead(me, conversationId, frame.messageId);
    }
  }

  async function applyMember(me: LocalIdentity, conversationId: string, member: PublicMember): Promise<void> {
    const conv = (await listConversations()).find(c => c.id === conversationId);
    if (!conv) return;
    const { conversation, refused } = applyRoster(conv, [member]);
    if (refused.length) eventsRef.current.onKeyChange(refused[0]);
    // A direct chat is titled after the other person, so a rename has to move the title too —
    // but not on the strength of an update we just refused.
    const peerRenamed = conv.kind === "direct" && member.deviceId !== me.deviceId && !refused.length;
    await putConversation({ ...conversation, ...(peerRenamed ? { title: member.displayName } : {}) });
    eventsRef.current.onConversationsChanged();
  }

  /**
   * Somebody was removed from the room — an old phone, or the person leaving themselves.
   *
   * Being removed ourselves is not handled here on purpose. The relay stops answering for us the
   * moment it happens, so the socket closes and reconnects fail; deleting our own copy of the
   * conversation off the back of a frame would mean any relay that felt like it could erase a
   * family's history from a device. What we hold locally stays ours.
   */
  async function applyRemoval(me: LocalIdentity, conversationId: string, deviceId: string): Promise<void> {
    if (deviceId === me.deviceId) return;
    const conv = (await listConversations()).find(c => c.id === conversationId);
    if (!conv || conv.kind !== "group") return;
    const gone = conv.members.filter(m => m.deviceId === deviceId);
    await putConversation({
      ...conv,
      members: conv.members.filter(m => m.deviceId !== deviceId),
      keyAlerts: conv.keyAlerts?.filter(id => id !== deviceId),
      // Their card stays, unlisted. Nobody signs this frame, so acting on it by forgetting a key
      // would let the relay make everything that person ever said fail verification and disappear.
      ...rememberDeparted(conv, gone)
    });
    eventsRef.current.onConversationsChanged();
  }

  /**
   * Replay a history pull in one pass: the roster is read once, the messages land in a single
   * transaction, and React hears about it once. Feeding history through the single-message path
   * instead costs thousands of database round-trips before the app is usable.
   */
  async function ingestHistory(conversationId: string, envelopes: CipherEnvelope[]): Promise<void> {
    const me = identityRef.current;
    if (!me || !envelopes.length) return;
    const conv = (await listConversations()).find(c => c.id === conversationId);
    if (!conv) return;

    const opened = await openEnvelopes(conv, envelopes, await knownMessageIds(envelopes.map(e => e.id)));
    if (!opened.length) return;
    await putMessages(opened.map(o => o.message));
    eventsRef.current.onMessages(conversationId, opened.map(o => o.message));

    const summary = summarize(conv, opened, {
      myDeviceId: me.deviceId,
      activeAndVisible: conversationId === activeIdRef.current && !document.hidden
    });
    if (!summary) return;
    await putConversation(summary);
    eventsRef.current.onConversationsChanged();
  }

  async function ingestOne(conversationId: string, env: CipherEnvelope): Promise<void> {
    const me = identityRef.current;
    if (!me || await getMessage(env.id)) return;
    const conv = (await listConversations()).find(c => c.id === conversationId);
    if (!conv) return;
    const opened = await openEnvelope(conv, env);
    if (!opened) return;

    await putMessage(opened.message);
    eventsRef.current.onMessages(conversationId, [opened.message]);

    const summary = summarize(conv, [opened], {
      myDeviceId: me.deviceId,
      activeAndVisible: conversationId === activeIdRef.current && !document.hidden
    });
    if (summary) {
      await putConversation(summary);
      eventsRef.current.onConversationsChanged();
    }
    if (opened.message.senderDeviceId !== me.deviceId) eventsRef.current.onIncoming(conversationId, opened);
  }

  async function applyRead(me: LocalIdentity, conversationId: string, messageId: string): Promise<void> {
    const target = await getMessage(messageId);
    if (!target) return;
    const updated = await markOwnMessagesRead(conversationId, me.deviceId, target.createdAt);
    if (updated.length) eventsRef.current.onMessages(conversationId, updated);
  }

  // One socket per conversation, torn down when the conversation or the identity goes away.
  const conversationIds = conversations.map(c => c.id).sort().join(",");
  useEffect(() => {
    if (!identity) return;
    wanted.current = new Set(conversations.map(c => c.id));
    // A conversation that has left the list — left, deleted, a channel someone removed — had its
    // socket abandoned rather than closed, so it stayed open and kept delivering a room this
    // device is no longer in.
    for (const [id, socket] of sockets.current) {
      if (wanted.current.has(id)) continue;
      sockets.current.delete(id);
      retries.current.delete(id);
      clearTimeout(retryTimers.current.get(id));
      retryTimers.current.delete(id);
      socket.close();
    }
    for (const id of wanted.current) if (!sockets.current.has(id)) void connect(id);
  }, [identity?.deviceId, conversationIds, online]);

  useEffect(() => () => {
    wanted.current.clear();
    retryTimers.current.forEach(clearTimeout);
    retryTimers.current.clear();
    sockets.current.forEach(s => s.close());
    sockets.current.clear();
  }, []);

  function send(conversationId: string, frame: unknown): void {
    const socket = sockets.current.get(conversationId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  return {
    sendRead: (conversationId, messageId) => send(conversationId, { kind: "read", messageId }),
    sendTyping: (conversationId, active) => send(conversationId, { kind: "typing", active }),
    isOpen: conversationId => sockets.current.get(conversationId)?.readyState === WebSocket.OPEN
  };
}
