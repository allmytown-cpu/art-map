#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 링크로 전시 추가
//
//  전시 페이지 URL을 주면 정보를 추출하고 좌표를 찾아
//  data/sources/manual.json 에 추가한다.
//
//  실행:
//    node scripts/import-link.mjs "https://art-map.co.kr/exhibition/view.php?idx=32424"
//    node scripts/import-link.mjs <url> --title "전시명" --place "장소" --start 2026-09-01 --end 2026-10-01
//    node scripts/import-link.mjs <url> --dry        (저장하지 않고 결과만 확인)
//    node scripts/import-link.mjs --remove <id>
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFromUrl } from './lib/extract.mjs';
import { resolveCoords, buildGazetteer, loadCache, saveCache, HAS_NCP } from './lib/geocode.mjs';
import { PATHS, CATEGORY_RULES } from './config.mjs';

const MANUAL = 'data/sources/manual.json';
const KCISA = 'data/sources/kcisa.json';

// ── 인자 파싱 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(argv[i]);
}

const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'm' + (h >>> 0).toString(36);
}

// ── 삭제 모드 ────────────────────────────────────────────────
if (flags.remove) {
  const list = await readJson(MANUAL, []);
  const before = list.length;
  const next = list.filter((e) => e.id !== flags.remove);
  if (next.length === before) {
    console.error(`[오류] id '${flags.remove}' 를 찾지 못했습니다.`);
    process.exit(1);
  }
  await fs.writeFile(MANUAL, JSON.stringify(next, null, 1), 'utf8');
  console.log(`✔ 삭제했습니다. (${before} → ${next.length}건)`);
  process.exit(0);
}

const url = flags.url || positional[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('\n사용법: node scripts/import-link.mjs "<전시 페이지 URL>" [옵션]');
  console.error('옵션: --title --place --address --start --end --category --price --phone --dry\n');
  process.exit(1);
}

// ── 실행 ─────────────────────────────────────────────────────
console.log('━'.repeat(62));
console.log('ART MAP · 링크로 전시 추가');
console.log('  ' + url);
console.log('━'.repeat(62));

let info;
try {
  info = await extractFromUrl(url);
} catch (e) {
  console.error('\n[추출 실패] ' + e.message);
  console.error('\n→ 아래처럼 직접 값을 넘기면 등록할 수 있습니다:');
  console.error(`   node scripts/import-link.mjs "${url}" --title "전시명" --place "장소명" --start 2026-09-01 --end 2026-10-01\n`);
  process.exit(1);
}

console.log(`\n[1/3] 정보 추출  (어댑터: ${info.adapter})`);

// 수동 지정값이 우선
for (const k of ['title', 'place', 'address', 'start', 'end', 'price', 'phone', 'area', 'sigungu', 'desc']) {
  if (typeof flags[k] === 'string') info[k] = flags[k];
}
if (typeof flags.category === 'string') {
  const ok = CATEGORY_RULES.map((c) => c.id).concat('etc');
  if (!ok.includes(flags.category)) {
    console.error(`[오류] category는 ${ok.join(', ')} 중 하나여야 합니다.`);
    process.exit(1);
  }
  info.category = flags.category;
}

const show = (k, v) => console.log(`  ${k.padEnd(8)} ${v || '(없음)'}`);
show('제목', info.title);
show('기간', `${info.start || '?'} ~ ${info.end || '?'}`);
show('장소', info.place);
show('주소', info.address);
show('분야', info.category);
show('요금', info.price);
show('전화', info.phone);
show('링크', info.url);
show('이미지', info.thumbnail ? info.thumbnail.slice(0, 70) + '…' : '');

// ── 좌표 ─────────────────────────────────────────────────────
console.log(`\n[2/3] 좌표 해석  (지오코더: ${HAS_NCP ? '네이버' : 'OpenStreetMap'})`);
await loadCache();
const kcisa = await readJson(KCISA, []);
const manual = await readJson(MANUAL, []);
buildGazetteer([...kcisa, ...manual]);

let lat = flags.lat ? parseFloat(flags.lat) : null;
let lng = flags.lng ? parseFloat(flags.lng) : null;
let via = lat && lng ? 'manual' : null;

if (!via) {
  const hit = await resolveCoords(info);
  if (hit) { lat = hit.lat; lng = hit.lng; via = hit.via; }
}
await saveCache();

if (lat && lng) {
  console.log(`  ✔ ${lat}, ${lng}  (출처: ${via})`);
} else {
  console.log('  ✖ 좌표를 찾지 못했습니다.');
  if (!HAS_NCP) {
    console.log('    국내 지번주소는 OpenStreetMap이 거의 못 찾습니다.');
    console.log('    NCP_APIGW_KEY_ID / NCP_APIGW_KEY 를 설정하면 네이버 지오코딩을 씁니다.');
  }
  console.log('    또는 네이버지도에서 좌표를 확인해 --lat 37.5xxx --lng 126.9xxx 로 지정하세요.');
}

// ── 검증 ─────────────────────────────────────────────────────
// 불완전한 항목이 그대로 커밋되면 지도가 오염된다.
// '치명적' 문제가 하나라도 있으면 저장을 거부한다. (--force 로 무시 가능)
const fatal = [];
const warn = [];

if (!info.title) fatal.push('제목 없음');
if (!info.start || !info.end) fatal.push('기간을 못 읽음 → --start 2026-09-01 --end 2026-10-01');
if (!info.place && !info.address && !lat) fatal.push('장소·주소·좌표가 모두 없음 → --place 또는 --lat/--lng');
if (!lat) warn.push('좌표 없음 (목록에는 나오지만 지도에는 표시되지 않음)');

if (warn.length) console.log('\n  ⚠ ' + warn.join(' · '));

if (fatal.length && !flags.force) {
  console.error('\n[저장 거부] 아래 항목이 없으면 지도에 쓸 수 없습니다.');
  fatal.forEach((p) => console.error('  · ' + p));
  console.error('\n  값을 직접 지정해 다시 실행하거나, 그래도 넣으려면 --force 를 붙이세요.');
  process.exit(1);
}

// ── 저장 ─────────────────────────────────────────────────────
const record = {
  id: hashId(info.sourceUrl || url),
  source: 'manual',
  sourceUrl: info.sourceUrl || url,
  adapter: info.adapter,
  title: info.title,
  category: info.category,
  realm: info.realm || '전시',
  start: info.start,
  end: info.end,
  place: info.place || '',
  area: info.area || '',
  sigungu: info.sigungu || '',
  address: info.address || '',
  lat: lat ?? null,
  lng: lng ?? null,
  geo: lat ? via : null,
  thumbnail: info.thumbnail || '',
  price: info.price || '',
  phone: info.phone || '',
  url: info.url || url,
  desc: info.desc || '',
  addedAt: new Date().toISOString().slice(0, 10),
};

if (flags.dry) {
  console.log('\n[3/3] --dry 모드: 저장하지 않았습니다.');
  console.log(JSON.stringify(record, null, 1));
  // process.exit()를 쓰면 Windows에서 libuv 어서션이 뜨므로 exitCode만 설정한다.
  process.exitCode = warn.length ? 2 : 0;
}

if (!flags.dry) {
  const idx = manual.findIndex((e) => e.id === record.id);
  if (idx >= 0) {
    manual[idx] = { ...manual[idx], ...record };
    console.log(`\n[3/3] 기존 항목 갱신 (id=${record.id})`);
  } else {
    manual.push(record);
    console.log(`\n[3/3] 신규 추가 (id=${record.id})`);
  }

  await fs.mkdir(path.dirname(MANUAL), { recursive: true });
  await fs.writeFile(MANUAL, JSON.stringify(manual, null, 1), 'utf8');
  console.log(`  ${MANUAL} · 총 ${manual.length}건`);
  console.log('\n✔ 완료. data/events.json 에 반영하려면 npm run build 를 실행하세요.');
}
