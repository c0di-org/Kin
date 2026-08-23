import { useLayoutEffect, useRef, useState } from "react";
import type { AttachmentPayload, ChatMessage, Conversation, LocalIdentity } from "../lib/types";
import { emojiOnly, personColour, time } from "../lib/format";
import { firstName } from "../lib/ingest";
import { mediaKind, saveToDevice } from "../lib/media";
import { buzz } from "../lib/sound";
import { Avatar } from "./Avatar";
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

export function Bubble({ m, prev, me, identity, c, reactions, reacting, last, deleted, quoted, entrance, onReactBar, onReact, onOpenMedia, onRetry, onReply, onCopy, onDelete, onJump }: {
  m: ChatMessage; prev?: ChatMessage; me: string; identity: LocalIdentity; c: Conversation;
  reactions?: Record<string, string[]>; reacting: boolean; last: boolean; deleted: boolean;
  quoted?: QuotedMessage;
  /** This message turned up while the thread was on screen, so it is worth animating in. */
  entrance?: boolean;
  onReactBar(): void; onReact(emoji: string, at?: { x: number; y: number }): void;
  onOpenMedia(att: AttachmentPayload, url: string): void; onRetry(): void;
  onReply(): void; onCopy(): void; onDelete(): void; onJump(id: string): void;
}) {
  const mine = m.senderDeviceId === me;
  const sender = c.members.find(x => x.deviceId === m.senderDeviceId);
  const grouped = !!prev && prev.senderDeviceId === m.senderDeviceId && m.createdAt - prev.createdAt < 5 * 60_000;
  const showName = c.kind === "group" && !mine && !grouped;
  const press = useRef<number | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  // The bar opens above the message, where for the topmost message on screen there is nothing to
  // open into — it would sit off the top of the list, or over the header.
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    if (!reacting) return;
    const el = bubble.current;
    const list = el?.closest(".messages");
    if (!el || !list) return;
    setBelow(el.getBoundingClientRect().top - list.getBoundingClientRect().top < 66);
  }, [reacting]);
  const chips = Object.entries(reactions ?? {}).filter(([, who]) => who.length > 0);
  const big = !deleted && m.payload.type === "text" && !!m.payload.text && emojiOnly(m.payload.text);
  const isText = m.payload.type === "text" && !!m.payload.text;

  const startPress = (e: React.PointerEvent): void => {
    if (e.button === 2 || deleted) return;
    press.current = window.setTimeout(() => { press.current = null; onReactBar(); buzz(10); }, 420);
  };
  const endPress = (): void => { if (press.current) { clearTimeout(press.current); press.current = null; } };

  return <div id={`msg-${m.id}`} className={`row ${mine ? "mine" : "theirs"} ${grouped ? "grouped" : ""}`}>
    {c.kind === "group" && !mine && <span className="row-avatar">{!grouped && sender && <Avatar member={sender} size={30}/>}</span>}
    <div className="bubble-wrap" onClick={e => e.stopPropagation()}>
      {reacting && <div className={`react-bar ${below ? "below" : ""}`}>
        <div className="react-row">
          {REACTIONS.map(r => <button key={r} onClick={e => onReact(r, { x: e.clientX, y: e.clientY })}>{r}</button>)}
        </div>
        <div className="act-row">
          <button onClick={onReply}>↩︎ Reply</button>
          {isText && <button onClick={onCopy}>📋 Copy</button>}
          {mine && <button className="act-danger" onClick={onDelete}>🗑 Delete</button>}
        </div>
      </div>}
      <div ref={bubble} className={`bubble ${entrance ? "entering" : ""} ${deleted ? "deleted" : ""} ${big ? "big-emoji" : ""} ${!deleted && m.payload.type === "file" ? "media-bubble" : ""} ${m.status === "sending" ? "pending" : ""} ${m.status === "failed" ? "failed" : ""} ${reacting ? "reacting" : ""}`}
        onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
        onContextMenu={e => { e.preventDefault(); onReactBar(); }}
        onClick={() => { if (m.status === "failed") onRetry(); }}>
        {showName && sender && <small className="sender" style={{ color: personColour(sender.deviceId).name }}>{firstName(sender.displayName)}</small>}
        {quoted && !deleted && <button className="quote" onClick={e => { e.stopPropagation(); if (!quoted.gone) onJump(quoted.id); }}>
          <b>{quoted.name}</b><em>{quoted.preview}</em>
        </button>}
        {deleted
          ? <span className="text gone-text">🚫 Message deleted</span>
          : <>
            {m.payload.type === "text" && <span className="text">{m.payload.text}</span>}
            {m.payload.type === "file" && m.payload.attachment && <MediaBody att={m.payload.attachment} identity={identity} c={c} onOpenMedia={onOpenMedia}/>}
          </>}
        <small className="stamp">{time(m.createdAt)}{mine && <b className={`tick ${m.status ?? ""}`}>{m.status === "failed" ? " ⚠ tap to retry" : m.status === "sending" ? " ◌" : m.status === "read" ? " ✓✓" : " ✓"}</b>}</small>
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

