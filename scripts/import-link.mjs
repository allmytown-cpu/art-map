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
import { resolveCoords, buildGazetteer, loadCache, saveCache, buildQueries, HAS_NCP } from './lib/geocode.mjs';
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

const url = flags.url || positional[0] || '';
const hasUrl = /^https?:\/\//.test(url);

// URL이 없어도 제목만 있으면 직접 등록할 수 있다.
// (아트맵에 없는 전시를 손으로 넣는 경우)
if (!hasUrl && typeof flags.title !== 'string') {
  console.error('\n사용법: node scripts/import-link.mjs "<전시 페이지 URL>" [옵션]');
  console.error('       node scripts/import-link.mjs --title "전시명" --place "장소" --start ... --end ...');
  console.error('옵션: --title --place --address --start --end --category --price --phone --lat --lng --dry\n');
  process.exit(1);
}

// ── 실행 ─────────────────────────────────────────────────────
console.log('━'.repeat(62));
console.log('ART MAP · 전시 추가');
console.log('  ' + (hasUrl ? url : '(URL 없음 · 직접 입력)'));
console.log('━'.repeat(62));

const EMPTY = {
  adapter: '직접 입력', title: '', category: 'exhibition', realm: '전시',
  start: null, end: null, place: '', area: '', sigungu: '', address: '',
  price: '', phone: '', url: '', thumbnail: '', desc: '', sourceUrl: url,
};

let info = { ...EMPTY };
let extractError = null;

if (hasUrl) {
  try {
    info = await extractFromUrl(url);
  } catch (e) {
    // 추출 실패를 곧바로 종료 사유로 삼으면, 사용자가 직접 넣은 값을
    // 써보지도 못하고 죽는다. 실패는 기록만 하고 수동값으로 채우게 한다.
    extractError = e.message;
    info = { ...EMPTY, url };
  }
}

if (extractError) {
  console.log('\n[1/3] 자동 추출 실패 — 직접 입력한 값으로 진행합니다');
  console.log('  사유: ' + extractError.split('\n')[0]);
} else {
  console.log(`\n[1/3] 정보 추출  (어댑터: ${info.adapter})`);
}

// 수동 지정값이 우선
for (const k of ['title', 'place', 'address', 'start', 'end', 'price', 'phone', 'area', 'sigungu', 'desc', 'thumbnail']) {
  if (typeof flags[k] === 'string' && flags[k].trim()) info[k] = flags[k].trim();
}
if (!info.url && hasUrl) info.url = url;
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
let via = Number.isFinite(lat) && Number.isFinite(lng) ? 'manual' : null;
if (!via) { lat = null; lng = null; }

if (!via) {
  const queries = buildQueries(info);
  if (queries.length) console.log('  질의: ' + queries.join('  |  '));
  const hit = await resolveCoords(info);
  if (hit) { lat = hit.lat; lng = hit.lng; via = hit.via; }
}

// 주소로 못 찾았으면, 주소를 더 거칠게 다듬어 한 번 더 시도한다.
// (건물명이 붙어 있거나 동/번지 표기가 특이하면 지오코더가 실패한다)
if (!via && info.address) {
  const fallbacks = [
    info.address.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(),
    // 건물명 등 뒤쪽 덩어리를 떼고 "시도 시군구 도로명 번호"까지만
    (info.address.match(/^(\S+\s+\S+\s+\S*(?:로|길)\s*\d+(?:-\d+)?)/) || [])[1],
    // 지번주소: "서울 종로구 화동 106-5"
    (info.address.match(/^(\S+\s+\S+\s+\S+동\s*\d+(?:-\d+)?)/) || [])[1],
  ].filter((q) => q && q.length >= 5 && q !== info.address);

  for (const q of [...new Set(fallbacks)]) {
    const hit = await resolveCoords({ address: q });
    if (hit) {
      lat = hit.lat; lng = hit.lng; via = hit.via + '(보정)';
      console.log(`  주소 보정 성공: "${q}"`);
      break;
    }
  }
}

await saveCache();

if (lat && lng) {
  console.log(`  ✔ ${lat}, ${lng}  (출처: ${via})`);
} else {
  console.log('  ✖ 좌표를 찾지 못했습니다.');
  if (!info.address && !info.place) {
    console.log('    주소나 장소명이 없습니다. 주소를 입력하면 좌표를 자동으로 찾습니다.');
  } else {
    console.log('    주소를 "서울 종로구 세종대로 152" 처럼 도로명+건물번호까지 입력해 보세요.');
  }
  if (!HAS_NCP) {
    console.log('    (네이버 지오코딩 키가 없어 정확도가 낮은 OpenStreetMap을 쓰는 중입니다)');
  }
}

// ── 검증 ─────────────────────────────────────────────────────
// 불완전한 항목이 그대로 커밋되면 지도가 오염된다.
// '치명적' 문제가 하나라도 있으면 저장을 거부한다. (--force 로 무시 가능)
const fatal = [];
const warn = [];

if (!info.title) fatal.push('제목 — 직접 입력란의 "제목"을 채우세요');
if (!info.start || !info.end) fatal.push('기간 — "시작일"과 "종료일"을 채우세요');
if (!info.place && !info.address && !lat) fatal.push('위치 — "장소명" 또는 "주소"를 채우세요');
if (!lat) warn.push('좌표 없음 (목록에는 나오지만 지도에는 표시되지 않음)');

if (warn.length) console.log('\n  ⚠ ' + warn.join(' · '));

if (fatal.length && !flags.force) {
  console.error('\n[저장 거부] 아래 항목이 비어 있습니다.');
  fatal.forEach((p) => console.error('  · ' + p));
  if (extractError) {
    console.error('\n  이 링크는 자동 추출이 안 되는 사이트입니다.');
    console.error('  관리자 페이지의 "직접 입력" 항목을 펼쳐 값을 채운 뒤 다시 실행하세요.');
  }
  process.exit(1);
}

// ── 저장 ─────────────────────────────────────────────────────
const record = {
  // URL이 없으면 제목+장소+시작일로 식별한다. 같은 전시를 두 번 넣으면 갱신된다.
  id: hashId(hasUrl ? (info.sourceUrl || url) : `${info.title}|${info.place}|${info.start}`),
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
