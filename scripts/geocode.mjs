#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 좌표 보정
//
//  data/sources/kcisa.json 중 좌표가 없는 항목의 위치를 찾는다.
//
//  ※ 실측 결과, 좌표가 없는 항목의 대부분은 주소도 장소명도 비어 있고
//    시도명만 있는 상설 프로그램이라 지오코딩으로도 찾을 수 없다.
//    (전시는 거의 전부 원본에 좌표가 있어 이 단계의 영향이 작다)
//
//  실행:  node scripts/geocode.mjs
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import {
  resolveCoords, buildGazetteer, loadCache, saveCache, buildQueries, HAS_NCP,
} from './lib/geocode.mjs';
import { PATHS } from './config.mjs';

const BUDGET = Number(process.env.GEOCODE_BUDGET || (HAS_NCP ? 2000 : 200));

const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

const events = await readJson(PATHS.kcisa, null);
if (!Array.isArray(events)) {
  console.error(`[오류] ${PATHS.kcisa} 가 없습니다. 먼저 npm run fetch 를 실행하세요.`);
  process.exit(1);
}

const manual = await readJson(PATHS.manual, []);
await loadCache();
buildGazetteer([...events, ...manual]);   // 좌표가 있는 항목들로 장소 색인 구성

const targets = events.filter((e) => e.lat == null);
const budget = { left: BUDGET };

console.log('━'.repeat(62));
console.log('ART MAP · 좌표 보정');
console.log(`  지오코더: ${HAS_NCP ? '네이버 클라우드 Geocoding' : 'OpenStreetMap Nominatim'}`);
console.log(`  대상 ${targets.length}건 / 전체 ${events.length}건 · 호출 상한 ${BUDGET}회`);
console.log('━'.repeat(62));

let ok = 0, skipped = 0, failed = 0;
const viaCount = {};

for (let i = 0; i < targets.length; i++) {
  const ev = targets[i];

  // 질의어를 만들 수 없는 항목(주소·장소명 모두 없음)은 호출 자체를 아낀다
  if (buildQueries(ev).length === 0) { skipped++; continue; }

  const hit = await resolveCoords(ev, { budget });
  if (hit) {
    ev.lat = hit.lat; ev.lng = hit.lng; ev.geo = hit.via;
    viaCount[hit.via] = (viaCount[hit.via] || 0) + 1;
    ok++;
  } else {
    failed++;
  }

  if ((i + 1) % 25 === 0 || i + 1 === targets.length) {
    process.stdout.write(`\r  진행 ${i + 1}/${targets.length} · 성공 ${ok} · 실패 ${failed} · 질의불가 ${skipped}   `);
  }
}
process.stdout.write('\n');

await saveCache();
await fs.writeFile(PATHS.kcisa, JSON.stringify(events), 'utf8');

const withCoord = events.filter((e) => e.lat != null).length;
console.log(`\n  보정 성공 ${ok}건  ${Object.entries(viaCount).map(([k, v]) => `${k}=${v}`).join(' ') || ''}`);
console.log(`  질의어 없음 ${skipped}건 (주소·장소명이 모두 비어 지오코딩 불가)`);
console.log(`  좌표 보유  ${withCoord}/${events.length} (${((withCoord / events.length) * 100).toFixed(1)}%)`);
if (budget.left <= 0) console.log('\n  ※ 호출 상한에 도달했습니다. 다음 실행 때 이어서 처리됩니다.');
console.log('\n✔ 완료');
