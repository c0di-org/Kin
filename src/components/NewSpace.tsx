import { useState } from "react";
import type { Conversation } from "../lib/types";

const GROUP_EMOJI = ["🏡", "🎒", "🎸", "⚽", "🍜", "🏕️", "🎬", "📚", "🧗", "🐾", "🌊", "✈️"];
const CHANNEL_EMOJI = ["💬", "🗾", "📚", "📸", "🍳", "🎵", "🎮", "🐕", "🌱", "🛠️", "💡", "🎉"];

/**
 * Make a group, or a channel inside one.
 *
 * The same sheet does both because they are the same act from the user's side — name a place,
 * give it a face — and differ only in what they hang off. What it does add for both is the
 * album question, which is the one decision here that cannot be quietly changed later: a room
 * that keeps things is a different promise from one that forgets them after a week.
 */
export default function NewSpace({ space, onCreate, onCancel }: {
  space: Conversation | null;
  onCreate(title: string, emoji: string, keep: boolean): Promise<void>;
  onCancel(): void;
}) {
  const palette = space ? CHANNEL_EMOJI : GROUP_EMOJI;
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState(palette[0]);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);

  const go = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await onCreate(title, emoji, keep); }
    finally { setBusy(false); }
  };

  return <>
    <div className="sheet-title">
      <h2>{space ? `New channel in ${space.title}` : "New group"}</h2>
    </div>

    <label className="onboard-label">Pick a face</label>
    <div className="animal-grid">
      {palette.map(e => <button key={e} className={`animal ${emoji === e ? "picked" : ""}`} onClick={() => setEmoji(e)} aria-label={e}>{e}</button>)}
    </div>

    <input autoFocus maxLength={40} value={title} onChange={e => setTitle(e.target.value)}
      placeholder={space ? "Japan trip, Homework, Recipes…" : "Book club, Sunday football…"}
      onKeyDown={e => e.key === "Enter" && void go()}/>

    <button className={`setting toggle ${keep ? "on" : ""}`} onClick={() => setKeep(!keep)}>
      <span>🖼️</span>
      <span className="setting-body">
        <strong>Keep everything</strong>
        <small>{keep
          ? "Photos and messages stay until someone deletes them"
          : "Photos and messages clear themselves after a week"}</small>
      </span>
      <i className="switch" aria-hidden/>
    </button>

    <button className="primary" disabled={busy || !title.trim()} onClick={() => void go()}>
      {busy ? "One sec…" : space ? "Make the channel 🎉" : "Make the group 🎉"}
    </button>
    <button className="link" onClick={onCancel}>Never mind</button>
  </>;
}
