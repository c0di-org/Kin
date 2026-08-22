/**
 * A minimal CDP driver: navigate, evaluate, screenshot. No puppeteer.
 *
 *   import { open } from "./drive.mjs";
 *   const page = await open(9411);
 *   await page.goto("http://localhost:1420/");
 *   await page.shot("/tmp/kin.png");
 */
export async function open(port, { width = 420, height = 900, mobile = true, dark = false } = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, no } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const at = ++id;
    pending.set(at, { ok, no });
    ws.send(JSON.stringify({ id: at, method, params }));
    setTimeout(() => pending.has(at) && (pending.delete(at), no(new Error(`${method} timed out`))), 30_000);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });

  const settle = ms => new Promise(r => setTimeout(r, ms));

  return {
    send, events,
    async goto(url, wait = 1800) {
      await send("Page.navigate", { url });
      await settle(wait);
    },
    async eval(expression, awaitPromise = true) {
      const res = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "eval threw");
      return res.result.value;
    },
    async shot(path, fullPage = false) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, Buffer.from(data, "base64"));
      return path;
    },
    async resize(w, h, isMobile = true) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: isMobile });
    },
    async dark(on) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: on ? "dark" : "light" }] });
    },
    settle,
    close: () => ws.close()
  };
}
