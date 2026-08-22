/** Small presentation helpers shared between the app shell and the components it renders. */

export const initials = (s: string): string =>
  s.trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join("") || "•";

/**
 * A stable colour per person, so the same face always reads the same shade.
 *
 * Two things here were wrong before. It hashed the avatar seed, which is "e:" plus one emoji —
 * and emoji are surrogate pairs whose differing code unit is tiny next to `n * 31`, so all
 * sixteen animals collapsed onto hue 136 or 137. Every member of every family was the same
 * green, in their avatar, in the family ring, and in their name above a group message. It also
 * produced a raw hue, which cannot be made readable: at a fixed lightness, yellow text and blue
 * text are nowhere near the same contrast.
 *
 * So: hash the deviceId, which is unique per person and not chosen from a set of sixteen, and
 * spend it on an index into a palette whose lightness is tuned per hue — see --p0..--p11 in
 * styles.css, where both themes clear 4.5:1 on every entry.
 */
export const PERSON_COLOURS = 12;

export const personIndex = (id: string): number => {
  // FNV-1a over code points. The old hash mixed so weakly that inputs differing only in their
  // last character landed within one of each other.
  let h = 0x811c9dc5;
  for (const c of id) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return h % PERSON_COLOURS;
};

/** The two custom properties carrying one person's colour, for an inline style. */
export const personColour = (id: string): { bg: string; name: string } => {
  const i = personIndex(id);
  return { bg: `var(--p${i}-bg)`, name: `var(--p${i}-name)` };
};

/** Avatar seeds either carry a chosen emoji (`e:🦊`) or fall back to initials. */
export const seedEmoji = (seed: string): string | null => seed.startsWith("e:") ? seed.slice(2) : null;

export const time = (n: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(n);

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole days between two instants, counting calendar days rather than 24-hour spans. */
const daysApart = (n: number, now: Date): number =>
  Math.round((startOfDay(now) - startOfDay(new Date(n))) / 86_400_000);

export const dayLabel = (n: number, now = new Date()): string => {
  const days = daysApart(n, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = new Date(n).getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" })
  }).format(n);
};

/**
 * When something happened, for a summary row rather than a message.
 *
 * A conversation list showed `time()` no matter how old the row was, so last week's message read
 * "4:23 PM" and looked like it had just arrived. Inside a thread that is fine — the day dividers
 * carry the date — but a list has nothing else to say it with.
 */
export const listStamp = (n: number, now = new Date()): string => {
  const days = daysApart(n, now);
  if (days <= 0) return time(n);
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(n);
  const sameYear = new Date(n).getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(n);
};

/** A short all-emoji message gets rendered large, the way every messenger does it. */
export const emojiOnly = (t: string): boolean => {
  const chars = Array.from(t.replace(/[‍️\s]/gu, ""));
  return chars.length > 0 && chars.length <= 6 &&
    chars.every(c => /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u.test(c));
};

export const greeting = (now = new Date()): string => {
  const h = now.getHours();
  return h < 5 ? "Up late? 🌙" : h < 12 ? "Good morning ☀️" : h < 18 ? "Good afternoon 🌤️" : "Good evening 🌙";
};
