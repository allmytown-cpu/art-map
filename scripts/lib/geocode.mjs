// ─────────────────────────────────────────────────────────────
//  장소/주소 → 좌표
//
//  해결 순서
//   1. 내부 가젯티어 : 이미 수집된 행사들의 (장소·주소 → 좌표) 색인
//                      API 호출이 없어 공짜이고 가장 정확하다
//   2. 네이버 Geocoding : NCP 키가 있을 때. 국내 주소 정확도가 가장 높다
//   3. Nominatim        : 키 없이 쓰는 최후 수단. 국내 지번주소 정확도 낮음
//
//  결과는 data/geocode-cache.json 에 질의어 단위로 캐시된다.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import dns from 'node:dns';
import { isValidKoreaCoord, PATHS } from '../config.mjs';

dns.setDefaultResultOrder('ipv4first');

const NCP_ID = process.env.NCP_APIGW_KEY_ID || '';
const NCP_KEY = process.env.NCP_APIGW_KEY || '';
export const HAS_NCP = Boolean(NCP_ID && NCP_KEY);

const NOMINATIM_DELAY_MS = 1100;
const NCP_DELAY_MS = 60;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cache = null;
let lastCallAt = 0;

export async function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(PATHS.geocodeCache, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

export async function saveCache() {
  if (cache) await fs.writeFile(PATHS.geocodeCache, JSON.stringify(cache), 'utf8');
}

// ── 내부 가젯티어 ────────────────────────────────────────────
let gazetteer = null;

/** 좌표를 가진 행사들로부터 (장소명/주소 → 좌표) 색인을 만든다. */
export function buildGazetteer(events) {
  gazetteer = { byPlace: new Map(), byAddr: new Map() };
  for (const e of events) {
    if (e.lat === null || e.lat === undefined) continue;
    const c = [e.lat, e.lng];
    if (e.place) {
      const k = normPlace(e.place);
      if (k && !gazetteer.byPlace.has(k)) gazetteer.byPlace.set(k, c);
    }
    if (e.address) {
      const k = normAddr(e.address);
      if (k && !gazetteer.byAddr.has(k)) gazetteer.byAddr.set(k, c);
    }
  }
  return gazetteer;
}

/** "국립현대미술관 서울관 제1전시실" → "국립현대미술관서울관" 처럼 비교용으로 정규화 */
function normPlace(s) {
  return String(s || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s*(제?\s*\d+\s*전시실|[1-9]\d*층|B\d+|전시실|대극장|소극장|본관|별관)\s*$/g, '')
    .replace(/[\s·・,/]+/g, '')
    .trim();
}

function normAddr(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function fromGazetteer(place, address) {
  if (!gazetteer) return null;
  if (address) {
    const hit = gazetteer.byAddr.get(normAddr(address));
    if (hit) return { lat: hit[0], lng: hit[1], via: 'gazetteer' };
  }
  if (place) {
    const k = normPlace(place);
    const hit = gazetteer.byPlace.get(k);
    if (hit) return { lat: hit[0], lng: hit[1], via: 'gazetteer' };
    // 부분 일치 (짧은 이름이 긴 이름에 포함되는 경우)
    if (k.length >= 4) {
      for (const [key, c] of gazetteer.byPlace) {
        if (key.includes(k) || k.includes(key)) return { lat: c[0], lng: c[1], via: 'gazetteer~' };
      }
    }
  }
  return null;
}

// ── 외부 지오코더 ────────────────────────────────────────────
async function throttle(ms) {
  const wait = lastCallAt + ms - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function geocodeNcp(query) {
  await throttle(NCP_DELAY_MS);
  const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': NCP_ID,
      'X-NCP-APIGW-API-KEY': NCP_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`NCP Geocoding 인증 실패 (${res.status}). 키와 서비스 활성화를 확인하세요.`);
  }
  if (!res.ok) return null;
  const a = (await res.json())?.addresses?.[0];
  if (!a) return null;
  const lat = parseFloat(a.y), lng = parseFloat(a.x);
  return isValidKoreaCoord(lat, lng) ? { lat, lng } : null;
}

async function geocodeNominatim(query) {
  await throttle(NOMINATIM_DELAY_MS);
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'art-map/1.0 (https://github.com/allmytown-cpu/art-map)',
      'Accept-Language': 'ko',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const a = (await res.json())?.[0];
  if (!a) return null;
  const lat = parseFloat(a.lat), lng = parseFloat(a.lon);
  return isValidKoreaCoord(lat, lng) ? { lat, lng } : null;
}

/** 질의어 후보를 정확도 높은 순으로 생성 */
export function buildQueries({ address, place, area, sigungu }) {
  const out = [];
  const addr = (address || '').trim();
  if (addr) {
    out.push(addr);
    const noUnit = addr.replace(/\s*(지하\s*)?\d+층\s*$|\s*[\w\d-]+호\s*$/gi, '').trim();
    if (noUnit && noUnit !== addr) out.push(noUnit);
    const road = addr.match(/^(.*?(?:로|길)\s*\d+(?:-\d+)?)/);
    if (road && road[1] !== addr) out.push(road[1].trim());
  }
  const p = (place || '').trim();
  if (p) {
    const region = [area, sigungu].filter(Boolean).join(' ');
    if (region && !p.includes(sigungu || '\u0000')) out.push(`${region} ${p}`);
    out.push(p);
  }
  return [...new Set(out.filter((q) => q.length >= 3))];
}

/**
 * 좌표를 찾는다. 실패하면 null.
 * @returns {{lat:number,lng:number,via:string}|null}
 */
export async function resolveCoords(info, { allowRemote = true, budget = { left: Infinity } } = {}) {
  const hit = fromGazetteer(info.place, info.address);
  if (hit) return hit;
  if (!allowRemote) return null;

  await loadCache();
  for (const q of buildQueries(info)) {
    if (Object.prototype.hasOwnProperty.call(cache, q)) {
      if (cache[q]) return { ...cache[q], via: 'cache' };
      continue; // null 캐시 = 이전 실패
    }
    if (budget.left <= 0) return null;

    let found = null;
    try {
      found = HAS_NCP ? await geocodeNcp(q) : await geocodeNominatim(q);
      budget.left--;
    } catch (e) {
      budget.left = 0;
      console.error(`  [지오코딩 중단] ${e.message}`);
      return null;
    }
    cache[q] = found ? { lat: round6(found.lat), lng: round6(found.lng) } : null;
    if (found) return { ...cache[q], via: HAS_NCP ? 'naver' : 'osm' };
  }
  return null;
}
