import { useEffect, useState } from "react";
import type { ChatMessage } from "../lib/types";
import { previewOf } from "../lib/ingest";

/**
 * The pinned things in a room, as a strip under the header.
 *
 * Collapsed it shows the newest pin, because the common case is one thing that matters this week —
 * the wifi password, the packing list — and a permanent list of everything ever pinned would cost
 * the thread more room than it is worth. The count opens the rest.
 */
export function PinnedStrip({ pins, nameFor, canEdit, onJump, onUnpin }: {
  pins: ChatMessage[];
  nameFor(deviceId: string): string;
  canEdit: boolean;
  onJump(id: string): void;
  onUnpin(m: ChatMessage): void;
}) {
  const [open, setOpen] = useState(false);
  // Unpinning the last one, or somebody else doing it, should not leave an open drawer of nothing.
  useEffect(() => { if (pins.length <= 1) setOpen(false); }, [pins.length]);
  if (!pins.length) return null;

  const newest = pins[pins.length - 1];
  const label = (m: ChatMessage): string => previewOf(m.payload) || "Message";

  return <div className={`pinned ${open ? "open" : ""}`}>
    <div className="pinned-row">
      {/* Open, the top line is a heading rather than the newest pin over again — the drawer under
          it already starts with that one, and showing it twice reads as a duplicate. */}
      {open
        ? <span className="pinned-main pinned-heading">
            <span className="pinned-pin" aria-hidden="true">📌</span>
            <span className="pinned-text"><b>Pinned</b><em>{pins.length} things</em></span>
          </span>
        : <button className="pinned-main" onClick={() => onJump(newest.id)}>
            <span className="pinned-pin" aria-hidden="true">📌</span>
            <span className="pinned-text">
              <b>{nameFor(newest.senderDeviceId)}</b>
              <em>{label(newest)}</em>
            </span>
          </button>}
      {pins.length > 1
        ? <button className="pinned-more" aria-expanded={open} onClick={() => setOpen(x => !x)}>
            {open ? "Hide" : `+${pins.length - 1}`}
          </button>
        : canEdit && <button className="pinned-off" aria-label="Unpin" onClick={() => onUnpin(newest)}>✕</button>}
    </div>
    {open && <ul className="pinned-list">
      {[...pins].reverse().map(m => <li key={m.id}>
        <button className="pinned-main" onClick={() => { setOpen(false); onJump(m.id); }}>
          <span className="pinned-text"><b>{nameFor(m.senderDeviceId)}</b><em>{label(m)}</em></span>
        </button>
        {canEdit && <button className="pinned-off" aria-label="Unpin" onClick={() => onUnpin(m)}>✕</button>}
      </li>)}
    </ul>}
  </div>;
}
