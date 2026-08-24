import { useState } from "react";
import type { FoldedList } from "../lib/ingest";

/**
 * A shared list inside a bubble: groceries, packing, who is bringing what.
 *
 * Everything here is a folded event, so a tick is not a local checkbox — it is a message everybody
 * in the room folds in the same way, and the list looks the same on every phone whether or not
 * anyone was online when it was ticked.
 */
export function ListCard({ list, canEdit, nameFor, onToggle, onAdd, onRemove }: {
  list: FoldedList;
  /** Viewers, and anyone looking at a deleted list, get the list without the pencil. */
  canEdit: boolean;
  nameFor(deviceId: string): string;
  onToggle(itemId: string, done: boolean): void;
  onAdd(text: string): void;
  onRemove(itemId: string): void;
}) {
  const [adding, setAdding] = useState("");
  const done = list.items.filter(i => i.done).length;
  const all = list.items.length > 0 && done === list.items.length;

  const add = (): void => {
    const text = adding.trim();
    if (!text) return;
    setAdding("");
    onAdd(text);
  };

  return <div className={`list-card ${all ? "all-done" : ""}`}>
    <div className="list-head">
      <strong>{list.title || "List"}</strong>
      <small>{all ? "all done 🎉" : `${done}/${list.items.length}`}</small>
    </div>
    <div className="list-bar" aria-hidden="true">
      <i style={{ width: `${list.items.length ? (done / list.items.length) * 100 : 0}%` }}/>
    </div>
    <ul className="list-items">
      {list.items.map(item => <li key={item.id}>
        <button className={`list-item ${item.done ? "ticked" : ""}`} disabled={!canEdit}
          aria-pressed={item.done}
          onClick={() => onToggle(item.id, !item.done)}>
          <b className="list-box" aria-hidden="true">{item.done ? "✓" : ""}</b>
          <span>{item.text}</span>
          {item.done && item.by && <em>{nameFor(item.by)}</em>}
        </button>
        {canEdit && <button className="list-drop" aria-label={`Remove ${item.text}`}
          onClick={() => onRemove(item.id)}>✕</button>}
      </li>)}
    </ul>
    {canEdit && <div className="list-add"
      /* The bubble opens its reaction bar on a long press; holding down to place a cursor in a
         text field is the same gesture, and would otherwise get the bar instead of a caret. */
      onPointerDown={e => e.stopPropagation()}>
      <input value={adding} placeholder="Add something…" aria-label="Add to the list"
        onChange={e => setAdding(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}/>
      <button disabled={!adding.trim()} onClick={add} aria-label="Add">＋</button>
    </div>}
  </div>;
}
