#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 여러 소스를 합쳐 data/events.json 생성
//
//   data/sources/kcisa.json   공공데이터 (한눈에보는문화정보)
//   data/sources/manual.json  링크로 직접 추가한 전시
//        │
//        └─→ 중복 제거 → 정렬 → data/events.json + data/meta.json
//
//  같은 전시가 여러 소스에 다른 제목으로 등록되는 일이 잦아서
//  제목 유사도 + 기간 겹침 + 장소/좌표 근접을 함께 본다.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, CATEGORY_RULES, DEFAULT_CATEGORY } from './config.mjs';

// priority가 높을수록 중복 시 그쪽 값이 살아남는다.
const SOURCES = [
  { id: 'manual', file: 'data/sources/manual.json', priority: 3, label: '직접 추가' },
  // art-map은 전시 전용이라 제목·장소·좌표 품질이 공공데이터보다 낫다.
  { id: 'artmap', file: 'data/sources/artmap.json', priority: 2, label: 'art-map' },
  { id: 'kcisa', file: 'data/sources/kcisa.json', priority: 1, label: '공공데이터' },
];

const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

// ── 중복 판정 ────────────────────────────────────────────────
/** 비교용 제목 정규화: 괄호·기호·공백 제거 */
function normTitle(s) {
  return String(s || '')
    .replace(/[《》〈〉<>\[\]（）()「」『』"'·・,.\-–—~!?:：]/g, '')
    .replace(/(기획전|특별전|상설전|개인전|초대전|展|전시)/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 두 문자열의 bigram Dice 계수 (0~1) */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a), gb = grams(b);
  let hit = 0, total = 0;
  for (const [g, n] of ga) { total += n; hit += Math.min(n, gb.get(g) || 0); }
  for (const n of gb.values()) total += n;
  return (2 * hit) / total;
}

function overlaps(a, b) {
  if (!a.start || !a.end || !b.start || !b.end) return true; // 정보 부족 시 관대하게
  return a.start <= b.end && b.start <= a.end;
}

function distanceM(a, b) {
  if (a.lat == null || b.lat == null) return Infinity;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function samePlace(a, b) {
  const pa = normTitle(a.place), pb = normTitle(b.place);
  if (pa && pb && (pa === pb || pa.includes(pb) || pb.includes(pa))) return true;
  return distanceM(a, b) <= 300;
}

/** 시작일 차이(일). 알 수 없으면 Infinity */
function startGapDays(a, b) {
  if (!a.start || !b.start) return Infinity;
  return Math.abs(new Date(a.start) - new Date(b.start)) / 86400000;
}

/**
 * 중복 판정.
 *
 * 주의: 한국 전시·공연 제목은 시리즈 접두어가 길어서
 *   "2026 PLOT STAGE - 유지원 <Wharton>" 과 "2026 PLOT STAGE"
 *   "지브리 콘서트: 바다와 함께하는 여름" 과 "지브리 콘서트: 바람계곡의 나우시카"
 * 같은 서로 다른 프로그램이 높은 유사도를 갖는다.
 * 느슨하게 잡으면 멀쩡한 전시가 통째로 사라지므로 기준을 빡빡하게 둔다.
 *
 * 또한 같은 소스 안에서는 이미 고유 id로 중복이 제거돼 있으므로
 * 서로 다른 소스 사이에서만 판정한다.
 */
function isDuplicate(a, b) {
  if (a.source === b.source) return false;
  if (!overlaps(a, b)) return false;
  if (startGapDays(a, b) > 14) return false;

  const sim = similarity(a._nt, b._nt);
  if (sim >= 0.95) return true;                     // 제목이 사실상 동일
  if (sim >= 0.85 && samePlace(a, b)) return true;  // 제목 거의 같고 장소도 같음
  return false;
}

/** 두 레코드를 합친다. 우선순위가 높은 쪽을 기본으로 하되 빈 필드는 채운다. */
function merge(hi, lo) {
  const out = { ...lo, ...hi };
  for (const k of ['address', 'price', 'phone', 'url', 'desc', 'thumbnail', 'place', 'area', 'sigungu']) {
    if (!out[k] && lo[k]) out[k] = lo[k];
  }
  if (out.lat == null && lo.lat != null) { out.lat = lo.lat; out.lng = lo.lng; out.geo = lo.geo; }
  out.mergedFrom = [...new Set([...(hi.mergedFrom || [hi.source]), ...(lo.mergedFrom || [lo.source])])];
  return out;
}

// ── 메인 ─────────────────────────────────────────────────────
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

console.log('━'.repeat(62));
console.log('ART MAP · 소스 병합');
console.log('━'.repeat(62));

const all = [];
const perSource = {};
for (const s of SOURCES) {
  const rows = await readJson(s.file, []);
  perSource[s.id] = rows.length;
  console.log(`  ${s.label.padEnd(10)} ${String(rows.length).padStart(5)}건  ${s.file}`);
  for (const r of rows) {
    all.push({ ...r, source: r.source || s.id, _prio: s.priority, _nt: normTitle(r.title) });
  }
}

if (all.length === 0) {
  console.error('\n[오류] 소스가 비어 있습니다. 먼저 fetch-events 를 실행하세요.');
  process.exit(1);
}

// 종료된 행사 제외
const alive = all.filter((e) => !e.end || e.end >= todayStr);
console.log(`\n  종료된 행사 ${all.length - alive.length}건 제외`);

// 우선순위 높은 것부터 처리해야 병합 시 신뢰도 높은 값이 살아남는다
alive.sort((a, b) => b._prio - a._prio);

// 같은 달에 시작하는 것끼리만 비교해 O(n²)를 줄인다
const buckets = new Map();
const result = [];
let dupCount = 0;

for (const ev of alive) {
  const key = (ev.start || '____-__').slice(0, 7);
  const near = [];
  for (const k of [key, shiftMonth(key, -1), shiftMonth(key, 1)]) {
    if (buckets.has(k)) near.push(...buckets.get(k));
  }

  const hit = near.find((o) => isDuplicate(o, ev));
  if (hit) {
    dupCount++;
    Object.assign(hit, merge(hit, ev));
    continue;
  }

  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(ev);
  result.push(ev);
}

function shiftMonth(ym, delta) {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

console.log(`  중복 병합 ${dupCount}건`);

// 내부 필드 제거 후 정렬
for (const e of result) { delete e._prio; delete e._nt; }
result.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));

const withCoord = result.filter((e) => e.lat != null).length;
const byCategory = {};
const bySource = {};
for (const e of result) {
  byCategory[e.category || DEFAULT_CATEGORY] = (byCategory[e.category || DEFAULT_CATEGORY] || 0) + 1;
  bySource[e.source] = (bySource[e.source] || 0) + 1;
}

await fs.mkdir(path.dirname(PATHS.events), { recursive: true });
await fs.writeFile(PATHS.events, JSON.stringify(result), 'utf8');

const prevMeta = await readJson(PATHS.meta, {});
await fs.writeFile(PATHS.meta, JSON.stringify({
  ...prevMeta,
  updatedAt: new Date().toISOString(),
  total: result.length,
  withCoord,
  byCategory,
  bySource,
  sources: perSource,
  duplicatesMerged: dupCount,
}, null, 2), 'utf8');

const kb = ((await fs.stat(PATHS.events)).size / 1024).toFixed(0);
console.log(`\n  events.json  ${result.length}건 / ${kb} KB`);
console.log(`  좌표 보유    ${withCoord}건 (${((withCoord / result.length) * 100).toFixed(1)}%)`);
console.log(`  분야별       ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`  출처별       ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log('\n✔ 완료');
