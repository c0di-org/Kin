/**
 * The colours a place can be painted in.
 *
 * Each key matches a `.tone-*` class in styles.css, which is where the actual values live —
 * because half of them have to change between light and dark to keep their contrast, and an
 * inline style cannot answer a media query. Everything here is what the picker needs to draw a
 * swatch and name it.
 *
 * The values were solved rather than chosen: white clears 5:1 on every stop of every outgoing
 * bubble gradient, and each tone's ink clears 4.6:1 on --paper in both themes. See the note in
 * styles.css above the block.
 */
export type Tone = { key: string; label: string; swatch: string };

/** Kin's own candy palette, and what a conversation with no colour of its own paints in. */
export const DEFAULT_TONE = "candy";

export const TONES: Tone[] = [
  { key: "candy", label: "Candy", swatch: "linear-gradient(135deg, #45c2ff 0%, #8a7bff 48%, #ff77bd 100%)" },
  { key: "sky", label: "Sky", swatch: "linear-gradient(135deg, #58bae4 0%, #589ee4 48%, #5874e4 100%)" },
  { key: "mint", label: "Mint", swatch: "linear-gradient(135deg, #60dcb7 0%, #60dc9e 48%, #60dcd8 100%)" },
  { key: "sun", label: "Sun", swatch: "linear-gradient(135deg, #e6b837 0%, #e68f37 48%, #ea7b53 100%)" },
  { key: "coral", label: "Coral", swatch: "linear-gradient(135deg, #e67356 0%, #e65660 48%, #e65686 100%)" },
  { key: "bubble", label: "Bubble", swatch: "linear-gradient(135deg, #e6569e 0%, #e656bb 48%, #dc56e6 100%)" },
  { key: "plum", label: "Plum", swatch: "linear-gradient(135deg, #ac5ae2 0%, #8c5ae2 48%, #715ae2 100%)" }
];

/** The class that paints a pane, or "" for the default palette — which needs no class at all. */
export function toneClass(color: string | undefined): string {
  if (!color || color === DEFAULT_TONE) return "";
  return TONES.some(t => t.key === color) ? `tone-${color}` : "";
}
