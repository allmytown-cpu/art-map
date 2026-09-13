// ─────────────────────────────────────────────────────────────
//  외부 웹페이지 가져오기 (한국 사이트 대응)
// ─────────────────────────────────────────────────────────────
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * HTML을 가져와 문자열로 반환한다.
 * 국내 사이트는 아직 EUC-KR을 쓰는 곳이 있어 인코딩을 직접 판별한다.
 */
export async function fetchHtml(url, { timeout = 25000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const buf = await res.arrayBuffer();
  let charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1];

  let html = new TextDecoder('utf-8').decode(buf);
  if (!charset) {
    charset = html.slice(0, 2000).match(/charset=["']?([\w-]+)/i)?.[1];
  }
  if (charset && !/^utf-?8$/i.test(charset)) {
    try { html = new TextDecoder(charset).decode(buf); } catch { /* utf-8 결과 유지 */ }
  }
  return { html, finalUrl: res.url };
}

/** 상대 경로를 절대 URL로 */
export function absoluteUrl(src, base) {
  if (!src) return '';
  try { return new URL(src, base).href; } catch { return ''; }
}
