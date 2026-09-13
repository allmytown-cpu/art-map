// ─────────────────────────────────────────────────────────────
//  전시 페이지 URL → 우리 스키마
//
//  1) 사이트별 어댑터 (정확)   : art-map.co.kr 처럼 구조가 일정한 곳
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
];

export async function extractFromUrl(url) {
  const { html, finalUrl } = await fetchHtml(url);
  const host = new URL(finalUrl).hostname;

  const chain = [];
  for (const a of ADAPTERS) if (a.host.test(host)) chain.push(a.fn);
  chain.push(jsonLdAdapter, genericAdapter);

  const tried = [];
  for (const fn of chain) {
    let r = null;
    try { r = fn(html, finalUrl); } catch (e) { tried.push(`${fn.name}: ${e.message}`); continue; }
    if (r && r.title) {
      r.sourceUrl = finalUrl;
      r.tried = tried;
      return r;
    }
    tried.push(`${fn.name}: 추출 실패`);
  }
  throw new Error('전시 정보를 추출하지 못했습니다.\n  ' + tried.join('\n  '));
}
