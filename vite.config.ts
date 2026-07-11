import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Short build id stamped into the bundle so the running build is identifiable
// on-device (see the conversation-mode debug line). Node build-time only.
const BUILD_ID = Date.now().toString(36);

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    VitePWA({
      // TEMPORARY during conversation-mode debugging: a self-destroying service
      // worker unregisters any previously-installed SW and clears its caches,
      // so iOS Safari stops serving stale app shells (which produced repeated
      // stale-chunk 404s and made it impossible to tell which build was live).
      // Re-enable real precaching once conversation mode is verified on device.
      selfDestroying: true,
      registerType: "autoUpdate",
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: "Delphi Chat",
        short_name: "Delphi",
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
