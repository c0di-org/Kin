import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: null,
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/app-icon.svg"],
      manifest: {
        id: "/",
        lang: "en",
        name: "Kin",
        short_name: "Kin",
        description: "Private family messaging",
        start_url: "/",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        // Android paints its PWA splash from these and a manifest cannot media-query, so one theme
        // has to win. Dark: a light splash dropping into the dark app is the harsh direction, and
        // the candy icon reads better on deep indigo than on pale blue. The live status bar is
        // still theme-aware — index.html carries media-scoped <meta name="theme-color">.
        background_color: "#0d1026",
        theme_color: "#0d1026",
        orientation: "portrait-primary",
        categories: ["social", "communication"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ],
        shortcuts: [
          { name: "New doodle", short_name: "Doodle", description: "Draw something for your family", url: "/?compose=doodle", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] }
        ],
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [{ name: "media", accept: ["image/*", "video/*", "audio/*"] }]
          }
        }
      }
    })
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true }
    }
  }
});
