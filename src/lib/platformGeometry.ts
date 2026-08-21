export type Insets = { top: number; right: number; bottom: number; left: number };
export const NATIVE_INSET_BRIDGE = "__TAURI_VIBE_INSETS__";
const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
type NativeInsetBridge = { insets: () => string };
export function parseInsets(value: unknown): Insets | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Insets>;
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const n = input[edge];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  }
  return input as Insets;
}
function nativeBridge(): NativeInsetBridge | undefined {
  return (window as unknown as Record<string, NativeInsetBridge | undefined>)[NATIVE_INSET_BRIDGE];
}
export function readNativeInsets(): Insets | null {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.insets !== "function") return null;
  try { return parseInsets(JSON.parse(bridge.insets())); } catch { return null; }
}

/** The screen a `position: fixed` layer actually gets, plus what env(safe-area-inset-*) resolves to on it. */
export type Frame = { insets: Insets; height: number };

/** One hidden probe answers both questions at once, so the two can never disagree. */
function measureFrame(): Frame {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none;"
    + "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);"
    + "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (v: string): number => Math.max(0, Math.round(parseFloat(v) || 0));
  const frame: Frame = {
    insets: { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) },
    height: Math.round(probe.getBoundingClientRect().height) || window.innerHeight,
  };
  probe.remove();
  return frame;
}

export function applyNativeInsets(insets: Insets): void {
  const style = document.documentElement.style;
  style.setProperty("--native-inset-top", `${insets.top}px`);
  style.setProperty("--native-inset-right", `${insets.right}px`);
  style.setProperty("--native-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--native-inset-left", `${insets.left}px`);
}

/**
 * Publishes two independent things and never mixes them:
 *
 *   --shell-height / --inset-*   the physical screen. Backgrounds use this and stay safe-area-blind.
 *   --safe-*                     how far content has to stay off each edge *right now*.
 *
 * The bottom is the one everybody gets wrong, because three different things can eat it — the home
 * indicator, Safari's toolbar and the on-screen keyboard — and they overlap rather than stack. So
 * instead of guessing which is in play (standalone? tab? keyboard?) we measure where the browser
 * stops showing us pixels and compare that against where the home indicator starts. Whichever bites
 * first wins, once. That is what kills the double padding: --safe-bottom is already the final answer,
 * so no rule downstream ever adds or subtracts an inset again.
 */
export function computeGeometry(frame: Frame, insets: Insets, viewportTop: number, viewportHeight: number): Record<string, number> {
  const screen = Math.max(frame.height, viewportTop + viewportHeight);
  // The last row of pixels the browser is actually showing us: top of the keyboard, top of Safari's
  // toolbar, or the bottom of the screen — whichever comes first.
  const shown = Math.min(screen, viewportTop + viewportHeight);
  // The last row content may sit on without the home indicator crossing it.
  const clear = screen - insets.bottom;
  return {
    "--inset-top": insets.top,
    "--inset-right": insets.right,
    "--inset-bottom": insets.bottom,
    "--inset-left": insets.left,
    // measured from the bottom of the shell, which is the bottom of the screen
    "--safe-bottom": Math.max(0, screen - Math.min(shown, clear)),
    "--safe-top": Math.max(0, insets.top - viewportTop),
    "--safe-left": insets.left,
    "--safe-right": insets.right,
    "--app-height": viewportHeight,
    "--shell-height": Math.max(0, screen - viewportTop),
    "--viewport-top": viewportTop,
    // whatever the browser took off the bottom on top of the safe area — the keyboard, in practice
    "--keyboard-inset": Math.max(0, screen - shown - insets.bottom),
  };
}

function update(): void {
  const style = document.documentElement.style;
  const native = readNativeInsets();
  if (native) applyNativeInsets(native);
  const frame = measureFrame();
  const vv = window.visualViewport;
  const geometry = computeGeometry(
    frame,
    native ?? frame.insets,
    Math.max(0, Math.round(vv?.offsetTop ?? 0)),
    Math.round(vv?.height ?? frame.height),
  );
  for (const [name, value] of Object.entries(geometry)) style.setProperty(name, `${value}px`);
}

export function installPlatformGeometry(): () => void {
  applyNativeInsets(readNativeInsets() ?? ZERO_INSETS);
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  const onNativeInsets = () => update();
  window.addEventListener("native-insets-changed", onNativeInsets);
  return () => {
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
    window.removeEventListener("native-insets-changed", onNativeInsets);
  };
}
