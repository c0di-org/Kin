import { useState } from "react";
import type { ListItem } from "../lib/types";

const SUGGESTIONS = ["🛒 Groceries", "🧳 Packing", "🧹 Chores", "🎁 Presents"];

/** Writing a list before it is sent. Once it lands, everyone edits it in place in the thread. */
export default function NewList({ onCancel, onSend }: {
  onCancel(): void;
  onSend(title: string, items: ListItem[]): void;
}) {
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState<ListItem[]>([]);

  // Ids are minted here rather than at send time so that a line typed now and a line somebody adds
  // from their phone later can never collide on the same id.
  const add = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setItems(x => [...x, { id: crypto.randomUUID(), text }]);
  };

  const send = (): void => {
    const text = draft.trim();
    // Whatever is still sitting in the box counts — nobody expects the line they just typed to be
    // thrown away because they pressed Send instead of Enter.
    const all = text ? [...items, { id: crypto.randomUUID(), text }] : items;
    onSend(title.trim() || "List", all);
  };

  return <div className="new-list">
    <h2>Start a list ✅</h2>
    <p className="sheet-sub">Everyone can tick things off and add their own.</p>
    <input className="name-input" autoFocus placeholder="What’s it for?" value={title}
      maxLength={60} onChange={e => setTitle(e.target.value)}/>
    {!title && <div className="list-suggests">
      {SUGGESTIONS.map(s => <button key={s} className="chip-btn" onClick={() => setTitle(s)}>{s}</button>)}
    </div>}
    <ul className="list-draft">
      {items.map(i => <li key={i.id}>
        <span>{i.text}</span>
        <button aria-label={`Remove ${i.text}`} onClick={() => setItems(x => x.filter(y => y.id !== i.id))}>✕</button>
      </li>)}
    </ul>
    <div className="list-add">
      <input value={draft} placeholder="Add something…" aria-label="Add to the list"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}/>
      <button disabled={!draft.trim()} onClick={add} aria-label="Add">＋</button>
    </div>
    <button className="primary" disabled={!items.length && !draft.trim()} onClick={send}>Send it ✅</button>
    <button className="link" onClick={onCancel}>Never mind</button>
  </div>;
}
