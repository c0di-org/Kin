import { useRef } from "react";
import type { AttachmentPayload, ChatMessage, Conversation, LocalIdentity } from "../lib/types";
import { emojiOnly, hue, time } from "../lib/format";
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
export function Bubble({ m, prev, me, identity, c, reactions, reacting, onReactBar, onReact, onOpenMedia, onRetry }: {
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

