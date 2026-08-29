import { useMemo } from "react";
import { linkHost, linkKind, linkTitle, linkWarning, segments, shortLink, shortPath, type LinkKind } from "../lib/links";
import { parseDeviceLink } from "../lib/devices";
import { parseInviteLink } from "../lib/spaces";

/**
 * Links in a conversation: what they look like, and what happens when somebody taps one.
 *
 * There is no unfurl behind any of this — see `lib/links.ts` for why not — so a "preview" here is
 * the address read carefully rather than the page fetched. That turns out to be most of what a
 * preview is for: what site is this, roughly what is on it, and is the address trying to look
 * like a different one.
 */

const FACE: Record<LinkKind, string> = {
  video: "▶️", photo: "🖼️", music: "🎵", doc: "📄",
  map: "📍", code: "💻", shop: "🛍️", read: "📚", link: "🔗"
};

export const linkFace = (url: string): string => FACE[linkKind(url)];

/**
 * Opening in a new tab, telling that tab nothing.
 *
 * `noopener` so the page cannot reach back into the conversation it was opened from, and
 * `no-referrer` because a family messenger handing every site a note saying which one of these
 * you came from would give away by the back door exactly what the encryption keeps at the front.
 */
export const AWAY = { target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" } as const;

/** Kin's own links, which belong in the app rather than in a browser tab. */
type KinLink = { kind: "join"; code: string; secret: string } | { kind: "device" };

export function kinLink(url: string): KinLink | null {
  // Both secrets live in the fragment. Without one there is nothing here to recognise, and
  // checking anyway would read a `?join=` query on somebody else's site as an invite to a family.
  if (!url.includes("#")) return null;
  const join = parseInviteLink(url);
  if (join) return { kind: "join", ...join };
  return parseDeviceLink(url) ? { kind: "device" } : null;
}

export type JoinHandler = (code: string, secret: string) => void;

/**
 * A link that arrived in a chat, drawn as something worth tapping.
 *
 * Shown for a message that is a link and nothing else, and under one that came with a sentence.
 */
export function LinkCard({ url, onJoin }: { url: string; onJoin?: JoinHandler }) {
  const kin = kinLink(url);

  if (kin?.kind === "join") return <button className="link-card link-card-kin" onClick={() => onJoin?.(kin.code, kin.secret)}>
    <b aria-hidden>🏡</b>
    <span>
      <strong>An invite to a Kin room</strong>
      <em>Tap to see what you’ve been asked to join</em>
    </span>
  </button>;

  // Not a link at all as far as this is concerned: it is somebody's keys, and one tap by the
  // wrong person in the room is the whole account. Nothing here is clickable on purpose.
  if (kin?.kind === "device") return <div className="link-card link-card-danger">
    <b aria-hidden>⚠️</b>
    <span>
      <strong>This carries somebody’s whole Kin account</strong>
      <em>Only ever meant for another of your own screens. Whoever sent it should turn it off in Settings → Your devices.</em>
    </span>
  </div>;

  const title = linkTitle(url);
  const warn = linkWarning(url);
  return <a className={`link-card ${warn ? "link-card-warn" : ""}`} href={url} title={url} {...AWAY}
    onContextMenu={e => e.stopPropagation()}>
    <b aria-hidden>{warn ? "⚠️" : linkFace(url)}</b>
    <span>
      {/* Without a title the heading is the site itself, so the line under it drops the host it
          would otherwise repeat and shows only where on the site this goes. */}
      <strong>{title ?? linkHost(url)}</strong>
      <em>{title ? shortLink(url, 46) : shortPath(url, 40) || "Tap to open"}</em>
      {warn && <i className="link-warn">{warn}</i>}
    </span>
  </a>;
}

/** One link inside a sentence, at a length that leaves room for the sentence. */
function InlineLink({ url, onJoin }: { url: string; onJoin?: JoinHandler }) {
  const kin = kinLink(url);
  if (kin?.kind === "join") return <button className="link-inline link-inline-kin" onClick={() => onJoin?.(kin.code, kin.secret)}>
    🏡 a Kin invite
  </button>;
  if (kin?.kind === "device") return <span className="link-inline-danger" title="A link carrying somebody’s Kin account">
    ⚠️ a link to somebody’s account
  </span>;
  const warn = linkWarning(url);
  return <a className={`link-inline ${warn ? "warn" : ""}`} href={url} title={warn ? `${url}\n\n${warn}` : url} {...AWAY}
    onContextMenu={e => e.stopPropagation()}>{warn ? "⚠ " : ""}{shortLink(url, 30)}</a>;
}

/**
 * The text of a message, with whatever links are in it made tappable.
 *
 * A message that is only a link is drawn as the card alone — repeating the address above it is
 * the noise this was meant to remove. A message that is a sentence keeps its sentence, with the
 * link shortened in place, and gets the card underneath only when there is exactly one link to
 * put on it: two cards under one message is a wall, and picking one of the two to feature would
 * be guessing which one the sentence was about.
 */
export function MessageText({ text, onJoin }: { text: string; onJoin?: JoinHandler }) {
  const parts = useMemo(() => segments(text), [text]);
  const links = useMemo(() => parts.flatMap(p => p.kind === "link" ? [p.url] : []), [parts]);
  const bare = links.length === 1 && parts.every(p => p.kind === "link" || !p.text.trim());

  if (bare) return <LinkCard url={links[0]} onJoin={onJoin}/>;
  return <>
    <span className="text">{parts.map((p, i) => p.kind === "text"
      ? p.text
      : <InlineLink key={i} url={p.url} onJoin={onJoin}/>)}</span>
    {links.length === 1 && <LinkCard url={links[0]} onJoin={onJoin}/>}
  </>;
}
