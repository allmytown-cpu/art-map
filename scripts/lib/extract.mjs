// ─────────────────────────────────────────────────────────────
//  전시 페이지 URL → 우리 스키마
//
//  1) 사이트별 어댑터 (정확)   : art-map.co.kr, opengallery.co.kr
//  2) 범용 추출 (부정확)       : JSON-LD schema.org Event → OpenGraph → 휴리스틱
//
//  범용 추출은 성공률이 낮다. 디자인 위주 사이트(미술관 자체 홈페이지)는
//  대부분 실패하거나 엉뚱한 값을 집으므로, 결과는 반드시 사람이 확인해야 한다.
// ─────────────────────────────────────────────────────────────
import { fetchHtml, absoluteUrl } from './http.mjs';
import { cleanText, httpsify } from '../config.mjs';

// ── HTML 유틸 ────────────────────────────────────────────────
const stripTags = (s) => cleanText(String(s || '').replace(/<[^>]+>/g, ' '));

function meta(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  return cleanText((html.match(re1) || html.match(re2) || [])[1] || '');
}

/** "2026-08-28 - 2026-09-17", "2026.8.28 ~ 9.17" 등을 [시작, 종료]로 */
export function parseDateRange(text) {
  const s = String(text || '').replace(/\s+/g, ' ');

  // 연도가 양쪽에 다 있는 경우
  let m = s.match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})\s*일?\s*[~\-–—]+\s*(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) return [iso(m[1], m[2], m[3]), iso(m[4], m[5], m[6])];

  // 종료 쪽 연도가 생략된 경우
  m = s.match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})\s*일?\s*[~\-–—]+\s*(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) {
    const start = iso(m[1], m[2], m[3]);
    let year = Number(m[1]);
    // 종료 월이 시작 월보다 작으면 해를 넘긴 것
    if (Number(m[4]) < Number(m[2])) year += 1;
    return [start, iso(year, m[4], m[5])];
  }

  // 단일 날짜
  m = s.match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) { const d = iso(m[1], m[2], m[3]); return [d, d]; }

  return [null, null];
}

function iso(y, mo, d) {
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (!Y || !M || !D || M > 12 || D > 31) return null;
  return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}

// ── 어댑터: art-map.co.kr ────────────────────────────────────
function artmapAdapter(html, url) {
  const table = (html.match(/<table[^>]*id=["']view_table["'][\s\S]*?<\/table>/i) || [])[0];
  if (!table) return null;

  const rows = {};
  const links = {};
  for (const r of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = (r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1];
    const td = (r[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1];
    if (!th) continue;
    const label = stripTags(th).replace(/\|/g, '').trim();
    rows[label] = stripTags(td || '');
    const href = td && (td.match(/href=["']([^"']+)["']/) || [])[1];
    if (href) links[label] = absoluteUrl(href, url);
  }

  // 제목은 .container 의 첫 자식 div.
  // font-size:26px 로 찾으면 문의 팝업("아트맵에 문의하기")을 먼저 집으므로
  // 반드시 컨테이너를 기준으로 잡아야 한다.
  const title = stripTags(
    (html.match(/<div class=["']container["'][^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || ''
  );
  if (!title) return null;

  const [start, end] = parseDateRange(rows['기간'] || '');
  const poster = (html.match(/<div class=["']img_wrap["']>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i) || [])[1];

  // "아원아트센터/서울" → 장소 / 지역
  const placeRaw = rows['장소'] || '';
  const [placeName, areaName] = placeRaw.split('/').map((s) => s.trim());

  const descParts = [];
  if (rows['작가']) descParts.push('참여작가: ' + rows['작가']);
  if (rows['시간']) descParts.push('관람시간: ' + rows['시간']);
  if (rows['휴관']) descParts.push('휴관: ' + rows['휴관']);

  return {
    adapter: 'art-map.co.kr',
    title,
    category: 'exhibition',
    realm: '전시',
    start,
    end,
    place: placeName || '',
    area: areaName || '',
    sigungu: '',
    address: rows['주소'] || '',
    price: rows['관람료'] || '',
    phone: rows['전화번호'] || '',
    url: links['사이트'] || url,
    thumbnail: httpsify(absoluteUrl(poster, url)),
    desc: cleanText(descParts.join(' / ')).slice(0, 500),
  };
}

// ── 어댑터: opengallery.co.kr ────────────────────────────────
function opengalleryAdapter(html, url) {
  const table = (html.match(/<table[^>]*class=["'][^"']*exhibitionDetail-infoTable-table[^"']*["'][\s\S]*?<\/table>/i) || [])[0];

  const rows = {};
  if (table) {
    for (const r of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const th = (r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1];
      const td = (r[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1];
      if (!th) continue;
      // 작가 셀은 이름마다 줄바꿈+쉼표가 섞여 오므로 공백을 정리한다
      rows[stripTags(th)] = stripTags(td || '').replace(/\s*,\s*/g, ', ').replace(/,\s*$/, '');
    }
  }

  // 위치 정보 섹션: 갤러리명 + 주소
  const locName = stripTags((html.match(/class=["'][^"']*exhibitionDetail-location-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
  const locAddr = stripTags(
    (html.match(/exhibitionDetail-location-name[^"']*["'][^>]*>[\s\S]*?<div class=["'][^"']*exhibitionDetail-sm[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || ''
  );

  let title = meta(html, 'og:title') ||
    stripTags((html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '');
  if (!title) return null;

  // 등록자가 보도자료를 그대로 붙여넣어 "[출처] …" 같은 꼬리가 섞여 오는 경우가 있다
  title = title.split(/\s*\[출처\]|\s*출처\s*[:：]/)[0].trim();

  const place = rows['장소'] || locName;
  // 제목이 "전시명 | 갤러리명" 형태로 오는데 장소는 따로 있으므로 꼬리를 뗀다
  if (place) {
    const tail = new RegExp('\\s*[|｜]\\s*' + place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
    title = title.replace(tail, '').trim();
  }

  // og:description = "[서울] 소슬금 갤러리 | 2026-08-31 ~ 2026-09-20"
  const ogDesc = meta(html, 'og:description');
  const area = (ogDesc.match(/^\[([^\]]+)\]/) || [])[1] || '';

  const [start, end] = parseDateRange(rows['기간'] || ogDesc);
  if (!start) return null;   // 기간을 못 읽으면 이 어댑터로는 실패 처리

  const descParts = [];
  if (rows['작가']) descParts.push('참여작가: ' + rows['작가']);
  if (rows['시간']) descParts.push('관람시간: ' + rows['시간']);

  return {
    adapter: 'opengallery.co.kr',
    title,
    category: 'exhibition',
    realm: '전시',
    start,
    end,
    place,
    area,
    sigungu: '',
    address: locAddr,
    price: rows['관람료'] || '',
    phone: rows['문의'] || rows['전화'] || '',
    url,
    thumbnail: httpsify(absoluteUrl(meta(html, 'og:image'), url)),
    desc: cleanText(descParts.join(' / ')).slice(0, 500),
  };
}

// ── 범용: JSON-LD schema.org ─────────────────────────────────
function jsonLdAdapter(html, url) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const nodes = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      collect(parsed, nodes);
    } catch { /* 깨진 JSON-LD는 무시 */ }
  }

  const ev = nodes.find((n) => {
    const t = [].concat(n['@type'] || []);
    return t.some((x) => /Event|Exhibition/i.test(String(x)));
  });
  if (!ev || !ev.name) return null;

  const loc = ev.location || {};
  const addr = loc.address;
  const address = typeof addr === 'string'
    ? addr
    : [addr?.addressRegion, addr?.addressLocality, addr?.streetAddress].filter(Boolean).join(' ');

  const img = Array.isArray(ev.image) ? ev.image[0] : ev.image;

  return {
    adapter: 'json-ld',
    title: cleanText(ev.name),
    category: 'exhibition',
    realm: '전시',
    start: (ev.startDate || '').slice(0, 10) || null,
    end: (ev.endDate || ev.startDate || '').slice(0, 10) || null,
    place: cleanText(loc.name || ''),
    area: cleanText(addr?.addressRegion || ''),
    sigungu: cleanText(addr?.addressLocality || ''),
    address: cleanText(address || ''),
    price: cleanText(ev.offers?.price !== undefined ? String(ev.offers.price) : ''),
    phone: cleanText(loc.telephone || ''),
    url: ev.url || url,
    thumbnail: httpsify(absoluteUrl(typeof img === 'string' ? img : img?.url, url)),
    desc: cleanText(ev.description || '', { stripTags: true }).slice(0, 500),
  };
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
  if (node['@type']) out.push(node);
  if (node['@graph']) collect(node['@graph'], out);
}

// ── 범용: OpenGraph + 본문 휴리스틱 ──────────────────────────
function genericAdapter(html, url) {
  const title = meta(html, 'og:title') ||
    cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '') ||
    cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!title) return null;

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const [start, end] = parseDateRange(cleanText(text));

  return {
    adapter: 'generic(og)',
    title,
    category: 'exhibition',
    realm: '전시',
    start,
    end,
    place: '',
    area: '',
    sigungu: '',
    address: '',
    price: '',
    phone: '',
    url,
    thumbnail: httpsify(absoluteUrl(meta(html, 'og:image'), url)),
    desc: cleanText(meta(html, 'og:description')).slice(0, 500),
  };
}

// ── 진입점 ───────────────────────────────────────────────────
const ADAPTERS = [
  { host: /(^|\.)art-map\.co\.kr$/i, fn: artmapAdapter },
  { host: /(^|\.)opengallery\.co\.kr$/i, fn: opengalleryAdapter },
];

export async function extractFromUrl(url) {
  const { html, finalUrl } = await fetchHtml(url);
  const host = new URL(finalUrl).hostname;

  const dedicated = ADAPTERS.filter((a) => a.host.test(host));

  // 전용 어댑터가 있는 사이트에서 그 어댑터가 실패하면,
  // 범용 추출로 내려가면 안 된다. 사이트 공통 og:title("ARTMAP | Art is
  // Everywhere" 같은)을 전시명으로 집어 쓰레기 데이터를 만들기 때문이다.
  // 어댑터 실패 = 그 URL이 전시 상세 페이지가 아니라는 신호로 본다.
  if (dedicated.length) {
    for (const a of dedicated) {
      const r = a.fn(html, finalUrl);
      if (r && r.title) { r.sourceUrl = finalUrl; return r; }
    }
    throw new Error(
      `${host} 의 전시 상세 페이지 형식이 아닙니다.\n` +
      '  (삭제되었거나 URL이 잘못되었을 수 있습니다)'
    );
  }

  const tried = [];
  for (const fn of [jsonLdAdapter, genericAdapter]) {
    let r = null;
    try { r = fn(html, finalUrl); } catch (e) { tried.push(`${fn.name}: ${e.message}`); continue; }
    if (r && r.title) { r.sourceUrl = finalUrl; return r; }
    tried.push(`${fn.name}: 추출 실패`);
  }
  throw new Error('전시 정보를 추출하지 못했습니다.\n  ' + tried.join('\n  '));
}
