/**
 * Finding, reading and shortening the links people have sent each other.
 *
 * Deliberately local arithmetic and nothing else: no favicon fetch, no title lookup, no unfurl
 * service. Kin is end-to-end encrypted, and a card that quietly asked a third party for an icon
 * would hand that third party — and anybody watching the request — the one thing the encryption
 * exists to keep, which is who is reading what. So a link is shown as what it says about itself:
 * its host, what its path looks like it is about, and the message it arrived in.
 *
 * That constraint is why so much of this file is guesswork over a URL. Everything here runs on
 * the string alone, and every guess degrades to "just show the address" rather than to a wrong
 * confident answer.
 */

// Bare `www.` counts, because people type it. Anything else needs a scheme — matching every
// dotted word would turn "see you at 8 p.m." into a link to a Myanmar domain.
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Sentences end in punctuation and URLs rarely do. A closing bracket only survives if the link
// opened one, so "(see https://example.com/a_(b))" keeps its parenthesis and "(see …com)" does not.
const TRAILING = /[.,;:!?'"»›]+$/;

/** How much of a match is actually the link, with the prose that ran into it given back. */
function trimmed(raw: string): string {
  let value = raw.replace(TRAILING, "");
  while (value.endsWith(")") && (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)) {
    value = value.slice(0, -1).replace(TRAILING, "");
  }
  return value;
}

function toUrl(value: string): string | null {
  const withScheme = /^www\./i.test(value) ? `https://${value}` : value;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch { return null; }
}

const tidy = (raw: string): string | null => toUrl(trimmed(raw));

/** Every link in a piece of text, in the order it was written, without repeats. */
export function extractLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(LINK)) {
    const url = tidy(match[0]);
    if (url) found.add(url);
  }
  return [...found];
}

/**
 * A message cut into the runs that are links and the runs that are not, so it can be drawn.
 *
 * Repeats are kept, unlike `extractLinks`: this is the message as written, and a person who sent
 * the same address twice wrote it twice. The link's own text is what was typed with its trailing
 * full stop handed back to the sentence — so tapping "…example.com." lands on the page and the
 * full stop stays prose.
 */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; url: string };

export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    const shown = trimmed(match[0]);
    const url = toUrl(shown);
    if (!url) continue;
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    out.push({ kind: "link", text: shown, url });
    at = start + shown.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/**
 * What somebody said around the links, for the line under one in a list.
 *
 * Every link goes, not just the one being described: a message carrying two of them would
 * otherwise use each as the caption for the other, which reads as noise twice over. The raw text
 * is what is stripped rather than the tidied URL — "www.bbc.co.uk" and the "https://www.bbc.co.uk"
 * it becomes are not the same string.
 */
export function withoutLinks(text: string): string {
  return text.replace(LINK, " ").replace(/\s+/g, " ").trim();
}

/**
 * A message reduced to one line for a summary row — a sidebar, a pinned strip, a reply chip.
 *
 * A row two hundred characters of tracking parameters wide told you nothing about the chat it
 * belonged to. The site does, in the width a summary line actually has.
 */
export function summariseLinks(text: string): string {
  return segments(text)
    .map(s => s.kind === "link" ? `🔗 ${linkHost(s.url)}` : s.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** What to call a link in a list: the site, without the noise in front of it. */
export function linkHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch { return url; }
}

const decodeSafely = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

const ellipsis = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;

/**
 * Parameters that are about the person clicking rather than the page they land on.
 *
 * Dropped from what is *shown* and never from what is opened: a shortener whose whole address is
 * a parameter, or a shop that will not find the item without one, has to keep working. The point
 * here is only that "?utm_source=newsletter&utm_campaign=spring24" is not information a family
 * needs in a chat bubble.
 */
const TRACKING = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|yclid|msclkid|mc_[ce]id|igshid|si|ref|ref_src|ref_url|source|spm|scid|cmpid|_branch_match_id)$/i;

function shownQuery(u: URL): string {
  const kept = [...u.searchParams].filter(([k]) => !TRACKING.test(k));
  if (!kept.length) return "";
  const [k, v] = kept[0];
  const one = `?${k}=${v}`;
  if (one.length > 26) return "";
  return kept.length > 1 ? `${one}&…` : one;
}

/**
 * A link at a length that fits in a bubble.
 *
 * Three things go, in order of how little they say: the scheme and the `www.`, which are the same
 * on nearly every link anybody sends; the tracking parameters; and then the middle of the path,
 * because a path's first segment says what kind of thing this is and its last says which one,
 * while everything between is the site's own filing system. What comes back always ends in "…"
 * when something was dropped, so a shortened address never reads as a whole one.
 */
export function shortLink(url: string, max = 44): string {
  let u: URL;
  try { u = new URL(url); } catch { return ellipsis(url, max); }
  const host = u.host.replace(/^www\./i, "");
  const path = decodeSafely(u.pathname).replace(/\/+$/, "");
  const query = shownQuery(u);
  const full = `${host}${path}${query}`;
  if (full.length <= max) return full;
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 2) {
    const squeezed = `${host}/${parts[0]}/…/${parts[parts.length - 1]}${query}`;
    if (squeezed.length <= max) return squeezed;
  }
  const last = parts[parts.length - 1] ?? "";
  if (last) {
    const lead = parts.length > 1 ? `${host}/…/` : `${host}/`;
    // Cutting the last segment short still says which page this is; cutting the whole address
    // short at the same width spends every character on the site's filing and never reaches it.
    if (lead.length + 5 <= max) return `${lead}${ellipsis(last, max - lead.length)}`;
  }
  return ellipsis(full, max);
}

/** The same, without the host — for a card whose heading is already showing the site. */
export function shortPath(url: string, max = 40): string {
  const host = linkHost(url);
  const short = shortLink(url, max + host.length);
  return short.startsWith(host) ? short.slice(host.length) : short;
}

// A segment carrying no meaning for a person: a hex blob, a bare number, a long opaque token.
const IDISH = /^(?:[0-9a-f]{8,}|\d+|[A-Za-z0-9]{22,})$/;
const FILE_EXT = /\.(html?|php|aspx?|jsp|md|pdf|docx?|txt)$/i;

/**
 * The title a link would probably have, read off its own path.
 *
 * This is the whole of Kin's "preview": no request leaves the device, so the only thing left to
 * read is the address, and most of the web puts a human sentence in it. A slug has separators in
 * it — that is what makes it a slug rather than a section of the site — so "chocolate-fudge-cake"
 * becomes a title and "/news/articles/" does not, which is right: "Articles" would be a confident
 * label for nothing. When the last segment is an id, the one before it usually holds the words.
 *
 * Null means "we could not tell", and every caller falls back to showing the site instead.
 */
export function linkTitle(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const parts = decodeSafely(u.pathname).split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const named = FILE_EXT.test(last);
  const candidates = IDISH.test(last.replace(FILE_EXT, "")) ? parts.slice(-2, -1) : [last];
  for (const part of candidates) {
    const base = part.replace(FILE_EXT, "");
    // A filename is allowed to be one word — "agenda.pdf" is a title. A path segment is not:
    // without a separator it is nearly always a section of the site rather than a thing on it.
    if (!/[-_+]/.test(base) && !(named && part === last)) continue;
    if (IDISH.test(base)) continue;
    const words = base.replace(/[-_+]+/g, " ")
      // Slugs often end in the row id — "chocolate-cake-10394" is a cake, not a cake called 10394.
      .replace(/\s+\d{3,}$/, "")
      .replace(/\s+/g, " ").trim();
    if (words.length < 3 || !/[aeiouy]/i.test(words)) continue;
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return null;
}

/** Which face a link wears, so a list of them can be read at a glance rather than word by word. */
export type LinkKind = "video" | "photo" | "music" | "doc" | "map" | "code" | "shop" | "read" | "link";

const BY_EXTENSION: [RegExp, LinkKind][] = [
  [/\.(mp4|mov|webm|mkv|avi|m4v)$/i, "video"],
  [/\.(jpe?g|png|gif|webp|avif|heic|svg|bmp)$/i, "photo"],
  [/\.(mp3|m4a|wav|ogg|opus|flac|aac)$/i, "music"],
  [/\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|zip|epub)$/i, "doc"]
];

const BY_HOST: [string[], LinkKind][] = [
  [["youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "twitch.tv", "dailymotion.com"], "video"],
  [["spotify.com", "soundcloud.com", "bandcamp.com", "music.apple.com", "last.fm"], "music"],
  [["openstreetmap.org", "what3words.com", "citymapper.com", "waze.com"], "map"],
  [["github.com", "gitlab.com", "codeberg.org", "npmjs.com", "stackoverflow.com"], "code"],
  [["amazon.com", "amazon.co.uk", "etsy.com", "ebay.com", "ebay.co.uk", "argos.co.uk", "ikea.com", "johnlewis.com"], "shop"],
  [["docs.google.com", "drive.google.com", "dropbox.com", "notion.so", "sheets.google.com", "onedrive.live.com"], "doc"],
  [["wikipedia.org", "bbc.co.uk", "theguardian.com", "nytimes.com", "substack.com", "medium.com", "bbc.com"], "read"],
  [["flickr.com", "imgur.com", "unsplash.com", "pinterest.com", "photos.google.com"], "photo"]
];

const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function linkKind(url: string): LinkKind {
  let u: URL;
  try { u = new URL(url); } catch { return "link"; }
  for (const [pattern, kind] of BY_EXTENSION) if (pattern.test(u.pathname)) return kind;
  const host = u.host.replace(/^www\./i, "");
  // Maps are a path on a domain that is otherwise a search engine, so they are checked by hand.
  if (/^(maps\.)?google\.[a-z.]+$/i.test(host) && /^\/maps/.test(u.pathname)) return "map";
  if (under(host, "maps.apple.com")) return "map";
  for (const [domains, kind] of BY_HOST) if (domains.some(d => under(host, d))) return kind;
  return "link";
}

/**
 * The one sentence worth saying out loud about where a link actually goes, or null.
 *
 * Kin is a messenger for a household, which means somebody's grandmother and somebody's nine year
 * old are both going to tap things in it, and the message carrying the link is trusted by
 * definition — it came from family. So the check is not "is this site bad", which is not knowable
 * from here and would need asking someone anyway. It is the much smaller and entirely local
 * question of whether the address is written in one of the ways that is designed to be misread.
 *
 * Ordered by how badly it would go wrong: the `user@host` trick reads as one site and goes to
 * another, which is the one people actually fall for.
 */
export function linkWarning(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return `This one really goes to ${u.host} — the part before the @ is decoration.`;
  if (/(^|\.)xn--/i.test(u.hostname)) return "This address is written in another alphabet, which can be made to look like a familiar one.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith("[")) return "This goes to a bare machine address rather than a named site.";
  if (u.protocol === "http:") return "Not a secure connection — don’t type anything private into it.";
  return null;
}
