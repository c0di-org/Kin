/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST as never);

self.addEventListener("push", event => {
  let data: { title?: string; body?: string; conversationId?: string } = {};
  try { data = event.data?.json() ?? {}; } catch { /* generic notification */ }
  event.waitUntil(self.registration.showNotification(data.title ?? "Kin", {
    body: data.body ?? "New message",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.conversationId ? `kin:${data.conversationId}` : "kin",
    data: { conversationId: data.conversationId },
    silent: false
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.conversationId as string | undefined;
  const target = id ? `/?conversation=${encodeURIComponent(id)}` : "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients[0] as WindowClient | undefined;
    if (existing) { await existing.focus(); existing.navigate(target); return; }
    await self.clients.openWindow(target);
  })());
});
