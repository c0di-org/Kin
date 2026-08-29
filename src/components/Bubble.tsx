import { useLayoutEffect, useRef, useState } from "react";
import type { AttachmentPayload, ChatMessage, Conversation, LocalIdentity } from "../lib/types";
import type { FoldedList } from "../lib/ingest";
import { emojiOnly, personColour, time } from "../lib/format";
import { firstName } from "../lib/ingest";
import { mediaKind, saveToDevice } from "../lib/media";
import { buzz } from "../lib/sound";
import { Avatar } from "./Avatar";
import { ListCard } from "./ListCard";
import { type JoinHandler, MessageText } from "./LinkCard";
import { FileContent, ImageContent, useAttachmentUrl, VideoContent, VoiceContent } from "./Media";

const REACTIONS = ["❤️", "😂", "👍", "🎉", "😮", "😢"];

/** Renders whichever of image, video, voice note or file an attachment turns out to be. */
function MediaBody({ att, identity, c, onOpenMedia }: { att: AttachmentPayload; identity: LocalIdentity; c: Conversation; onOpenMedia(att: AttachmentPayload, url: string): void }) {
  const gone = useAttachmentUrl(identity, c, att);
  const kind = mediaKind(att);
  if (kind === "image") return <ImageContent {...gone} att={att} onOpen={() => gone.url && onOpenMedia(att, gone.url)}/>;
  if (kind === "video") return <VideoContent {...gone} att={att}/>;
  if (kind === "audio") return <VoiceContent {...gone} att={att}/>;
  return <FileContent {...gone} att={att} onOpen={() => void saveToDevice(att.fileId, att.name)}/>;
}

/** One message: its text or media, who sent it, when, its delivery state and its reactions. */
/** What a message is quoting, resolved by the caller since only it holds the whole thread. */
export type QuotedMessage = { id: string; name: string; preview: string; gone: boolean };

export function Bubble({ m, prev, me, identity, c, reactions, reacting, last, deleted, quoted, entrance, list, pinned, canEdit, nameFor, onJoinKin, onReactBar, onReact, onOpenMedia, onRetry, onReply, onCopy, onDelete, onJump, onPin, onKeep, onDoodleOn, onListToggle, onListAdd, onListRemove }: {
  m: ChatMessage; prev?: ChatMessage; me: string; identity: LocalIdentity; c: Conversation;
  reactions?: Record<string, string[]>; reacting: boolean; last: boolean; deleted: boolean;
  quoted?: QuotedMessage;
  /** This message turned up while the thread was on screen, so it is worth animating in. */
  entrance?: boolean;
  /** For a list message, the list with everybody's ticks and additions already folded in. */
  list?: FoldedList;
  pinned: boolean;
  /** False for a viewer, who may look at a list but not tick it, and may not pin. */
  canEdit: boolean;
  nameFor(deviceId: string): string;
  /** A Kin invite tapped in the thread opens here rather than in a browser tab. */
  onJoinKin: JoinHandler;
  onReactBar(): void; onReact(emoji: string, at?: { x: number; y: number }): void;
  onOpenMedia(att: AttachmentPayload, url: string): void; onRetry(): void;
  onReply(): void; onCopy(): void; onDelete(): void; onJump(id: string): void;
  onPin(): void;
  /**
   * Put a copy of this in the room you keep for yourself. Absent when there is nothing to keep,
   * when this *is* that room, or when the message has been taken back.
   */
  onKeep?(): void;
  onDoodleOn(att: AttachmentPayload): void;
  onListToggle(itemId: string, done: boolean, text: string): void;
  onListAdd(text: string): void; onListRemove(itemId: string, text: string): void;
}) {
  const mine = m.senderDeviceId === me;
  const sender = c.members.find(x => x.deviceId === m.senderDeviceId);
  const grouped = !!prev && prev.senderDeviceId === m.senderDeviceId && m.createdAt - prev.createdAt < 5 * 60_000;
  const showName = c.kind === "group" && !c.self && !mine && !grouped;
  const press = useRef<number | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  // The bar opens above the message, where for the topmost message on screen there is nothing to
  // open into — it would sit off the top of the list, or over the header.
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    if (!reacting) return;
    const el = bubble.current;
    const scroller = el?.closest(".messages");
    if (!el || !scroller) return;
    setBelow(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 66);
  }, [reacting]);
  const chips = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  const big = !deleted && m.payload.type === "text" && !!m.payload.text && emojiOnly(m.payload.text);
  const isText = m.payload.type === "text" && !!m.payload.text;
  const kept = m.payload.kept;
  // A picture can be drawn on top of; a video or a voice note cannot.
  const drawable = !deleted && m.payload.type === "file" && m.payload.attachment
    && mediaKind(m.payload.attachment) === "image" ? m.payload.attachment : null;

  // A press that lands on a link belongs to the link: every platform answers a long press there
  // with its own menu — open in a new tab, copy the *real* address — and that menu is the thing
  // that makes a shortened link safe to show. Reacting is still a press anywhere else in the
  // bubble, including the strip the timestamp sits in.
  const onLink = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest("a, .link-card, .link-inline");

  const startPress = (e: React.PointerEvent): void => {
    if (e.button === 2 || deleted || onLink(e.target)) return;
    press.current = window.setTimeout(() => { press.current = null; onReactBar(); buzz(10); }, 420);
  };
  const endPress = (): void => { if (press.current) { clearTimeout(press.current); press.current = null; } };

  return <div id={`msg-${m.id}`} className={`row ${mine ? "mine" : "theirs"} ${grouped ? "grouped" : ""}`}>
    {c.kind === "group" && !c.self && !mine && <span className="row-avatar">{!grouped && sender && <Avatar member={sender} size={30}/>}</span>}
    <div className="bubble-wrap" onClick={e => e.stopPropagation()}>
      {reacting && <div className={`react-bar ${below ? "below" : ""}`}>
        <div className="react-row">
          {REACTIONS.map(r => <button key={r} onClick={e => onReact(r, { x: e.clientX, y: e.clientY })}>{r}</button>)}
        </div>
        <div className="act-row">
          <button onClick={onReply}>↩︎ Reply</button>
          {drawable && canEdit && <button onClick={() => onDoodleOn(drawable)}>🖍️ Doodle back</button>}
          {canEdit && <button onClick={onPin}>{pinned ? "📌 Unpin" : "📌 Pin"}</button>}
          {isText && <button onClick={onCopy}>📋 Copy</button>}
          {onKeep && <button onClick={onKeep}>🔖 Keep</button>}
          {mine && <button className="act-danger" onClick={onDelete}>🗑 Delete</button>}
        </div>
      </div>}
      <div ref={bubble} className={`bubble ${entrance ? "entering" : ""} ${deleted ? "deleted" : ""} ${big ? "big-emoji" : ""} ${!deleted && m.payload.type === "file" ? "media-bubble" : ""} ${!deleted && m.payload.type === "list" ? "list-bubble" : ""} ${pinned && !deleted ? "pinned-bubble" : ""} ${m.status === "sending" ? "pending" : ""} ${m.status === "failed" ? "failed" : ""} ${reacting ? "reacting" : ""}`}
        onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
        onContextMenu={e => { if (onLink(e.target)) return; e.preventDefault(); onReactBar(); }}
        onClick={() => { if (m.status === "failed") onRetry(); }}>
        {showName && sender && <small className="sender" style={{ color: personColour(sender.deviceId).name }}>{firstName(sender.displayName)}</small>}
        {kept && !deleted && <small className="kept-from">🔖 Kept from <b>{kept.from}</b></small>}
        {quoted && !deleted && <button className="quote" onClick={e => { e.stopPropagation(); if (!quoted.gone) onJump(quoted.id); }}>
          <b>{quoted.name}</b><em>{quoted.preview}</em>
        </button>}
        {deleted
          ? <span className="text gone-text">🚫 Message deleted</span>
          : <>
            {m.payload.type === "text" && (big
              ? <span className="text">{m.payload.text}</span>
              : <MessageText text={m.payload.text ?? ""} onJoin={onJoinKin}/>)}
            {m.payload.type === "file" && m.payload.attachment && <MediaBody att={m.payload.attachment} identity={identity} c={c} onOpenMedia={onOpenMedia}/>}
            {m.payload.type === "list" && list && <ListCard list={list} canEdit={canEdit} nameFor={nameFor}
              onToggle={onListToggle} onAdd={onListAdd} onRemove={onListRemove}/>}
          </>}
        {/* A tick answers "did they get it". In the room you keep for yourself there is no they,
            so only the two states that are still about the message survive: still going out, and
            never went. A ✓✓ on a note to self is the app congratulating you for reading it. */}
        <small className="stamp">{pinned && !deleted && <b className="stamp-pin" aria-label="Pinned">📌 </b>}{time(m.createdAt)}{mine && (c.self
          ? (m.status === "failed" || m.status === "sending") && <b className={`tick ${m.status}`}>{m.status === "failed" ? " ⚠ tap to retry" : " ◌"}</b>
          : <b className={`tick ${m.status ?? ""}`}>{m.status === "failed" ? " ⚠ tap to retry" : m.status === "sending" ? " ◌" : m.status === "read" ? " ✓✓" : " ✓"}</b>)}</small>
      </div>
      {chips.length > 0 && !deleted && <div className={`chips ${mine ? "chips-mine" : ""}`}>
        {chips.map(([emoji, who]) => <button key={emoji} className={who.includes(me) ? "me" : ""} onClick={e => onReact(emoji, { x: e.clientX, y: e.clientY })}>{emoji}{who.length > 1 && <b>{who.length}</b>}</button>)}
      </div>}
      {/* On a phone the only way to react is a long press, and nothing anywhere says so. One of
          these on the newest message teaches the gesture without pinning a button to every
          bubble in the thread; on a pointer device it appears on hover as before. */}
      {!deleted && <button className={`react-hint ${last ? "always" : ""}`} aria-label={`React to this message`} onClick={onReactBar}>☺</button>}
    </div>
  </div>;
}

