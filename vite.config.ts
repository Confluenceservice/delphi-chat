import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // API calls (chat/tts/stt) and the CDN-hosted VAD/ONNX assets must
      // never be served from a stale cache — leave them to the network.
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: "MiniMax Chat",
        short_name: "MiniMax",
        description: "Mobile-friendly chat app powered by the MiniMax model family",
        theme_color: "#aa3bff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
