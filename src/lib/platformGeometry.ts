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
export function applyNativeInsets(insets: Insets): void {
  const style = document.documentElement.style;
  style.setProperty("--native-inset-top", `${insets.top}px`);
  style.setProperty("--native-inset-right", `${insets.right}px`);
  style.setProperty("--native-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--native-inset-left", `${insets.left}px`);
}
function updateVisibleViewport(): void {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
}
export function installPlatformGeometry(): () => void {
  applyNativeInsets(readNativeInsets() ?? ZERO_INSETS);
  updateVisibleViewport();
  window.addEventListener("resize", updateVisibleViewport);
  window.addEventListener("orientationchange", updateVisibleViewport);
  window.visualViewport?.addEventListener("resize", updateVisibleViewport);
  const onNativeInsets = () => { const insets = readNativeInsets(); if (insets) applyNativeInsets(insets); };
  window.addEventListener("native-insets-changed", onNativeInsets);
  return () => {
    window.removeEventListener("resize", updateVisibleViewport);
    window.removeEventListener("orientationchange", updateVisibleViewport);
    window.visualViewport?.removeEventListener("resize", updateVisibleViewport);
    window.removeEventListener("native-insets-changed", onNativeInsets);
  };
}
