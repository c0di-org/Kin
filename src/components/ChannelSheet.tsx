import type { Conversation } from "../lib/types";

/**
 * Every room in this space, for when you mean to go somewhere rather than being called.
 *
 * This is the half of the old channel bar that was actually worth keeping: the whole map, in
 * order, with what is waiting in each. It lives in a sheet because a sheet costs nothing until it
 * is opened and, on a phone, opens under your thumb — a permanent row along the top was neither.
 *
 * The space itself is the first row, and is named rather than called "Main": from inside a
 * channel it is one room among the others, and "Home" tells a seven-year-old which one it is in a
 * way that "Main" does not.
 */
export function ChannelSheet({ space, channels, activeId, onOpen, onNew }: {
  space: Conversation;
  channels: Conversation[];
  activeId: string | null;
  onOpen(id: string): void;
  /** Absent for anyone who may not make a channel here — a guest, or a viewer. */
  onNew?: () => void;
}) {
  const row = (c: Conversation, isSpace: boolean) => {
    const count = c.unread ?? 0;
    const here = c.id === activeId;
    return <button key={c.id} className={`member channel-row ${here ? "here" : ""}`}
      aria-current={here ? "page" : undefined} onClick={() => onOpen(c.id)}>
      <span className="member-emoji">{c.emoji ?? (isSpace ? "🏡" : "💬")}</span>
      <span>
        <strong>{c.title}</strong>
        <small>{here
          ? "You’re here"
          : c.lastPreview
            ? `${c.lastPreviewSender ? `${c.lastPreviewSender}: ` : ""}${c.lastPreview}`
            : isSpace ? "Everyone, about everything" : "Nothing yet"}</small>
      </span>
      {count > 0
        ? <i className="unread">{count > 9 ? "9+" : count}</i>
        : c.nudge ? <i className="unread quiet" aria-label="Something happened here"/> : null}
    </button>;
  };

  return <>
    <h2>Channels in {space.title}</h2>
    <p className="sheet-sub">Everyone here can see all of them — a channel splits up the talking, not who’s allowed.</p>
    {row(space, true)}
    {channels.map(c => row(c, false))}
    {onNew && <button className="member channel-make" onClick={onNew}>
      <span className="member-emoji">＋</span>
      <span><strong>New channel</strong><small>Somewhere for one thing, so it stops filling up the main chat</small></span>
    </button>}
  </>;
}

export default ChannelSheet;
