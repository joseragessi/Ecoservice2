// Service worker de la PWA del taller.
// Estrategia: el shell (la app) se cachea para que abra sin señal; las llamadas
// a la API SIEMPRE van a la red (nunca servimos datos viejos de reparaciones ni
// pedidos, que cambian todo el tiempo).
const CACHE = 'eco-ecoservice-v12';  // v12: ingresos al pañol
const SHELL = ['/app', '/app/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // La API nunca se cachea
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && url.origin === self.location.origin) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/app')))
  );
});
