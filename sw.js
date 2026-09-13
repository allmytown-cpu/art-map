/* ART MAP · 서비스 워커
 * ─────────────────────────────────────────────────────────────
 *  이전 버전에서 CSS/JS를 캐시 우선으로 서빙하는 바람에 코드를 고쳐도
 *  사용자 화면에 반영되지 않는 사고가 있었다. 재발을 막기 위한 규칙:
 *
 *   1. HTML은 항상 네트워크 우선. (오프라인일 때만 캐시)
 *      → 새 index.html이 즉시 반영되고, 그 안의 ?v= 값이 바뀌면
 *        CSS/JS도 자동으로 새 URL이 되어 캐시를 우회한다.
 *   2. CSS/JS는 index.html에서 ?v=N 을 붙여 참조한다.
 *      URL 자체가 버전이므로 캐시 우선이어도 안전하다.
 *   3. 데이터(data/*.json)는 네트워크 우선.
 *   4. ?nosw=1 로 접속하면 워커와 캐시를 전부 삭제한다. (비상 탈출구)
 * ───────────────────────────────────────────────────────────── */

var VERSION = 'art-map-v3';

// 정적 자원은 런타임에 캐시한다. 여기엔 버전이 바뀌지 않는 것만 넣는다.
var PRECACHE = ['./', './index.html', './manifest.webmanifest', './assets/icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) {
        // 하나라도 실패하면 설치 전체가 실패하므로 개별적으로 처리한다.
        return Promise.all(PRECACHE.map(function (u) {
          return c.add(u).catch(function () { /* 무시 */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/** 응답을 캐시에 복사 (실패해도 무시) */
function put(req, res) {
  if (!res || !res.ok || res.type === 'opaque') return res;
  var clone = res.clone();
  caches.open(VERSION).then(function (c) { c.put(req, clone); }).catch(function () {});
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 외부 리소스(네이버 지도 타일, 문화포털 썸네일 등)는 건드리지 않는다.
  if (url.origin !== self.location.origin) return;

  var isHTML = req.mode === 'navigate' ||
               (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  var isData = url.pathname.indexOf('/data/') !== -1;

  // HTML · 데이터 → 네트워크 우선
  if (isHTML || isData) {
    e.respondWith(
      fetch(req)
        .then(function (res) { return put(req, res); })
        .catch(function () {
          return caches.match(req).then(function (r) {
            return r || (isHTML ? caches.match('./index.html') : undefined);
          });
        })
    );
    return;
  }

  // 그 외 정적 자원 → 캐시 우선 (URL에 ?v= 가 붙어 있어 안전)
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) { return put(req, res); });
    })
  );
});
