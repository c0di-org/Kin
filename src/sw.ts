/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

self.skipWaiting();
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST as never);

type PushData = { title?: string; body?: string; conversationId?: string };

self.addEventListener("push", event => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event: PushEvent): Promise<void> {
  let data: PushData = {};
  try { data = event.data?.json() ?? {}; } catch { /* generic notification */ }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: "kin-push", conversationId: data.conversationId });
  const focused = windows.some(client => client.focused);
  const isIOS = /iPad|iPhone|iPod/.test(self.navigator.userAgent);
  if (focused && !isIOS) return;
  await self.registration.showNotification(data.title ?? "Kin", {
    body: data.body ?? "New message",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.conversationId ? `kin:${data.conversationId}` : "kin",
    data: { conversationId: data.conversationId },
    silent: false
  });
  try {
    const badge = Reflect.get(self.navigator, "setAppBadge");
    if (typeof badge === "function") await badge.call(self.navigator, 1);
  } catch { /* Badge API is optional */ }
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.conversationId as string | undefined;
  const target = id ? `/?conversation=${encodeURIComponent(id)}` : "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients[0] as WindowClient | undefined;
    if (existing) {
      existing.postMessage({ type: "kin-open", conversationId: id });
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
