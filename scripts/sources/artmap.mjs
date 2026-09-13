#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · art-map.co.kr 진행중 전시 일괄 수집
//
//  → data/sources/artmap.json
//
//  이 사이트의 지도 뷰 엔드포인트(/data/new_exhibition.php)는 목록 조각에
//  push_val(제목, 위도, 경도, idx, 장소, 갤러리id, 포스터) 형태로 좌표를
//  직접 내려준다. 덕분에 지오코딩이 필요 없다.
//
//  주의
//   · 목록은 시작일 내림차순이고 종료된 전시가 대부분이다.
//     (실측: 589건 수집 시 진행중 23건) 오래된 구간까지 갈 필요가 없으므로
//     시작일이 충분히 과거로 내려가면 중단한다.
//   · 남의 서버를 긁는 것이므로 요청 간격을 두고, 상세 페이지는 캐시해
//     같은 전시를 다시 받지 않는다.
//
//  실행:  node scripts/sources/artmap.mjs [--no-detail] [--max-batches 200]
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchHtml } from '../lib/http.mjs';
import { cleanText, httpsify, isValidKoreaCoord } from '../config.mjs';

const OUT = 'data/sources/artmap.json';
const DETAIL_CACHE = 'data/artmap-detail-cache.json';

const BASE = 'https://art-map.co.kr';
const LIST_API = `${BASE}/data/new_exhibition.php`;
const UA = 'Mozilla/5.0 (compatible; art-map-bot/1.0; +https://github.com/allmytown-cpu/art-map)';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const MAX_BATCHES = Number(flag('max-batches', 200));
const WITH_DETAIL = !argv.includes('--no-detail');
const DELAY_MS = Number(flag('delay', 200));

// 시작일이 이 날짜보다 과거인 구간에 들어가면 중단한다.
// (그 이전에 시작해 지금도 하는 전시는 드물고, 있어도 목록 상단에 없다)
const CUTOFF_MONTHS = Number(flag('months-back', 20));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const cutoff = new Date(today.getFullYear(), today.getMonth() - CUTOFF_MONTHS, 1)
  .toISOString().slice(0, 10);

// ── 목록 ─────────────────────────────────────────────────────
async function fetchBatch(start, wrap, attempt = 1) {
  try {
    const res = await fetch(LIST_API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/exhibition/new_list.php`,
      },
      body: new URLSearchParams({
        start: String(start), wrap: String(wrap), type: 'exhibition',
        area: '0', cate: '', od: '0', v_cnt: '0', online: '0',
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3) { await sleep(1000 * attempt); return fetchBatch(start, wrap, attempt + 1); }
    throw e;
  }
}

/**
 * 배치 HTML을 항목 단위로 쪼개 파싱한다.
 * push_val 목록과 날짜 목록을 각각 모아 인덱스로 짝짓는 방식은
 * 광고/배너가 섞이면 어긋나므로, 반드시 항목 단위로 자른 뒤 추출한다.
 */
function parseBatch(html) {
  const out = [];
  for (const chunk of html.split(/<a href='view\.php\?idx=/).slice(1)) {
    const idx = (chunk.match(/^(\d+)/) || [])[1];
    const p = chunk.match(
      /push_val\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*"([^"]*)"/
    );
    const d = chunk.match(/<span>(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})<\/span>/);
    if (!idx || !p || !d) continue;

    const lat = parseFloat(p[2]), lng = parseFloat(p[3]);
    const [placeName, areaName] = cleanText(p[5]).split('/').map((s) => (s || '').trim());

    out.push({
      idx,
      title: cleanText(p[1]),
      lat: isValidKoreaCoord(lat, lng) ? lat : null,
      lng: isValidKoreaCoord(lat, lng) ? lng : null,
      place: placeName || '',
      area: areaName || '',
      poster: httpsify(cleanText(p[7])),
      start: `${d[1]}-${d[2]}-${d[3]}`,
      end: `${d[4]}-${d[5]}-${d[6]}`,
    });
  }
  return out;
}

// ── 상세 (주소·요금·전화·작가) ───────────────────────────────
const stripTags = (s) => cleanText(String(s || '').replace(/<[^>]+>/g, ' '));

async function fetchDetail(idx) {
  const { html } = await fetchHtml(`${BASE}/exhibition/view.php?idx=${idx}&type=top`);
  const table = (html.match(/<table[^>]*id=["']view_table["'][\s\S]*?<\/table>/i) || [])[0];
  if (!table) return null;

  const rows = {}; const links = {};
  for (const r of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = (r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1];
    const td = (r[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1];
    if (!th) continue;
    rows[stripTags(th).replace(/\|/g, '').trim()] = stripTags(td || '');
    const href = td && (td.match(/href=["']([^"']+)["']/) || [])[1];
    if (href && /^https?:/.test(href)) links[stripTags(th).replace(/\|/g, '').trim()] = href;
  }

  const desc = [];
  if (rows['작가']) desc.push('참여작가: ' + rows['작가']);
  if (rows['시간']) desc.push('관람시간: ' + rows['시간']);
  if (rows['휴관']) desc.push('휴관: ' + rows['휴관']);

  return {
    address: rows['주소'] || '',
    price: rows['관람료'] || '',
    phone: rows['전화번호'] || '',
    url: links['사이트'] || '',
    desc: cleanText(desc.join(' / ')).slice(0, 500),
  };
}

// ── 메인 ─────────────────────────────────────────────────────
console.log('━'.repeat(62));
console.log('ART MAP · art-map.co.kr 전시 수집');
console.log(`  ${LIST_API}`);
console.log(`  최대 ${MAX_BATCHES}배치 · 시작일 ${cutoff} 이후 · 상세조회 ${WITH_DETAIL ? 'ON' : 'OFF'}`);
console.log('━'.repeat(62));

const seen = new Map();
let start = 0, wrap = 1, batches = 0, reachedCutoff = false;

for (let i = 0; i < MAX_BATCHES; i++) {
  const html = await fetchBatch(start, wrap);
  batches++;
  if (html.trim() === 'end' || html.trim().length < 5) {
    console.log(`\n  목록 끝 (${batches}배치)`);
    break;
  }

  const items = parseBatch(html);
  for (const it of items) seen.set(it.idx, it);

  // 시작일 내림차순이므로 배치의 최신 시작일이 컷오프보다 과거면 그만 본다
  const newest = items.reduce((a, b) => (a && a > b.start ? a : b.start), null);
  if (newest && newest < cutoff) {
    reachedCutoff = true;
    console.log(`\n  컷오프 도달 (시작일 ${newest} < ${cutoff}) — ${batches}배치에서 중단`);
    break;
  }

  if (batches % 20 === 0) process.stdout.write(`\r  ${batches}배치 · ${seen.size}건 수집   `);
  start += 4; wrap += 1;
  await sleep(DELAY_MS);
}
if (!reachedCutoff) process.stdout.write('\n');

const all = [...seen.values()];
const live = all.filter((e) => e.end >= todayStr);
console.log(`\n  수집 ${all.length}건 → 아직 안 끝난 전시 ${live.length}건`);

// ── 상세 보강 ────────────────────────────────────────────────
const cache = await readJson(DETAIL_CACHE, {});
if (WITH_DETAIL) {
  const todo = live.filter((e) => !cache[e.idx]);
  console.log(`  상세 조회 ${todo.length}건 (캐시 ${live.length - todo.length}건)`);
  let n = 0;
  for (const e of todo) {
    try { cache[e.idx] = await fetchDetail(e.idx); } catch { cache[e.idx] = null; }
    n++;
    if (n % 5 === 0 || n === todo.length) process.stdout.write(`\r    ${n}/${todo.length}   `);
    await sleep(DELAY_MS);
  }
  if (todo.length) process.stdout.write('\n');
}

// 더 이상 목록에 없는 캐시 정리
const aliveIdx = new Set(live.map((e) => e.idx));
for (const k of Object.keys(cache)) if (!aliveIdx.has(k)) delete cache[k];

// ── 스키마 변환 ──────────────────────────────────────────────
const records = live.map((e) => {
  const d = cache[e.idx] || {};
  return {
    id: 'am' + e.idx,
    source: 'artmap',
    sourceUrl: `${BASE}/exhibition/view.php?idx=${e.idx}`,
    title: e.title,
    category: 'exhibition',
    realm: '전시',
    start: e.start,
    end: e.end,
    place: e.place,
    area: e.area,
    sigungu: '',
    address: d.address || '',
    lat: e.lat,
    lng: e.lng,
    geo: e.lat ? 'api' : null,
    thumbnail: e.poster,
    price: d.price || '',
    phone: d.phone || '',
    url: d.url || `${BASE}/exhibition/view.php?idx=${e.idx}`,
    desc: d.desc || '',
  };
});

records.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(records, null, 1), 'utf8');
await fs.writeFile(DETAIL_CACHE, JSON.stringify(cache), 'utf8');

const withCoord = records.filter((r) => r.lat != null).length;
const withAddr = records.filter((r) => r.address).length;
console.log(`\n  ${OUT}`);
console.log(`  ${records.length}건 · 좌표 ${withCoord}건 · 주소 ${withAddr}건 · 총 요청 약 ${batches + Object.keys(cache).length}회`);
console.log('\n✔ 완료 (events.json 반영은 npm run build)');
