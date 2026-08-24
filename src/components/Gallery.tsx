import { useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentPayload, ChatMessage, Conversation, LocalIdentity } from "../lib/types";
import { scanMessages } from "../lib/db";
import { cachedUrl, fmtDuration, isDoodle, mediaKind, resolveAttachment } from "../lib/media";
import { extractLinks, linkHost, linkTail, withoutLinks } from "../lib/links";
import { listStamp, monthLabel } from "../lib/format";

export type GalleryTab = "photos" | "links";

type Shot = { m: ChatMessage; att: AttachmentPayload };
type Link = { url: string; m: ChatMessage; said: string };

/**
 * Only ever true of a message we are already holding: a tombstone whose contents were dropped, or
 * one whose delete event this device has folded but not yet written back over.
 */
const gone = (m: ChatMessage, deleted: Set<string>): boolean => !!m.deletedAt || deleted.has(m.id);

/**
 * A tile that fetches when it is nearly on screen, and not before.
 *
 * A family album is hundreds of photos, each one an encrypted download and a decrypt. Resolving
 * all of them the moment the sheet opens would spend somebody's phone battery and data on the
 * nine hundred pictures they were not looking for. The blurred preview that rides inside the
 * payload is already here and costs nothing, so it holds the place until the real one arrives.
 */
function Tile({ identity, conversation, shot, onOpen }: {
  identity: LocalIdentity;
  conversation: Conversation;
  shot: Shot;
  onOpen(shot: Shot): void;
}) {
  const { att } = shot;
  const box = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(() => cachedUrl(att.fileId));
  const [failed, setFailed] = useState(false);
  const kind = mediaKind(att);

  useEffect(() => {
    // A video is left as a poster-less tile on purpose: there is no cheap frame to draw, and
    // pulling a whole film down to show a thumbnail is the opposite of what this is for.
    if (url || kind !== "image" || !box.current) return;
    let live = true;
    const watcher = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      watcher.disconnect();
      void resolveAttachment(identity, conversation, att).then(u => {
        if (!live) return;
        if (u) setUrl(u); else setFailed(true);
      });
    }, { rootMargin: "300px" });
    watcher.observe(box.current);
    return () => { live = false; watcher.disconnect(); };
  }, [att.fileId, url, kind]);

  return <button ref={box} className={`shot ${kind === "video" ? "shot-video" : ""}`} onClick={() => onOpen(shot)}
    aria-label={`${isDoodle(att) ? "Doodle" : kind === "video" ? "Video" : "Photo"} from ${listStamp(shot.m.createdAt)}`}>
    {url
      ? <img src={url} alt=""/>
      : att.thumb
        ? <img className="shot-thumb" src={att.thumb} alt=""/>
        : <span className="shot-blank">{failed ? "🌫️" : kind === "video" ? "🎬" : isDoodle(att) ? "🖍️" : "📷"}</span>}
    {kind === "video" && <b className="shot-badge">▶ {att.durationMs ? fmtDuration(att.durationMs) : "Video"}</b>}
  </button>;
}

/**
 * Everything this conversation has ever been sent, arranged so it can be found again.
 *
 * Both halves are read straight off this device — the photos out of the local blob cache or the
 * relay, the links out of the messages themselves. Nothing is asked of anybody else: no favicon
 * fetch, no title lookup, no unfurl. See `lib/links.ts` for why that matters more here than the
 * prettier list it costs us.
 */
export function Gallery({ identity, conversation, deleted, tab, onTab, onOpen, onJump, nameFor }: {
  identity: LocalIdentity;
  conversation: Conversation;
  /** Deletions folded out of the open thread, which the stored rows may not carry yet. */
  deleted: Set<string>;
  tab: GalleryTab;
  onTab(tab: GalleryTab): void;
  onOpen(shot: Shot): void;
  onJump(messageId: string): void;
  nameFor(deviceId: string): string;
}) {
  const [rows, setRows] = useState<ChatMessage[] | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    void scanMessages(conversation.id, m =>
      (m.payload.type === "file" && !!m.payload.attachment) ||
      (m.payload.type === "text" && !!m.payload.text && m.payload.text.includes("."))
    ).then(found => { if (live) setRows(found); });
    return () => { live = false; };
  }, [conversation.id]);

  const { shots, links } = useMemo(() => {
    const shots: Shot[] = [];
    const links: Link[] = [];
    const seen = new Set<string>();
    for (const m of rows ?? []) {
      if (gone(m, deleted)) continue;
      const att = m.payload.attachment;
      if (att) {
        const kind = mediaKind(att);
        if (kind === "image" || kind === "video") shots.push({ m, att });
        continue;
      }
      const text = m.payload.text ?? "";
      for (const url of extractLinks(text)) {
        // Newest first out of the cursor, so the first time we meet a link is the last time it was
        // sent — which is the one worth showing when the family has passed it around three times.
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({ url, m, said: withoutLinks(text) });
      }
    }
    return { shots, links };
  }, [rows, deleted]);

  // Months, newest first, the way anybody looking for last summer would scroll.
  const months = useMemo(() => {
    const out: { label: string; shots: Shot[] }[] = [];
    for (const shot of shots) {
      const label = monthLabel(shot.m.createdAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.shots.push(shot);
      else out.push({ label, shots: [shot] });
    }
    return out;
  }, [shots]);

  const counted = (n: number): string => n > 99 ? "99+" : `${n}`;

  return <>
    <div className="gallery-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "photos"} className={tab === "photos" ? "on" : ""}
        onClick={() => onTab("photos")}>📷 Photos {rows && <i>{counted(shots.length)}</i>}</button>
      <button role="tab" aria-selected={tab === "links"} className={tab === "links" ? "on" : ""}
        onClick={() => onTab("links")}>🔗 Links {rows && <i>{counted(links.length)}</i>}</button>
    </div>

    {!rows && <div className="hello-card">⏳<p>Having a look…</p></div>}

    {rows && tab === "photos" && (shots.length === 0
      ? <div className="hello-card">📷<p>No photos here yet — send one and it lands in here too.</p></div>
      : months.map(month => <div key={month.label} className="gallery-month">
          <h3>{month.label}</h3>
          <div className="photo-grid">
            {month.shots.map(shot => <Tile key={shot.m.id} identity={identity} conversation={conversation} shot={shot} onOpen={onOpen}/>)}
          </div>
        </div>))}

    {rows && tab === "links" && (links.length === 0
      ? <div className="hello-card">🔗<p>No links here yet — anything anybody sends turns up in here.</p></div>
      : <ul className="link-list">
          {links.map(({ url, m, said }) => <li key={`${m.id}-${url}`}>
            <a className="link-row" href={url} target="_blank" rel="noopener noreferrer">
              <b aria-hidden>{linkHost(url).slice(0, 1).toUpperCase()}</b>
              <span>
                <strong>{linkHost(url)}</strong>
                <em>{said || linkTail(url) || url}</em>
                <small>{nameFor(m.senderDeviceId)} · {listStamp(m.createdAt)}</small>
              </span>
            </a>
            <button className="link-jump" onClick={() => onJump(m.id)} aria-label="Show in the conversation">↩</button>
          </li>)}
        </ul>)}
  </>;
}

export default Gallery;
