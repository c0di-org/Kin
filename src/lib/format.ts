/** Small presentation helpers shared between the app shell and the components it renders. */

export const initials = (s: string): string =>
  s.trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join("") || "•";

/** A stable colour per person, so the same name always reads the same shade. */
export const hue = (s: string): number =>
  [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;

/** Avatar seeds either carry a chosen emoji (`e:🦊`) or fall back to initials. */
export const seedEmoji = (seed: string): string | null => seed.startsWith("e:") ? seed.slice(2) : null;

export const time = (n: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(n);

export const dayLabel = (n: number, now = new Date()): string => {
  const d = new Date(n);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(n);
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
