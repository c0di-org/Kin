/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

self.skipWaiting();
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST as never);

// Web Share Target: stash shared files/text in a cache, then open the app to pick a chat.
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData();
        const cache = await caches.open("kin-share");
        const files = form.getAll("media").filter((f): f is File => f instanceof File);
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          await cache.put(`/kin-share/file-${i}?name=${encodeURIComponent(f.name || `shared-${i}`)}`,
            new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }));
        }
        const text = [form.get("title"), form.get("text"), form.get("url")].filter(v => typeof v === "string" && v).join(" ");
        if (text) await cache.put("/kin-share/text", new Response(text));
      } catch { /* open the app anyway */ }
      return Response.redirect("/?shared=1", 303);
    })());
  }
});

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
    body: data.body ?? "New message from your family 💌",
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
