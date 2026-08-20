import type { LocalIdentity } from "./types";
import { registerPush, relayConfig } from "./relay";

export type PushStatus = "on" | "off" | "blocked" | "needs-install" | "unavailable" | "unconfigured";

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: window-controls-overlay)").matches
    || ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true);
}

export function isAppleTouchDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function canUseWebPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function vapidApplicationServerKey(publicKey: string): ArrayBuffer {
  const raw = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(raw + "===".slice((raw.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function currentPushStatus(): Promise<PushStatus> {
  if (!canUseWebPush()) return "unavailable";
  if (isAppleTouchDevice() && !isStandalone()) return "needs-install";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  try {
    const cfg = await relayConfig();
    if (!cfg.vapidPublicKey) return "unconfigured";
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

export function pushStatusLabel(status: PushStatus): string {
  switch (status) {
    case "on": return "On";
    case "off": return "Off · tap to enable";
    case "blocked": return "Blocked in browser settings";
    case "needs-install": return "Add to Home Screen first";
    case "unavailable": return "Not available here";
    case "unconfigured": return "Relay is missing VAPID keys";
  }
}

export async function subscribeWebPush(): Promise<PushSubscription> {
  const cfg = await relayConfig();
  if (!cfg.vapidPublicKey) throw new Error("Push not configured");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Permission denied");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidApplicationServerKey(cfg.vapidPublicKey)
  });
}

export async function registerPushForRooms(identity: LocalIdentity, roomIds: string[], subscription?: PushSubscription): Promise<void> {
  const sub = subscription ?? await subscribeWebPush();
  await Promise.all(roomIds.map(id => registerPush(identity, id, sub)));
}
