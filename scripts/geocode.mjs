#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 2단계: 좌표 없는 행사 보정 → data/events.json 갱신
//
//  period2가 내려주는 gpsX/gpsY는 비어 있는 레코드가 꽤 많다.
//  주소(placeAddr) 또는 장소명(place)으로 좌표를 찾아 채워 넣는다.
//
//  지오코더 우선순위
//    1) 네이버 클라우드 플랫폼 Geocoding  (NCP_APIGW_KEY_ID / NCP_APIGW_KEY 필요)
//    2) OpenStreetMap Nominatim           (키 불필요, 초당 1회 제한)
//
//  한 번 찾은 좌표는 data/geocode-cache.json에 저장해 재사용한다.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import { isValidKoreaCoord, PATHS } from './config.mjs';

const NCP_ID = process.env.NCP_APIGW_KEY_ID || '';
const NCP_KEY = process.env.NCP_APIGW_KEY || '';
const USE_NCP = Boolean(NCP_ID && NCP_KEY);

// Nominatim은 공용 서비스라 과도하게 쓰면 차단된다. 1회 실행당 상한을 둔다.
const NOMINATIM_LIMIT = Number(process.env.NOMINATIM_LIMIT || 250);
const NOMINATIM_DELAY_MS = 1100;
const NCP_DELAY_MS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round6 = (n) => Math.round(n * 1e6) / 1e6;

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

/** 지오코딩 질의어 후보를 좋은 순서대로 생성 */
function buildQueries(ev) {
  const out = [];
  const addr = (ev.address || '').trim();
  const place = (ev.place || '').trim();
  const area = (ev.area || '').trim();

  if (addr) {
    out.push(addr);
    // "서울 종로구 ... 1층 101호" 같은 상세주소는 잘라내면 성공률이 올라간다.
    const trimmed = addr.replace(/\s*(\d+층|지하\s*\d+층|[\w\d-]+호|B\d+)\s*$/i, '').trim();
    if (trimmed && trimmed !== addr) out.push(trimmed);
  }
  if (place) {
    out.push(area && !place.includes(area) ? `${area} ${place}` : place);
  }
  return [...new Set(out.filter((q) => q.length >= 2))];
}

async function geocodeNcp(query) {
  const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': NCP_ID,
      'X-NCP-APIGW-API-KEY': NCP_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`NCP 인증 실패(${res.status}) — Geocoding 서비스가 활성화된 키인지 확인하세요.`);
    }
    return null;
  }
  const json = await res.json();
  const a = json?.addresses?.[0];
  if (!a) return null;
  const lat = parseFloat(a.y), lng = parseFloat(a.x);
  return isValidKoreaCoord(lat, lng) ? { lat, lng } : null;
}

async function geocodeNominatim(query) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'art-map/1.0 (https://github.com/allmytown-cpu/art-map)',
      'Accept-Language': 'ko',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const a = json?.[0];
  if (!a) return null;
  const lat = parseFloat(a.lat), lng = parseFloat(a.lon);
  return isValidKoreaCoord(lat, lng) ? { lat, lng } : null;
}

async function main() {
  const events = await readJson(PATHS.events, null);
  if (!Array.isArray(events)) {
    console.error(`[오류] ${PATHS.events} 를 먼저 생성하세요 (npm run fetch).`);
    process.exit(1);
  }
  const cache = await readJson(PATHS.geocodeCache, {});

  const targets = events.filter((e) => e.lat === null || e.lng === null);
  console.log('━'.repeat(60));
  console.log('ART MAP · 좌표 보정(지오코딩)');
  console.log(`지오코더: ${USE_NCP ? '네이버 클라우드 Geocoding' : 'OpenStreetMap Nominatim'}`);
  console.log(`대상: ${targets.length}건 / 전체 ${events.length}건, 캐시 ${Object.keys(cache).length}건`);
  console.log('━'.repeat(60));

  let fromCache = 0, resolved = 0, failed = 0, apiCalls = 0;
  let quotaLeft = USE_NCP ? Infinity : NOMINATIM_LIMIT;

  for (const ev of targets) {
    const queries = buildQueries(ev);
    if (queries.length === 0) { failed++; continue; }

    let hit = null;
    let cacheHit = false;

    for (const q of queries) {
      if (Object.prototype.hasOwnProperty.call(cache, q)) {
        if (cache[q]) { hit = cache[q]; cacheHit = true; }
        continue; // null 캐시 = 이전에 실패한 질의, 다음 후보로
      }
      if (quotaLeft <= 0) break;

      try {
        const found = USE_NCP ? await geocodeNcp(q) : await geocodeNominatim(q);
        apiCalls++; quotaLeft--;
        await sleep(USE_NCP ? NCP_DELAY_MS : NOMINATIM_DELAY_MS);
        cache[q] = found ? { lat: round6(found.lat), lng: round6(found.lng) } : null;
        if (found) { hit = cache[q]; break; }
      } catch (e) {
        console.error(`\n  [지오코딩 중단] ${e.message}`);
        quotaLeft = 0;
        break;
      }
    }

    if (hit) {
      ev.lat = hit.lat;
      ev.lng = hit.lng;
      ev.geo = 'geocode';
      if (cacheHit) fromCache++; else resolved++;
    } else {
      failed++;
    }

    const done = fromCache + resolved + failed;
    if (done % 25 === 0) {
      process.stdout.write(`\r  진행 ${done}/${targets.length}  (신규 ${resolved} · 캐시 ${fromCache} · 실패 ${failed})   `);
    }
  }
  process.stdout.write('\n');

  await fs.writeFile(PATHS.geocodeCache, JSON.stringify(cache, null, 0), 'utf8');
  await fs.writeFile(PATHS.events, JSON.stringify(events), 'utf8');

  const withCoord = events.filter((e) => e.lat !== null).length;
  console.log(`\nAPI 호출 ${apiCalls}회 · 캐시 적중 ${fromCache}건 · 신규 ${resolved}건 · 실패 ${failed}건`);
  console.log(`좌표 보유: ${withCoord}/${events.length} (${((withCoord / events.length) * 100).toFixed(1)}%)`);
  if (!USE_NCP && quotaLeft <= 0) {
    console.log('\n※ Nominatim 호출 상한에 도달했습니다. 다음 실행 때 이어서 처리됩니다.');
    console.log('  빠르게 끝내려면 NCP_APIGW_KEY_ID / NCP_APIGW_KEY 를 설정하세요.');
  }

  // meta.json 갱신
  const meta = await readJson(PATHS.meta, {});
  meta.withCoord = withCoord;
  meta.geocodedAt = new Date().toISOString();
  await fs.writeFile(PATHS.meta, JSON.stringify(meta, null, 2), 'utf8');
  console.log('\n✔ 완료');
}

main().catch((e) => { console.error('\n[실패]', e); process.exit(1); });
