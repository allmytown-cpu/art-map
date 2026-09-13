#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 1단계: 공공데이터 수집 → data/events.json
//
//  1) period2 로 "오늘 이후에 끝나는" 행사 목록을 전부 가져온다.
//     (from/to는 endDate 기준이므로 from=오늘, to=먼 미래)
//  2) detail2 로 주소·요금·전화·설명을 보강한다. (seq 기준 캐시)
//
//  실행:  $env:DATA_GO_KR_SERVICE_KEY="..."; node scripts/fetch-events.mjs
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { XMLParser } from 'fast-xml-parser';

// apis.data.go.kr 은 AAAA 레코드가 없다. IPv6를 먼저 시도하다 실패하는 경우를 막는다.
dns.setDefaultResultOrder('ipv4first');
import {
  API_BASE, OP_LIST, OP_DETAIL, PAGE_SIZE, PAGE_PARAM, YEARS_AHEAD,
  MAX_PAGES, REQUEST_DELAY_MS, MAX_RETRY, DETAIL_BUDGET,
  classify, isValidKoreaCoord, cleanText, httpsify, PATHS,
} from './config.mjs';

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || process.env.SERVICE_KEY || '';
if (!SERVICE_KEY) {
  console.error('\n[오류] 서비스키가 없습니다.');
  console.error('  PowerShell:  $env:DATA_GO_KR_SERVICE_KEY="발급받은키"; npm run fetch');
  console.error('  GitHub:      Settings > Secrets and variables > Actions 에 DATA_GO_KR_SERVICE_KEY 등록\n');
  process.exit(1);
}

// 공공데이터포털은 Decoding 키(+,/,= 포함)와 Encoding 키(%2B…)를 둘 다 준다.
// 이미 인코딩된 키를 또 인코딩하면 인증에 실패하므로 구분한다.
const KEY = /%[0-9A-Fa-f]{2}/.test(SERVICE_KEY) ? SERVICE_KEY : encodeURIComponent(SERVICE_KEY);

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ── HTTP ─────────────────────────────────────────────────────
/** 재시도해도 소용없는(=설정이 잘못된) 오류인지 판정 */
const isFatal = (msg) => /존재하지 않습니다|등록되지 않은|한도를 초과/.test(msg);

let rateLimitRemaining = null;

async function apiGet(operation, params, attempt = 1) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const url = `${API_BASE}/${operation}?serviceKey=${KEY}&${qs}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml' },
      signal: AbortSignal.timeout(45000),
    });
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem !== null) rateLimitRemaining = Number(rem);
    const text = await res.text();

    if (/NO_OPENAPI_SERVICE_ERROR/.test(text)) {
      throw new Error(`오퍼레이션 '${operation}' 이(가) 존재하지 않습니다 (폐기된 엔드포인트).`);
    }
    if (/SERVICE_KEY_IS_NOT_REGISTERED/.test(text)) {
      throw new Error('등록되지 않은 서비스키입니다. 활용신청 승인 여부를 확인하세요.');
    }
    if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS/.test(text)) {
      throw new Error('일일 호출 한도를 초과했습니다.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const tree = parser.parse(text);
    const code = tree?.response?.header?.resultCode;
    if (code !== undefined && String(code) !== '00' && String(code) !== '0') {
      throw new Error(`API 오류 ${code}: ${tree?.response?.header?.resultMsg || ''}`);
    }
    return tree?.response?.body || {};
  } catch (e) {
    // undici의 'fetch failed'는 원인이 e.cause에 들어있어 그대로 두면 디버깅이 불가능하다.
    const detail = e.cause ? ` (${e.cause.code || e.cause.message})` : '';
    const msg = e.message + detail;

    if (attempt < MAX_RETRY && !isFatal(e.message)) {
      // 지수 백오프 + 지터. 공공데이터포털은 순간적으로 연결을 끊는 일이 잦다.
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      console.warn(`\n  ! ${operation} 요청 실패 (${attempt}/${MAX_RETRY}): ${msg} → ${(wait / 1000).toFixed(1)}초 후 재시도`);
      await sleep(wait);
      return apiGet(operation, params, attempt + 1);
    }
    throw new Error(msg);
  }
}

/** body.items.item 을 항상 배열로 */
function itemsOf(body) {
  const it = body?.items?.item;
  if (!it) return [];
  return Array.isArray(it) ? it : [it];
}

// ── 정규화 ───────────────────────────────────────────────────
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function normDate(v) {
  const d = str(v).replace(/[^\d]/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
}

function coordsOf(rec) {
  let lng = parseFloat(str(rec.gpsX));
  let lat = parseFloat(str(rec.gpsY));
  // 드물게 위/경도가 뒤바뀐 레코드가 있어 보정한다.
  if (!isValidKoreaCoord(lat, lng) && isValidKoreaCoord(lng, lat)) [lat, lng] = [lng, lat];
  return isValidKoreaCoord(lat, lng) ? { lat: round6(lat), lng: round6(lng) } : null;
}

function normalizeListItem(rec) {
  const title = cleanText(rec.title);
  const seq = str(rec.seq);
  if (!title || !seq) return null;

  const realm = cleanText(rec.realmName);
  const service = cleanText(rec.serviceName);
  const start = normDate(rec.startDate);
  const end = normDate(rec.endDate) || start;
  const c = coordsOf(rec);

  return {
    id: seq,
    title,
    category: classify(realm, service),
    realm: realm || service,
    start,
    end,
    place: cleanText(rec.place),
    area: cleanText(rec.area),
    sigungu: cleanText(rec.sigungu),
    address: '',
    lat: c ? c.lat : null,
    lng: c ? c.lng : null,
    geo: c ? 'api' : null,       // 좌표 출처: api | geocode | null
    thumbnail: httpsify(cleanText(rec.thumbnail)),
    price: '',
    phone: '',
    url: '',
    desc: '',
  };
}

/** detail2 응답에서 목록에 없는 정보만 추출 */
function normalizeDetail(rec) {
  const c = coordsOf(rec);
  return {
    address: cleanText(rec.placeAddr),
    price: cleanText(rec.price),
    phone: cleanText(rec.phone),
    url: httpsify(cleanText(rec.url)) || httpsify(cleanText(rec.placeUrl)),
    desc: cleanText(rec.contents1, { stripTags: true }).slice(0, 500),
    thumbnail: httpsify(cleanText(rec.imgUrl)),
    lat: c ? c.lat : null,
    lng: c ? c.lng : null,
  };
}

// ── 1단계: 목록 수집 ─────────────────────────────────────────
async function fetchList(from, to) {
  const out = [];
  const first = await apiGet(OP_LIST, { from, to, [PAGE_PARAM]: 1, sortStdr: 1 });
  const total = Number(first.totalCount) || 0;
  const lastPage = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);

  out.push(...itemsOf(first));
  console.log(`  총 ${total.toLocaleString()}건 · ${lastPage}페이지 (페이지당 ${PAGE_SIZE}건 고정)`);

  for (let p = 2; p <= lastPage; p++) {
    await sleep(REQUEST_DELAY_MS);
    const body = await apiGet(OP_LIST, { from, to, [PAGE_PARAM]: p, sortStdr: 1 });
    const items = itemsOf(body);
    out.push(...items);
    if (p % 10 === 0 || p === lastPage) {
      process.stdout.write(`\r  수집 ${p}/${lastPage} 페이지 (${out.length}건)      `);
    }
    if (items.length === 0) break;
  }
  process.stdout.write('\n');
  return out;
}

// ── 2단계: 상세 보강 ─────────────────────────────────────────
async function enrich(events, cache) {
  // 좌표 없는 건을 먼저 처리 (주소를 얻어야 지오코딩이 가능하므로)
  const todo = events
    .filter((e) => !cache[e.id])
    .sort((a, b) => (a.lat === null ? 0 : 1) - (b.lat === null ? 0 : 1));

  const budget = Math.min(todo.length, DETAIL_BUDGET);
  console.log(`  캐시 ${Object.keys(cache).length}건 · 신규 조회 ${budget}건 (미처리 ${todo.length - budget}건은 다음 실행 때)`);

  let ok = 0, fail = 0;
  for (let i = 0; i < budget; i++) {
    const ev = todo[i];
    try {
      const body = await apiGet(OP_DETAIL, { seq: ev.id });
      const rec = itemsOf(body)[0];
      cache[ev.id] = rec ? normalizeDetail(rec) : null;
      ok++;
    } catch (e) {
      fail++;
      if (/한도를 초과|등록되지 않은/.test(e.message)) {
        console.log(`\n  [상세 조회 중단] ${e.message}`);
        break;
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === budget) {
      process.stdout.write(`\r  상세 ${i + 1}/${budget} (성공 ${ok} · 실패 ${fail})      `);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write('\n');

  // 캐시 내용을 이벤트에 병합
  let merged = 0, coordFromDetail = 0;
  for (const ev of events) {
    const d = cache[ev.id];
    if (!d) continue;
    merged++;
    if (d.address) ev.address = d.address;
    if (d.price) ev.price = d.price;
    if (d.phone) ev.phone = d.phone;
    if (d.url) ev.url = d.url;
    if (d.desc) ev.desc = d.desc;
    if (!ev.thumbnail && d.thumbnail) ev.thumbnail = d.thumbnail;
    if (ev.lat === null && d.lat !== null) {
      ev.lat = d.lat; ev.lng = d.lng; ev.geo = 'api'; coordFromDetail++;
    }
  }
  console.log(`  보강 적용 ${merged}건 (상세에서 좌표 복구 ${coordFromDetail}건)`);
  return cache;
}

/**
 * 데이터셋 내부에서 좌표를 서로 빌려온다.
 * 같은 장소(place)나 같은 주소에서 열리는 다른 행사에 좌표가 있으면 그것을 재사용한다.
 * API 호출이 필요 없는 공짜 보정이라 지오코딩 전에 먼저 수행한다.
 */
function fillFromSiblings(events) {
  const byPlace = new Map();
  const byAddr = new Map();
  for (const e of events) {
    if (e.lat === null) continue;
    const key = `${e.area}|${e.place}`;
    if (e.place && !byPlace.has(key)) byPlace.set(key, [e.lat, e.lng]);
    if (e.address && !byAddr.has(e.address)) byAddr.set(e.address, [e.lat, e.lng]);
  }

  let filled = 0;
  for (const e of events) {
    if (e.lat !== null) continue;
    const hit = (e.address && byAddr.get(e.address)) || (e.place && byPlace.get(`${e.area}|${e.place}`));
    if (hit) { e.lat = hit[0]; e.lng = hit[1]; e.geo = 'sibling'; filled++; }
  }
  return filled;
}

// ── 메인 ─────────────────────────────────────────────────────
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function main() {
  const today = new Date();
  const from = ymd(today);
  const to = ymd(new Date(today.getFullYear() + YEARS_AHEAD, 11, 31));

  console.log('━'.repeat(62));
  console.log('ART MAP · 공공데이터 수집');
  console.log(`  ${API_BASE}/${OP_LIST}`);
  console.log(`  from=${from} to=${to}  (※ from/to는 endDate 기준 = 아직 안 끝난 행사)`);
  console.log('━'.repeat(62));

  console.log('\n[1/3] 목록 수집');
  const raw = await fetchList(from, to);

  // 정규화 + 중복 제거
  const byId = new Map();
  for (const rec of raw) {
    const item = normalizeListItem(rec);
    if (!item) continue;
    const prev = byId.get(item.id);
    if (!prev || (prev.lat === null && item.lat !== null)) byId.set(item.id, { ...prev, ...item });
  }
  const events = [...byId.values()];
  console.log(`  정규화 ${events.length}건 (원본 ${raw.length}건, 중복 ${raw.length - events.length}건 제거)`);

  console.log('\n[2/3] 상세정보 보강 (detail2)');
  const detailCache = await readJson(PATHS.detailCache, {});
  await enrich(events, detailCache);

  const siblingFilled = fillFromSiblings(events);
  console.log(`  같은 장소의 다른 행사에서 좌표 차용 ${siblingFilled}건`);

  // 더 이상 목록에 없는 캐시 항목 정리
  const alive = new Set(events.map((e) => e.id));
  for (const k of Object.keys(detailCache)) if (!alive.has(k)) delete detailCache[k];

  console.log('\n[3/3] 저장');

  // from/to가 endDate 기준이라 이론상 없어야 하지만, 간혹 섞여 들어오는 종료분을 거른다.
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const expired = events.filter((e) => e.end && e.end < todayStr).length;
  if (expired) {
    console.log(`  이미 종료된 행사 ${expired}건 제외`);
    for (let i = events.length - 1; i >= 0; i--) if (events[i].end && events[i].end < todayStr) events.splice(i, 1);
  }

  events.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));

  const withCoord = events.filter((e) => e.lat !== null).length;
  const byCategory = {};
  const byRealm = {};
  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    byRealm[e.realm || '(빈값)'] = (byRealm[e.realm || '(빈값)'] || 0) + 1;
  }

  await fs.mkdir(path.dirname(PATHS.events), { recursive: true });
  await fs.writeFile(PATHS.events, JSON.stringify(events), 'utf8');
  await fs.writeFile(PATHS.detailCache, JSON.stringify(detailCache), 'utf8');
  await fs.writeFile(PATHS.meta, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: '공공데이터포털 · 한국문화정보원 한눈에보는문화정보 조회서비스',
    sourceUrl: 'https://www.data.go.kr/data/15138937/openapi.do',
    endpoint: `${API_BASE}/${OP_LIST}`,
    range: { from, to, basis: 'endDate' },
    total: events.length,
    withCoord,
    byCategory,
    byRealm,
  }, null, 2), 'utf8');

  const kb = ((await fs.stat(PATHS.events)).size / 1024).toFixed(0);
  console.log(`  events.json  ${events.length}건 / ${kb} KB`);
  console.log(`  좌표 보유    ${withCoord}건 (${((withCoord / Math.max(events.length, 1)) * 100).toFixed(1)}%)`);
  console.log(`  분야별       ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  if (rateLimitRemaining !== null) {
    console.log(`  API 잔여량   ${rateLimitRemaining.toLocaleString()}회 (일일 한도 10,000회)`);
  }
  console.log('\n✔ 완료');
}

main().catch((e) => { console.error('\n[실패]', e.message); process.exit(1); });
