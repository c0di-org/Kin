import type { Conversation } from "../lib/types";

/**
 * The channels of the space you are currently inside, along the top of the conversation.
 *
 * Before this, the only way from one channel to another was out to the sidebar and back in —
 * which on a phone means leaving the conversation entirely, since the list and the thread are the
 * same screen. A space is supposed to feel like a place with rooms in it, and you do not leave a
 * house to walk down its own hallway.
 *
 * It appears only once a space actually has channels. A family group that never made one stays
 * exactly as flat as it was, which is the same bargain the sidebar strikes: the family case does
 * not pay for the project case.
 */
export function ChannelBar({ space, channels, activeId, unreadOf, onOpen, onNew }: {
  space: Conversation;
  channels: Conversation[];
  activeId: string | null;
  unreadOf(c: Conversation): { count: number; nudge: boolean };
  onOpen(id: string): void;
  /** Absent for anyone who may not make a channel here — a guest, or a viewer. */
  onNew?: () => void;
}) {
  const pill = (c: Conversation, isSpace: boolean) => {
    const { count, nudge } = unreadOf(c);
    const active = c.id === activeId;
    return <button key={c.id} className={`channel-pill ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined} onClick={() => onOpen(c.id)}>
      <span aria-hidden>{c.emoji ?? (isSpace ? "🏡" : "💬")}</span>
      <em>{isSpace ? "Main" : c.title}</em>
      {count > 0
        ? <i className="pill-count">{count > 9 ? "9+" : count}</i>
        : nudge && <i className="pill-dot" aria-label="Something happened here"/>}
    </button>;
  };

  return <nav className="channel-bar" aria-label={`Channels in ${space.title}`}>
    {pill(space, true)}
    {channels.map(c => pill(c, false))}
    {onNew && <button className="channel-pill channel-new" onClick={onNew} aria-label="New channel">＋</button>}
  </nav>;
}

export default ChannelBar;
