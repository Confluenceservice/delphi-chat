import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// A lazily-imported chunk (e.g. the VAD bundle) can 404 when a new deploy has
// replaced its hashed filename but the browser is still running an old,
// service-worker-cached app shell. Recover by refreshing the service worker
// and reloading once (sessionStorage guards against a reload loop).
window.addEventListener("vite:preloadError", async () => {
  if (sessionStorage.getItem("chunk-reload")) return;
  sessionStorage.setItem("chunk-reload", "1");
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
  }
  window.location.reload();
});

// Clear the guard once a load succeeds so future stale deploys can self-heal too.
window.addEventListener("load", () => sessionStorage.removeItem("chunk-reload"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
