// Kill switch. Replaces the old stale-while-revalidate SW so it self-destructs on every
// client that still has it installed, instead of leaving them stuck on stale caches forever.
//
// Why this works even though clients are stuck on an old cached index.html: that old page's
// own registration script still calls navigator.serviceWorker.register("service-worker.js"),
// and the browser byte-diffs this file against the installed one on every such call/navigation
// regardless of HTTP caching. A diff triggers install -> activate here, which wipes the cache
// and unregisters, so every remaining client self-heals without needing this file's content
// (or index.html) to be understood by them ahead of time.
//
// Do NOT delete this file outright once clients are clean: with no SW to intercept
// "serviceWorker.register", a *removed* file would 404 for stragglers and leave their old SW
// (and its stale cache) running forever. Leave this here as the permanent tombstone.

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => caches.delete(key)));
            await self.registration.unregister();

            const clientsList = await self.clients.matchAll({ type: 'window' });
            clientsList.forEach(client => client.navigate(client.url));
        })()
    );
});
