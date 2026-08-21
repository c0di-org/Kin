import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The worker's Durable Objects are exercised as plain classes against a fake storage,
      // which needs a stand-in for the runtime-only `cloudflare:workers` module.
      "cloudflare:workers": fileURLToPath(new URL("./worker/testing/cloudflare-workers.ts", import.meta.url))
    }
  }
});
