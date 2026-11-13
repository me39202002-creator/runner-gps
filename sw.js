/**
 * @file sw.js
 * @description PWA Service Worker - 跑友即時地圖離線快取與加速
 */

const CACHE_NAME = 'runner-gps-v20261113_1';

const STATIC_PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/security.js',
  './js/services/firebase-service.js',
  './js/services/geolocation-service.js',
  './js/services/background-tracking-service.js',
  './js/components/map-renderer.js',
  './js/components/ui-controller.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg'
];

// 安裝階段：預先快取核心資源
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 正在預快取 PWA 靜態資源...');
      return cache.addAll(STATIC_PRECACHE).catch((err) => {
        console.warn('[SW] 部分靜態資源預快取略過:', err);
      });
    })
  );
});

// 啟動階段：清理舊版本快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              console.log('[SW] 清理舊快取:', key);
              return caches.delete(key);
            }
          })
        );
      })
    ])
  );
});

// 擷取階段：靜態資源 Stale-While-Revalidate，即時雲端 API Network-Only
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. 排除 WebSocket、Firebase、Google Maps API 等即時資料庫與地圖請求 (Network Only)
  if (
    request.method !== 'GET' ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('maps.gstatic.com') ||
    url.pathname.includes('/sockjs-node') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    url.searchParams.has('nocache')
  ) {
    return;
  }

  // 2. 靜態資源：網路優先 (Network First) 搭配本機快取備援，保證最新程式碼
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // 斷網或離線時，自動回退到快取
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      })
  );
});
