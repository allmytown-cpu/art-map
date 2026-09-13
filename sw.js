/* ART MAP · 서비스 워커
   - 앱 셸(HTML/CSS/JS/아이콘): 캐시 우선 + 백그라운드 갱신
   - 데이터(events.json): 네트워크 우선, 실패 시 캐시 (오프라인에서도 마지막 데이터 표시)
   - 지도 타일/외부 CDN: 캐시하지 않음 (브라우저 기본 캐시에 맡김)          */

var VERSION = 'art-map-v1';
var SHELL = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './assets/icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 네이버 지도 등 외부 리소스는 통과

  // 데이터: 네트워크 우선
  if (url.pathname.indexOf('/data/') !== -1) {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var clone = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, clone); });
          return res;
        })
        .catch(function () { return caches.match(req); })
    );
    return;
  }

  // 앱 셸: 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req)
        .then(function (res) {
          var clone = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, clone); });
          return res;
        })
        .catch(function () { return cached; });
      return cached || network;
    })
  );
});
