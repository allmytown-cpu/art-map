#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  ART MAP · 1단계: 공공데이터 수집 → data/events.json
//
//  공공데이터포털 「한눈에보는문화정보 조회서비스」(15138937)의
//  기간별 조회(period2)를 월 단위로 페이징하며 전부 긁어온 뒤,
//  전시/공연/축제/교육 으로 분류해 정적 JSON으로 저장한다.
//
//  실행:  DATA_GO_KR_SERVICE_KEY=xxxx node scripts/fetch-events.mjs
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import {
  API_BASE, OPERATIONS, MONTHS_AHEAD, MONTHS_BEHIND,
  ROWS_PER_PAGE, MAX_PAGES, REQUEST_DELAY_MS,
  classifyRealm, isValidKoreaCoord, PATHS,
} from './config.mjs';

const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY || process.env.SERVICE_KEY || '';
if (!SERVICE_KEY) {
  console.error('\n[오류] 서비스키가 없습니다.');
  console.error('  PowerShell:  $env:DATA_GO_KR_SERVICE_KEY="발급받은키"; npm run fetch');
  console.error('  GitHub:      Settings > Secrets > Actions 에 DATA_GO_KR_SERVICE_KEY 등록\n');
  process.exit(1);
}

// 공공데이터포털은 Decoding 키(+, /, = 포함)와 Encoding 키(%2B 등)를 둘 다 준다.
// 이미 인코딩된 키를 또 인코딩하면 인증에 실패하므로 구분해서 처리한다.
const ENCODED_KEY = /%[0-9A-Fa-f]{2}/.test(SERVICE_KEY)
  ? SERVICE_KEY
  : encodeURIComponent(SERVICE_KEY);

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,      // 날짜/좌표를 문자열 그대로 받아서 직접 처리
  processEntities: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** 파싱된 객체 트리 어디에 있든 실제 레코드 배열을 찾아낸다. */
function findRecords(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => findRecords(n, out));
    return out;
  }
  const keys = Object.keys(node);
  const looksLikeRecord =
    keys.some((k) => /^(title|TITLE)$/.test(k)) &&
    keys.some((k) => /^(seq|SEQ|startDate|START_DATE)$/.test(k));
  if (looksLikeRecord) { out.push(node); return out; }
  keys.forEach((k) => findRecords(node[k], out));
  return out;
}

/** 트리에서 totalCount 류의 숫자를 찾는다. */
function findTotalCount(node) {
  if (node === null || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (/^total(Count|_count)$/i.test(k)) {
      const n = Number(String(v).replace(/[^\d]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  for (const v of Object.values(node)) {
    const found = findTotalCount(v);
    if (found !== null) return found;
  }
  return null;
}

/** 응답에 담긴 에러 메시지를 찾아 반환 (정상이면 null) */
function findError(xmlText, tree) {
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE ERROR|SERVICE_KEY_IS_NULL/i.test(xmlText)) {
    return '서비스키가 등록되지 않았거나 잘못되었습니다 (승인 후 1시간 정도 걸릴 수 있음).';
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS/i.test(xmlText)) {
    return '일일 호출 한도를 초과했습니다.';
  }
  const codeMatch = xmlText.match(/<(?:resultCode|returnReasonCode)>\s*(\d+)\s*<\//);
  if (codeMatch && !['0', '00', '000'].includes(codeMatch[1])) {
    const msg = xmlText.match(/<(?:resultMsg|returnAuthMsg|errMsg)>([^<]*)<\//);
    return `API 오류 코드 ${codeMatch[1]}${msg ? ` (${msg[1]})` : ''}`;
  }
  return null;
}

function buildUrl(operation, { from, to, cPage, rows }) {
  // serviceKey는 이미 인코딩된 상태이므로 URLSearchParams를 쓰지 않고 직접 조립한다.
  const qs = [
    `serviceKey=${ENCODED_KEY}`,
    `from=${from}`,
    `to=${to}`,
    `cPage=${cPage}`,
    `rows=${rows}`,
    `sortStdr=1`,
  ].join('&');
  return `${API_BASE}/${operation}?${qs}`;
}

async function requestPage(operation, params, attempt = 1) {
  const url = buildUrl(operation, params);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const tree = parser.parse(text);
    const err = findError(text, tree);
    if (err) throw new Error(err);

    return { records: findRecords(tree), total: findTotalCount(tree), raw: text };
  } catch (e) {
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return requestPage(operation, params, attempt + 1);
    }
    throw e;
  }
}

// ── 필드 정규화 ──────────────────────────────────────────────
const pick = (obj, ...names) => {
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

const normDate = (s) => {
  const digits = String(s || '').replace(/[^\d]/g, '');
  if (digits.length !== 8) return '';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
};

const cleanText = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')       // 설명 필드에 섞여 오는 HTML 제거
    .replace(/&nbsp;?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const httpsify = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  // GitHub Pages는 HTTPS라 http 이미지는 혼합콘텐츠로 차단된다.
  if (s.startsWith('http://')) return 'https://' + s.slice(7);
  return s;
};

function normalize(rec) {
  const title = cleanText(pick(rec, 'title', 'TITLE'));
  if (!title) return null;

  const seq = pick(rec, 'seq', 'SEQ', 'localId') || null;
  const startDate = normDate(pick(rec, 'startDate', 'START_DATE', 'startdate'));
  const endDate = normDate(pick(rec, 'endDate', 'END_DATE', 'enddate')) || startDate;
  const realmName = cleanText(pick(rec, 'realmName', 'REALM_NAME', 'realmname'));

  // period2에서만 내려오는 좌표. gpsX = 경도, gpsY = 위도.
  let lng = parseFloat(pick(rec, 'gpsX', 'GPS_X', 'gpsx', 'longitude'));
  let lat = parseFloat(pick(rec, 'gpsY', 'GPS_Y', 'gpsy', 'latitude'));
  // 가끔 위/경도가 뒤바뀌어 들어오는 레코드가 있어 보정한다.
  if (!isValidKoreaCoord(lat, lng) && isValidKoreaCoord(lng, lat)) [lat, lng] = [lng, lat];
  const hasCoord = isValidKoreaCoord(lat, lng);

  return {
    id: seq ? `k${seq}` : `h${hash(title + startDate + pick(rec, 'place', 'PLACE'))}`,
    seq,
    title,
    subtitle: cleanText(pick(rec, 'subTitle', 'sub_title', 'SUB_TITLE')),
    category: classifyRealm(realmName),
    realm: realmName,
    start: startDate,
    end: endDate,
    place: cleanText(pick(rec, 'place', 'PLACE', 'placeName')),
    address: cleanText(pick(rec, 'placeAddr', 'place_addr', 'PLACE_ADDR', 'address')),
    area: cleanText(pick(rec, 'area', 'AREA', 'sido')),
    lat: hasCoord ? round6(lat) : null,
    lng: hasCoord ? round6(lng) : null,
    geo: hasCoord ? 'api' : null,          // 좌표 출처: api | geocode | null
    price: cleanText(pick(rec, 'price', 'PRICE', 'charge')),
    phone: cleanText(pick(rec, 'phone', 'PHONE', 'placeTel', 'tel')),
    url: httpsify(pick(rec, 'url', 'URL', 'placeUrl', 'homepage')),
    thumbnail: httpsify(pick(rec, 'thumbnail', 'THUMBNAIL', 'imgUrl', 'image')),
    desc: cleanText(pick(rec, 'contents1', 'CONTENTS1', 'contents2', 'description')).slice(0, 400),
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── 메인 ─────────────────────────────────────────────────────
async function collectRange(operation, from, to) {
  const collected = [];
  let total = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { records, total: t } = await requestPage(operation, {
      from, to, cPage: page, rows: ROWS_PER_PAGE,
    });
    if (total === null && t !== null) total = t;
    collected.push(...records);

    process.stdout.write(
      `\r  ${from}~${to}  page ${page}  (+${records.length}, 누적 ${collected.length}${total ? `/${total}` : ''})   `
    );

    if (records.length < ROWS_PER_PAGE) break;
    if (total !== null && collected.length >= total) break;
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write('\n');
  return collected;
}

async function main() {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - MONTHS_BEHIND, 1);
  const to = new Date(today.getFullYear(), today.getMonth() + MONTHS_AHEAD + 1, 0);

  console.log('━'.repeat(60));
  console.log('ART MAP · 공공데이터 수집');
  console.log(`수집 기간: ${ymd(from)} ~ ${ymd(to)}`);
  console.log('━'.repeat(60));

  // 사용 가능한 오퍼레이션을 먼저 확인 (period2 우선, 실패 시 period)
  let operation = null;
  for (const op of OPERATIONS) {
    try {
      const probe = await requestPage(op, { from: ymd(from), to: ymd(from), cPage: 1, rows: 1 });
      operation = op;
      console.log(`✔ 오퍼레이션 '${op}' 사용 (응답 확인됨)`);
      if (op === 'period') console.log('  ⚠ period2 미응답 → period 사용. 좌표 필드가 없어 지오코딩 의존도가 높아집니다.');
      break;
    } catch (e) {
      console.log(`✖ 오퍼레이션 '${op}' 실패: ${e.message}`);
    }
  }
  if (!operation) {
    console.error('\n모든 오퍼레이션 호출에 실패했습니다. 서비스키와 활용신청 상태를 확인하세요.');
    process.exit(1);
  }

  // 월 단위로 쪼개서 수집 (한 요청의 결과가 지나치게 커지는 것을 방지)
  const rawRecords = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const clamped = chunkEnd > to ? to : chunkEnd;
    rawRecords.push(...(await collectRange(operation, ymd(chunkStart), ymd(clamped))));
    cursor.setMonth(cursor.getMonth() + 1);
    cursor.setDate(1);
  }

  console.log(`\n원본 레코드: ${rawRecords.length}건`);

  // 정규화 + 중복 제거
  const byId = new Map();
  for (const rec of rawRecords) {
    const item = normalize(rec);
    if (!item) continue;
    const prev = byId.get(item.id);
    // 같은 id가 여러 번 나오면 좌표/썸네일이 있는 쪽을 남긴다.
    if (!prev || (!prev.lat && item.lat) || (!prev.thumbnail && item.thumbnail)) {
      byId.set(item.id, prev ? { ...prev, ...item } : item);
    }
  }

  // 종료일이 지난 행사는 제외
  const todayStr = ymd(today).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  let events = [...byId.values()].filter((e) => !e.end || e.end >= todayStr);
  events.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));

  const withCoord = events.filter((e) => e.lat !== null).length;
  const byCategory = events.reduce((acc, e) => ((acc[e.category] = (acc[e.category] || 0) + 1), acc), {});

  console.log(`정규화 후(중복 제거·종료 제외): ${events.length}건`);
  console.log(`좌표 보유: ${withCoord}건 (${((withCoord / Math.max(events.length, 1)) * 100).toFixed(1)}%)`);
  console.log('분야별:', byCategory);

  await fs.mkdir(path.dirname(PATHS.events), { recursive: true });
  await fs.writeFile(PATHS.events, JSON.stringify(events), 'utf8');
  await fs.writeFile(
    PATHS.meta,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        source: '공공데이터포털 · 한국문화정보원 한눈에보는문화정보 조회서비스',
        sourceUrl: 'https://www.data.go.kr/data/15138937/openapi.do',
        operation,
        range: { from: ymd(from), to: ymd(to) },
        total: events.length,
        withCoord,
        byCategory,
      },
      null,
      2
    ),
    'utf8'
  );

  const sizeKb = ((await fs.stat(PATHS.events)).size / 1024).toFixed(0);
  console.log(`\n✔ 저장 완료: ${PATHS.events} (${sizeKb} KB)`);
  console.log(`✔ 저장 완료: ${PATHS.meta}`);
}

main().catch((e) => {
  console.error('\n[실패]', e);
  process.exit(1);
});
