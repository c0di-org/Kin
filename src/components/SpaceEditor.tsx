import { useState } from "react";
import { TONES, DEFAULT_TONE } from "../lib/tones";
import type { Conversation } from "../lib/types";

const GROUP_EMOJI = ["🏡", "🎒", "🎸", "⚽", "🍜", "🏕️", "🎬", "📚", "🧗", "🐾", "🌊", "✈️"];
const CHANNEL_EMOJI = ["💬", "🗾", "📚", "📸", "🍳", "🎵", "🎮", "🐕", "🌱", "🛠️", "💡", "🎉"];

/**
 * Change what a place is called, what it looks like, and whether Kin opens into it.
 *
 * The three of them sit together because they are one thought — "this is our beach trip, not our
 * family chat" — and because a name on its own is a weak signal: you have to read it. A colour is
 * the one thing you take in before reading anything, which is why it is here and not buried in
 * settings as a whole-app theme.
 *
 * Nothing here is destructive, so it saves on a button rather than confirming. What it does not
 * offer is changing whether the room keeps things forever: that is a promise made to everybody
 * about what happens to what they send, and quietly flipping it after the fact would break it in
 * whichever direction it was flipped.
 */
export function SpaceEditor({ conversation, isChannel, isHome, onSave, onCancel }: {
  conversation: Conversation;
  isChannel: boolean;
  isHome: boolean;
  onSave(next: { title: string; emoji: string; color: string; home: boolean }): Promise<void>;
  onCancel(): void;
}) {
  const palette = isChannel ? CHANNEL_EMOJI : GROUP_EMOJI;
  const [title, setTitle] = useState(conversation.title);
  const [emoji, setEmoji] = useState(conversation.emoji ?? (isChannel ? "💬" : "🏡"));
  const [color, setColor] = useState(conversation.color ?? DEFAULT_TONE);
  const [home, setHome] = useState(isHome);
  const [busy, setBusy] = useState(false);

  const changed = title.trim() !== conversation.title
    || emoji !== (conversation.emoji ?? (isChannel ? "💬" : "🏡"))
    || color !== (conversation.color ?? DEFAULT_TONE)
    || home !== isHome;

  const go = async (): Promise<void> => {
    if (!title.trim() || busy || !changed) return;
    setBusy(true);
    try { await onSave({ title: title.trim(), emoji, color, home }); }
    finally { setBusy(false); }
  };

  return <>
    <div className="sheet-title"><h2>{isChannel ? "Edit this channel" : "Edit this group"}</h2></div>

    <label className="onboard-label">Pick a face</label>
    <div className="animal-grid">
      {palette.map(e => <button key={e} className={`animal ${emoji === e ? "picked" : ""}`}
        onClick={() => setEmoji(e)} aria-label={e}>{e}</button>)}
    </div>

    <input maxLength={40} value={title} onChange={e => setTitle(e.target.value)}
      placeholder={isChannel ? "Japan trip, Homework…" : "Family, Book club…"}
      onKeyDown={e => e.key === "Enter" && void go()}/>

    <label className="onboard-label">Pick a colour</label>
    <div className="tone-grid">
      {TONES.map(t => <button key={t.key} className={`tone-swatch ${color === t.key ? "picked" : ""}`}
        style={{ background: t.swatch }} onClick={() => setColor(t.key)}
        aria-label={t.label} aria-pressed={color === t.key}>
        {color === t.key && <b aria-hidden>✓</b>}
      </button>)}
    </div>

    <button className={`setting toggle ${home ? "on" : ""}`} onClick={() => setHome(!home)}>
      <span>🏠</span>
      <span className="setting-body">
        <strong>Open Kin here</strong>
        <small>{home
          ? "Kin starts in this conversation"
          : "Kin starts wherever it started before"}</small>
      </span>
      <i className="switch" aria-hidden/>
    </button>

    <button className="primary" disabled={busy || !title.trim() || !changed} onClick={() => void go()}>
      {busy ? "One sec…" : "Save it ✨"}
    </button>
    <button className="link" onClick={onCancel}>Never mind</button>
  </>;
}

export default SpaceEditor;
