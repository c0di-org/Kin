import type { ChatMessage, Conversation } from "../lib/types";
import { firstName, previewOf } from "../lib/ingest";
import { time } from "../lib/format";
import { Avatar } from "./Avatar";

/** The family's faces arranged in a ring around a house or envelope badge. */
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

/** One family in the conversation list: who is in it, what was said last, how much is unread. */
export function FamilyCard({ c, self, active, recent, onOpen, onInvite }: {
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
        <em>{previewOf(m.payload)}</em>
        <time>{time(m.createdAt)}</time>
      </span>)}
    </button>}
    {alone
      ? <button className="family-invite" onClick={onInvite}>💌 Invite your family</button>
      : recent.length === 0 && <span className="family-empty">Nothing yet — say hi 👋</span>}
  </div>;
}

