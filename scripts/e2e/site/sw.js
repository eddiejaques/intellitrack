// A service worker that sends GA4 hits, like a SPA with analytics in a worker. The hit names the page it is about (dl).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const dl = encodeURIComponent(e.data.dl);
  e.waitUntil(fetch(`https://www.google-analytics.com/g/collect?v=2&tid=G-SWTEST01&cid=5.6&dl=${dl}&en=${e.data.en}&gcs=G100`, { method: "POST", body: "" }).catch(() => {}));
});
