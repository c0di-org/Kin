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

/** Read what env(safe-area-inset-*) actually resolves to right now, so JS can reason about it. */
function measureEnvInsets(): Insets {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;"
    + "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);"
    + "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (v: string): number => Math.max(0, Math.round(parseFloat(v) || 0));
  const insets = { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
  probe.remove();
  return insets;
}

/** A browser tab already keeps its own chrome clear of the home indicator — only installed/native windows own it. */
function ownsScreenEdges(): boolean {
  return !!nativeBridge()
    || window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || window.matchMedia("(display-mode: window-controls-overlay)").matches
    || ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true);
}

export function applyNativeInsets(insets: Insets): void {
  const style = document.documentElement.style;
  style.setProperty("--native-inset-top", `${insets.top}px`);
  style.setProperty("--native-inset-right", `${insets.right}px`);
  style.setProperty("--native-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--native-inset-left", `${insets.left}px`);
}

function updateInsets(): void {
  const style = document.documentElement.style;
  const native = readNativeInsets();
  if (native) applyNativeInsets(native);
  const env = measureEnvInsets();
  const insets = native ?? env;
  const edges = ownsScreenEdges();
  style.setProperty("--inset-top", `${insets.top}px`);
  style.setProperty("--inset-right", `${insets.right}px`);
  style.setProperty("--inset-left", `${insets.left}px`);
  // In a plain browser tab the toolbar already sits over the home indicator; padding for it again
  // leaves a dead band under the composer.
  style.setProperty("--inset-bottom", `${edges ? insets.bottom : 0}px`);
}

function updateVisibleViewport(): void {
  const style = document.documentElement.style;
  const vv = window.visualViewport;
  const height = Math.round(vv?.height ?? window.innerHeight);
  const offsetTop = Math.round(vv?.offsetTop ?? 0);
  // Whatever the on-screen keyboard is covering. The keyboard hides the home indicator too, so the
  // bottom safe-area inset has to stand down while it is up.
  const keyboard = Math.max(0, Math.round(window.innerHeight - height - offsetTop));
  style.setProperty("--app-height", `${height}px`);
  style.setProperty("--viewport-top", `${offsetTop}px`);
  style.setProperty("--keyboard-inset", `${keyboard}px`);
}

export function installPlatformGeometry(): () => void {
  applyNativeInsets(readNativeInsets() ?? ZERO_INSETS);
  updateInsets();
  updateVisibleViewport();
  const onViewport = (): void => { updateVisibleViewport(); updateInsets(); };
  window.addEventListener("resize", onViewport);
  window.addEventListener("orientationchange", onViewport);
  window.visualViewport?.addEventListener("resize", updateVisibleViewport);
  window.visualViewport?.addEventListener("scroll", updateVisibleViewport);
  const onNativeInsets = () => { const insets = readNativeInsets(); if (insets) { applyNativeInsets(insets); updateInsets(); } };
  window.addEventListener("native-insets-changed", onNativeInsets);
  return () => {
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("orientationchange", onViewport);
    window.visualViewport?.removeEventListener("resize", updateVisibleViewport);
    window.visualViewport?.removeEventListener("scroll", updateVisibleViewport);
    window.removeEventListener("native-insets-changed", onNativeInsets);
  };
}
