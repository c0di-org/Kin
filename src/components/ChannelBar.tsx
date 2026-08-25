import { useState } from "react";
import { callingRooms } from "../lib/spaces";
import type { Conversation } from "../lib/types";

/**
 * The other rooms of this space, but only the ones asking for you.
 *
 * The first version of this drew every channel as a pill, always, in a row under the header. That
 * is a fair map of the space and a bad use of a phone: on a family group with five channels it
 * spent a permanent ~46px — most of a message — telling you about four rooms where nothing had
 * happened, and it spent it hardest on the small screens that can least afford it.
 *
 * So the row is no longer a map. It is an interruption, and it earns its height each time:
 * nothing at all while the rest of the space is quiet, and when a room does have something, a
 * chip big enough to read and hit that says *who* said *what*, so the usual case — glancing at
 * it, deciding it can wait — costs no tap at all. The full map moved to the channel sheet behind
 * the header button, which is where you go when you *mean* to change rooms rather than being
 * called into one.
 *
 * Only the room that spoke most recently gets a chip, however many are waiting. A row of three
 * would be back to fitting names into pills nobody can read, and a scrolling row is worse still,
 * because what is off the right edge does not exist to somebody glancing at their phone. The rest
 * are a count that opens the map — the honest shape of "there is more here than fits".
 *
 * The hush button matters more than it looks. A family always has one room somebody has decided
 * not to keep up with, and without a way to put it down, an unread count nobody intends to clear
 * would pin this row open forever and we would be back to the permanent bar with extra steps.
 * Hushing remembers exactly what was showing, so anything genuinely new brings it straight back.
 */
export function ChannelBar({ space, channels, activeId, onOpen, onMore }: {
  space: Conversation;
  channels: Conversation[];
  activeId: string | null;
  onOpen(id: string): void;
  /** Show the whole space — where the rooms that did not fit on this row are. */
  onMore(): void;
}) {
  const [hushed, setHushed] = useState("");
  const { rooms, signature } = callingRooms(space, channels, activeId);

  // Returning null rather than being unmounted by the caller, so `hushed` survives the quiet
  // spells between interruptions. Unmounting on empty would forget the hush the moment it took
  // effect, and the row would come straight back.
  if (!rooms.length || signature === hushed) return null;

  const c = rooms[0];
  const count = c.unread ?? 0;
  const others = rooms.length - 1;

  return <nav className="channel-bar" aria-label={`Other channels in ${space.title}`}>
    <button className="channel-pill" onClick={() => onOpen(c.id)}>
      <span className="pill-face" aria-hidden>{c.emoji ?? (c.id === space.id ? "🏡" : "💬")}</span>
      <span className="pill-said">
        <strong>{c.title}</strong>
        <small>{c.lastPreview
          ? `${c.lastPreviewSender ? `${c.lastPreviewSender}: ` : ""}${c.lastPreview}`
          : "Something happened"}</small>
      </span>
      {count > 0
        ? <i className="pill-count">{count > 9 ? "9+" : count}</i>
        : <i className="pill-dot" aria-label="Something happened here"/>}
    </button>
    {others > 0 && <button className="channel-more" onClick={onMore}
      aria-label={`${others} more ${others === 1 ? "channel" : "channels"} waiting`}>+{others}</button>}
    <button className="channel-hush" onClick={() => setHushed(signature)}
      aria-label={rooms.length === 1
        ? `Hide ${c.title} until something new happens`
        : "Hide these until something new happens"}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </nav>;
}

export default ChannelBar;
