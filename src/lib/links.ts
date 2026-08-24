/**
 * Finding the links people have sent each other.
 *
 * Deliberately local arithmetic and nothing else: no favicon fetch, no title lookup, no unfurl
 * service. Kin is end-to-end encrypted, and a list that quietly asked a third party for an icon
 * would hand that third party — and anybody watching the request — the one thing the encryption
 * exists to keep, which is who is reading what. So a link is shown as what it says about itself:
 * its host, its path, and the message it arrived in.
 */

// Bare `www.` counts, because people type it. Anything else needs a scheme — matching every
// dotted word would turn "see you at 8 p.m." into a link to a Myanmar domain.
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
// Sentences end in punctuation and URLs rarely do. A closing bracket only survives if the link
// opened one, so "(see https://example.com/a_(b))" keeps its parenthesis and "(see …com)" does not.
const TRAILING = /[.,;:!?'"»›]+$/;

function tidy(raw: string): string | null {
  let value = raw.replace(TRAILING, "");
  while (value.endsWith(")") && (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)) {
    value = value.slice(0, -1).replace(TRAILING, "");
  }
  const withScheme = /^www\./i.test(value) ? `https://${value}` : value;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch { return null; }
}

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

/** What to call a link in a list: the site, without the noise in front of it. */
export function linkHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch { return url; }
}

/** The rest of it, for the line underneath — "/watch?v=…" reads better than the host repeated. */
export function linkTail(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    const tail = `${pathname}${search}`;
    return tail === "/" ? "" : tail;
  } catch { return ""; }
}
