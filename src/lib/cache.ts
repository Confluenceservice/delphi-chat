export async function clearCacheAndReload() {
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  window.location.reload();
}
