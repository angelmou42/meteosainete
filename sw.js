/* Meteosainete — service worker
 *
 * Permite instalar la web como app y abrirla sin conexión:
 *  - La página y sus archivos se guardan en caché al instalar.
 *  - index.html: primero la red (para ver siempre la última versión) y, si no
 *    hay conexión, la copia guardada.
 *  - CSS, JS e iconos: primero la caché. Llevan ?v= en la URL, así que una
 *    versión nueva es otra URL y nunca se sirve un archivo viejo por error.
 *  - Las APIs (Open-Meteo, Windy, mapas) no pasan por aquí: sin conexión, la
 *    app muestra la última predicción guardada con un aviso (ver app.js).
 * Al cambiar algo importante hay que subir CACHE para que se renueve la caché.
 */
const CACHE = "meteosainete-v24";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./img/icon.svg",
  "./img/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Borra las cachés de versiones anteriores.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // APIs y CDN: directo a la red
  // En local (desarrollo) no se usa la caché: así cada cambio se ve al recargar.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;

  // Datos propios (resultados del análisis): red primero, para no quedarse con resultados viejos.
  if (url.pathname.endsWith(".json")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Navegación (la página): red primero, caché si no hay conexión.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // Archivos estáticos: caché primero; lo que no esté, se pide y se guarda.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })),
  );
});
