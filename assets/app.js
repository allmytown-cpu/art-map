/* ─────────────────────────────────────────────────────────────
   ART MAP · 프론트엔드
   data/events.json (GitHub Actions가 매일 생성) → 네이버 지도 + 가까운 순 목록
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── 설정 ───────────────────────────────────────────────────
  var CATEGORIES = [
    { id: 'exhibition',  label: '전시·미술', color: '#C2185B', emoji: '🎨' },
    { id: 'performance', label: '공연',      color: '#4472C4', emoji: '🎭' },
    { id: 'festival',    label: '축제·행사', color: '#F57C00', emoji: '🎪' },
    { id: 'education',   label: '교육·체험', color: '#2E9E5B', emoji: '🧑‍🏫' },
    { id: 'etc',         label: '기타',      color: '#757575', emoji: '📌' },
  ];
  var CAT = {};
  CATEGORIES.forEach(function (c) { CAT[c.id] = c; });

  var DEFAULT_CENTER = { lat: 37.5665, lng: 126.9780 }; // 서울시청
  var DEFAULT_ZOOM = 12;
  var PAGE_SIZE = 30;
  var CLUSTER_MAX_ZOOM = 13;

  // ── 상태 ───────────────────────────────────────────────────
  var state = {
    events: [],
    meta: null,
    filtered: [],
    active: {},               // 활성 카테고리 { id: true }
    query: '',
    me: null,                 // { lat, lng }
    boundsOnly: false,        // '이 지역만' 모드
    shown: PAGE_SIZE,
    selectedId: null,
  };
  CATEGORIES.forEach(function (c) { state.active[c.id] = true; });

  var map = null, clustering = null, meMarker = null, meCircle = null;
  var markers = {};           // id → naver.maps.Marker
  var listRenderTimer = null;

  // ── DOM ────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    boot: $('boot'), bootMessage: $('bootMessage'),
    chips: $('chips'), search: $('search'), clearSearch: $('btnClearSearch'),
    sheet: $('sheet'), sheetHandle: $('sheetHandle'), sheetTitle: $('sheetTitle'),
    list: $('list'), listEmpty: $('listEmpty'), more: $('btnMore'),
    locate: $('btnLocate'), refresh: $('btnRefresh'),
    detail: $('detail'), detailBody: $('detailBody'), detailClose: $('detailClose'),
    scrim: $('scrim'), toast: $('toast'), updatedAt: $('updatedAt'),
  };

  // ── 유틸 ───────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function haversine(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function fmtDist(m) {
    if (m == null) return '';
    if (m < 1000) return Math.round(m / 10) * 10 + 'm';
    if (m < 10000) return (m / 1000).toFixed(1) + 'km';
    return Math.round(m / 1000) + 'km';
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fmtPeriod(ev) {
    if (!ev.start) return '기간 미정';
    var s = ev.start.slice(5).replace('-', '.');
    if (!ev.end || ev.end === ev.start) return s;
    return s + ' ~ ' + ev.end.slice(5).replace('-', '.');
  }

  function statusOf(ev) {
    var t = todayStr();
    if (ev.start && ev.start > t) {
      var days = Math.ceil((new Date(ev.start) - new Date(t)) / 86400000);
      return { text: days <= 7 ? 'D-' + days : '예정', upcoming: true };
    }
    if (ev.end && ev.end >= t) {
      var left = Math.ceil((new Date(ev.end) - new Date(t)) / 86400000);
      return { text: left <= 7 ? '종료 D-' + left : '진행중', ongoing: true };
    }
    return { text: '', ended: true };
  }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }

  // ── 데이터 로드 ─────────────────────────────────────────────
  function load() {
    var bust = '?v=' + Math.floor(Date.now() / 600000); // 10분 캐시 버스팅
    return Promise.all([
      fetch('data/events.json' + bust).then(function (r) {
        if (!r.ok) throw new Error('events.json ' + r.status);
        return r.json();
      }),
      fetch('data/meta.json' + bust).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]);
  }

  // ── 마커 ───────────────────────────────────────────────────
  function pinIcon(ev, selected) {
    var c = CAT[ev.category] || CAT.etc;
    var size = selected ? 38 : 30;
    return {
      content:
        '<div class="pin' + (selected ? ' sel' : '') + '" style="background:' + c.color + '">' +
        '<span>' + c.emoji + '</span></div>',
      size: new naver.maps.Size(size, size),
      anchor: new naver.maps.Point(size / 2, size),
    };
  }

  function clusterIcon(count) {
    var size = count < 10 ? 38 : count < 100 ? 46 : count < 1000 ? 54 : 62;
    var label = count < 1000 ? count : Math.floor(count / 1000) + 'k';
    return {
      content: '<div class="cluster" style="width:' + size + 'px;height:' + size + 'px;font-size:' +
               (size / 3.4).toFixed(0) + 'px">' + label + '</div>',
      size: new naver.maps.Size(size, size),
      anchor: new naver.maps.Point(size / 2, size / 2),
    };
  }

  /** 좌표가 있는 이벤트에 대해 마커를 생성 (대량이므로 청크 단위로 나눠 처리) */
  function buildMarkers(events, done) {
    var withCoord = events.filter(function (e) { return e.lat !== null && e.lng !== null; });
    var i = 0, CHUNK = 400;

    function step() {
      var end = Math.min(i + CHUNK, withCoord.length);
      for (; i < end; i++) {
        (function (ev) {
          var m = new naver.maps.Marker({
            position: new naver.maps.LatLng(ev.lat, ev.lng),
            icon: pinIcon(ev, false),
            title: ev.title,
          });
          m._ev = ev;
          naver.maps.Event.addListener(m, 'click', function () { selectEvent(ev.id, false); });
          markers[ev.id] = m;
        })(withCoord[i]);
      }
      el.bootMessage.textContent = '지도 준비 중… ' + Math.round((i / withCoord.length) * 100) + '%';
      if (i < withCoord.length) requestAnimationFrame(step);
      else done(withCoord.length);
    }
    step();
  }

  function syncMarkers() {
    var visible = [];
    var shownIds = {};
    state.filtered.forEach(function (ev) { shownIds[ev.id] = true; });

    for (var id in markers) {
      if (shownIds[id]) visible.push(markers[id]);
    }

    if (!clustering) {
      clustering = new MarkerClustering({
        minClusterSize: 2,
        maxZoom: CLUSTER_MAX_ZOOM,
        map: map,
        markers: visible,
        disableClickZoom: false,
        gridSize: 110,
        icons: [clusterIcon(0)],
        indexGenerator: [10, 100, 500, 2000],
        stylingFunction: function (clusterMarker, count) {
          clusterMarker.setIcon(clusterIcon(count));
        },
      });
    } else {
      clustering.setMarkers(visible);
      if (typeof clustering._redraw === 'function') clustering._redraw();
    }
  }

  // ── 필터링 + 정렬 ───────────────────────────────────────────
  function applyFilters() {
    var q = state.query.trim().toLowerCase();
    var bounds = state.boundsOnly && map ? map.getBounds() : null;

    state.filtered = state.events.filter(function (ev) {
      if (!state.active[ev.category]) return false;
      if (q) {
        if (!ev._hay) {
          ev._hay = (ev.title + ' ' + ev.place + ' ' + ev.area + ' ' + ev.sigungu + ' ' +
                     ev.address + ' ' + ev.realm).toLowerCase();
        }
        if (ev._hay.indexOf(q) === -1) return false;
      }
      if (bounds) {
        if (ev.lat === null) return false;
        if (!bounds.hasLatLng(new naver.maps.LatLng(ev.lat, ev.lng))) return false;
      }
      return true;
    });

    // 거리 계산
    if (state.me) {
      state.filtered.forEach(function (ev) {
        ev._dist = (ev.lat === null) ? null : haversine(state.me, { lat: ev.lat, lng: ev.lng });
      });
      state.filtered.sort(function (a, b) {
        if (a._dist === null && b._dist === null) return (a.start || '').localeCompare(b.start || '');
        if (a._dist === null) return 1;
        if (b._dist === null) return -1;
        return a._dist - b._dist;
      });
    } else {
      // 위치를 모르면 '진행중 우선 → 시작일 순'
      var t = todayStr();
      state.filtered.forEach(function (ev) { ev._dist = null; });
      state.filtered.sort(function (a, b) {
        var ao = (a.start || '9999') <= t ? 0 : 1;
        var bo = (b.start || '9999') <= t ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return (a.start || '').localeCompare(b.start || '');
      });
    }

    state.shown = PAGE_SIZE;
    renderChipCounts();
    renderList();
    syncMarkers();
  }

  // 필터 변경이 잦을 수 있어 살짝 디바운스
  function scheduleFilters() {
    clearTimeout(listRenderTimer);
    listRenderTimer = setTimeout(applyFilters, 120);
  }

  // ── 렌더링: 칩 ──────────────────────────────────────────────
  function renderChips() {
    el.chips.innerHTML = '';
    CATEGORIES.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.cat = c.id;
      b.setAttribute('aria-pressed', String(!!state.active[c.id]));
      b.innerHTML = '<span class="dot" style="background:' + c.color + '"></span>' +
                    esc(c.label) + ' <span class="cnt" data-cnt="' + c.id + '"></span>';
      b.addEventListener('click', function () {
        var onCount = CATEGORIES.filter(function (x) { return state.active[x.id]; }).length;
        if (state.active[c.id] && onCount === 1) {
          // 마지막 하나를 끄려 하면 → 전체 켜기 (아무것도 없는 상태 방지)
          CATEGORIES.forEach(function (x) { state.active[x.id] = true; });
        } else {
          state.active[c.id] = !state.active[c.id];
        }
        syncChipStyles();
        scheduleFilters();
      });
      el.chips.appendChild(b);
    });
    syncChipStyles();
  }

  function syncChipStyles() {
    Array.prototype.forEach.call(el.chips.children, function (b) {
      var c = CAT[b.dataset.cat];
      var on = !!state.active[b.dataset.cat];
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? c.color : '';
    });
  }

  function renderChipCounts() {
    var counts = {};
    state.filtered.forEach(function (ev) { counts[ev.category] = (counts[ev.category] || 0) + 1; });
    CATEGORIES.forEach(function (c) {
      var span = el.chips.querySelector('[data-cnt="' + c.id + '"]');
      if (span) span.textContent = state.active[c.id] ? (counts[c.id] || 0) : '';
    });
  }

  // ── 렌더링: 목록 ────────────────────────────────────────────
  function renderList() {
    var total = state.filtered.length;
    var slice = state.filtered.slice(0, state.shown);

    el.sheetTitle.innerHTML = state.me
      ? '내 주변 <em>' + total.toLocaleString() + '</em>건 · 가까운 순'
      : '전체 <em>' + total.toLocaleString() + '</em>건 · 날짜순';

    var frag = document.createDocumentFragment();
    slice.forEach(function (ev) {
      var c = CAT[ev.category] || CAT.etc;
      var st = statusOf(ev);
      var li = document.createElement('li');
      li.className = 'item' + (ev.lat === null ? ' no-coord' : '');
      li.dataset.id = ev.id;

      var thumb = ev.thumbnail
        ? '<img class="item-thumb" src="' + esc(ev.thumbnail) + '" alt="" loading="lazy" ' +
          'onerror="this.outerHTML=\'<div class=&quot;item-thumb ph&quot;>' + c.emoji + '</div>\'" />'
        : '<div class="item-thumb ph">' + c.emoji + '</div>';

      var metaBits = [fmtPeriod(ev)];
      if (ev.place) metaBits.push(ev.place);
      var region = [ev.area, ev.sigungu].filter(Boolean).join(' ');
      if (region && metaBits.indexOf(region) === -1) metaBits.push(region);

      li.innerHTML =
        thumb +
        '<div class="item-main">' +
          '<div class="item-top">' +
            '<span class="badge" style="background:' + c.color + '">' + esc(c.label) + '</span>' +
            (st.text ? '<span class="item-meta">' + esc(st.text) + '</span>' : '') +
            (ev._dist != null ? '<span class="item-dist" style="margin-left:auto">' + fmtDist(ev._dist) + '</span>' : '') +
          '</div>' +
          '<p class="item-title">' + esc(ev.title) + '</p>' +
          '<div class="item-meta">' + esc(metaBits.join(' · ')) + (ev.lat === null ? ' · 위치정보 없음' : '') + '</div>' +
        '</div>';

      li.addEventListener('click', function () { selectEvent(ev.id, true); });
      frag.appendChild(li);
    });

    el.list.innerHTML = '';
    el.list.appendChild(frag);
    el.listEmpty.hidden = total > 0;
    el.more.hidden = total <= state.shown;
    el.more.textContent = '더 보기 (' + (total - state.shown).toLocaleString() + '건 남음)';
  }

  // ── 선택 / 상세 ─────────────────────────────────────────────
  function selectEvent(id, moveMap) {
    var ev = null;
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) { ev = state.events[i]; break; }
    }
    if (!ev) return;

    if (state.selectedId && markers[state.selectedId]) {
      markers[state.selectedId].setIcon(pinIcon(markers[state.selectedId]._ev, false));
    }
    state.selectedId = id;
    if (markers[id]) {
      markers[id].setIcon(pinIcon(ev, true));
      markers[id].setZIndex(999);
    }

    if (moveMap && ev.lat !== null) {
      map.morph(new naver.maps.LatLng(ev.lat, ev.lng), Math.max(map.getZoom(), 15));
    }
    openDetail(ev);
  }

  function openDetail(ev) {
    var c = CAT[ev.category] || CAT.etc;
    var st = statusOf(ev);
    var rows = '';
    function row(k, v) { if (v) rows += '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

    row('기간', esc(ev.start ? (ev.start.replace(/-/g, '.') + (ev.end && ev.end !== ev.start ? ' ~ ' + ev.end.replace(/-/g, '.') : '')) : '미정') +
                (st.text ? ' <span class="badge" style="background:' + c.color + '">' + esc(st.text) + '</span>' : ''));
    row('장소', esc(ev.place));
    row('주소', esc(ev.address || [ev.area, ev.sigungu].filter(Boolean).join(' ')));
    row('분야', esc(ev.realm || c.label));
    row('요금', esc(ev.price));
    // 전화번호 필드에 "국립춘천박물관 033-260-1500"처럼 기관명이 섞여 오므로 번호만 뽑아 링크한다.
    var telDigits = (String(ev.phone).match(/[\d]{2,4}-[\d]{3,4}-[\d]{4}|\d{9,11}/) || [])[0];
    row('문의', ev.phone
      ? (telDigits ? '<a href="tel:' + esc(telDigits) + '">' + esc(ev.phone) + '</a>' : esc(ev.phone))
      : '');
    if (ev._dist != null) row('거리', '내 위치에서 <b>' + fmtDist(ev._dist) + '</b>');

    var naverUrl = ev.lat !== null
      ? 'https://map.naver.com/p/search/' + encodeURIComponent(ev.place || ev.title) +
        '?c=' + ev.lng + ',' + ev.lat + ',16,0,0,0,dh'
      : 'https://map.naver.com/p/search/' + encodeURIComponent((ev.place || '') + ' ' + ev.title);

    var geoNote = '';
    if (ev.geo === 'geocode') geoNote = '※ 원본에 좌표가 없어 주소로 추정한 위치입니다.';
    else if (ev.geo === 'sibling') geoNote = '※ 같은 장소의 다른 행사 좌표를 사용한 위치입니다.';
    else if (ev.lat === null) geoNote = '※ 원본에 위치정보가 없어 지도에 표시되지 않습니다.';

    el.detailBody.innerHTML =
      (ev.thumbnail ? '<img class="d-hero" src="' + esc(ev.thumbnail) + '" alt="" onerror="this.remove()" />' : '') +
      '<div class="d-pad">' +
        '<h2 class="d-title">' + esc(ev.title) + '</h2>' +
        '<dl class="d-rows">' + rows + '</dl>' +
        (ev.desc ? '<div class="d-desc">' + esc(ev.desc) + '</div>' : '') +
        '<div class="d-actions">' +
          (ev.lat !== null ? '<a class="d-btn primary" href="' + esc(naverUrl) + '" target="_blank" rel="noopener">길찾기</a>' : '') +
          (ev.url ? '<a class="d-btn' + (ev.lat === null ? ' primary' : '') + '" href="' + esc(ev.url) + '" target="_blank" rel="noopener">상세정보</a>' : '') +
        '</div>' +
        (geoNote ? '<p class="credit" style="margin-top:14px">' + geoNote + '</p>' : '') +
      '</div>';

    el.detail.hidden = false;
    el.scrim.hidden = false;
  }

  function closeDetail() {
    el.detail.hidden = true;
    el.scrim.hidden = true;
    if (state.selectedId && markers[state.selectedId]) {
      markers[state.selectedId].setIcon(pinIcon(markers[state.selectedId]._ev, false));
    }
    state.selectedId = null;
  }

  // ── 내 위치 ─────────────────────────────────────────────────
  function locate(silent) {
    if (!navigator.geolocation) { if (!silent) toast('이 브라우저는 위치 기능을 지원하지 않습니다.'); return; }
    if (!silent) toast('위치를 확인하는 중…');
    el.locate.classList.add('on');

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        var ll = new naver.maps.LatLng(state.me.lat, state.me.lng);

        if (!meMarker) {
          meMarker = new naver.maps.Marker({
            position: ll, map: map, zIndex: 1000,
            icon: { content: '<div class="me"></div>', size: new naver.maps.Size(18, 18), anchor: new naver.maps.Point(9, 9) },
          });
        } else {
          meMarker.setPosition(ll);
        }

        map.morph(ll, 14);
        el.locate.classList.remove('on');
        applyFilters();
        openSheet(true);
        if (!silent) toast('내 위치 기준 가까운 순으로 정렬했습니다.');
      },
      function (err) {
        el.locate.classList.remove('on');
        if (silent) return;
        toast(err.code === 1
          ? '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.'
          : '위치를 가져오지 못했습니다.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // ── 시트 ────────────────────────────────────────────────────
  function openSheet(open) {
    el.sheet.classList.toggle('open', open);
    el.sheetHandle.setAttribute('aria-expanded', String(open));
  }

  // ── 초기화 ──────────────────────────────────────────────────
  function initMap() {
    map = new naver.maps.Map('map', {
      center: new naver.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
      zoom: DEFAULT_ZOOM,
      mapDataControl: false,
      logoControl: true,
      logoControlOptions: { position: naver.maps.Position.BOTTOM_LEFT },
      scaleControl: false,
      zoomControl: false,
      tileTransition: true,
    });

    // '이 지역만' 모드일 때 지도 이동 후 자동 재검색
    naver.maps.Event.addListener(map, 'idle', function () {
      if (state.boundsOnly) scheduleFilters();
    });
  }

  function bindUI() {
    el.sheetHandle.addEventListener('click', function () {
      openSheet(!el.sheet.classList.contains('open'));
    });

    el.more.addEventListener('click', function () {
      state.shown += PAGE_SIZE;
      renderList();
    });

    var searchTimer = null;
    el.search.addEventListener('input', function () {
      state.query = el.search.value;
      el.clearSearch.hidden = !state.query;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 220);
    });
    el.clearSearch.addEventListener('click', function () {
      el.search.value = ''; state.query = ''; el.clearSearch.hidden = true; applyFilters();
    });

    el.locate.addEventListener('click', function () { locate(false); });

    el.refresh.addEventListener('click', function () {
      state.boundsOnly = !state.boundsOnly;
      el.refresh.classList.toggle('on', state.boundsOnly);
      el.refresh.textContent = state.boundsOnly ? '🌏' : '🔄';
      toast(state.boundsOnly ? '현재 지도 화면 안의 행사만 표시합니다.' : '전체 행사를 표시합니다.');
      applyFilters();
      openSheet(true);
    });

    el.detailClose.addEventListener('click', closeDetail);
    el.scrim.addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.detail.hidden) closeDetail();
    });
  }

  function start() {
    if (typeof naver === 'undefined' || !naver.maps) {
      el.bootMessage.innerHTML = '<strong>네이버 지도 스크립트를 불러오지 못했습니다.</strong><br />네트워크 연결을 확인해 주세요.';
      return;
    }
    initMap();
    bindUI();
    renderChips();

    load().then(function (res) {
      state.events = res[0] || [];
      state.meta = res[1];

      if (state.meta && state.meta.updatedAt) {
        var d = new Date(state.meta.updatedAt);
        el.updatedAt.textContent = ' · ' + d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate() + ' 갱신';
      }

      if (state.events.length === 0) {
        el.bootMessage.innerHTML =
          '<strong>표시할 데이터가 없습니다.</strong><br />' +
          'GitHub Actions에서 <code>데이터 갱신</code> 워크플로를 먼저 실행해 주세요.';
        return;
      }

      el.bootMessage.textContent = '지도 준비 중…';
      buildMarkers(state.events, function (n) {
        applyFilters();
        el.boot.classList.add('hide');
        setTimeout(function () { el.boot.style.display = 'none'; }, 320);
        openSheet(false);
        // 위치 권한이 이미 허용된 상태면 조용히 내 위치를 가져온다.
        if (navigator.permissions && navigator.permissions.query) {
          navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
            if (p.state === 'granted') locate(true);
          }).catch(function () {});
        }
      });
    }).catch(function (e) {
      el.bootMessage.innerHTML =
        '<strong>데이터를 불러오지 못했습니다.</strong><br />' + esc(e.message) +
        '<br /><span style="opacity:.7;font-size:12px">로컬에서 테스트 중이라면 <code>npm run serve</code>로 실행하세요.</span>';
    });
  }

  // PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
