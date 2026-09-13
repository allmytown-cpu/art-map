// ─────────────────────────────────────────────────────────────
//  ART MAP - 데이터 수집 공통 설정
//
//  대상 API: 공공데이터포털 「한눈에보는문화정보 조회서비스」(15138937)
//  주의) culture.go.kr 개발가이드에 적힌 구 주소
//        (nopenapi/rest/publicperformancedisplays/period)는 폐기되었다.
//        실제로 살아있는 것은 아래 base + '2'가 붙은 오퍼레이션뿐이다.
// ─────────────────────────────────────────────────────────────

export const API_BASE = 'https://apis.data.go.kr/B553457/cultureinfo';
export const OP_LIST = 'period2';   // 기간별 목록
export const OP_DETAIL = 'detail2'; // 상세 (주소·요금·전화·설명)

// ── 이 API의 함정들 (실측으로 확인함) ────────────────────────
//  · from/to 는 startDate가 아니라 **endDate** 기준으로 필터링된다.
//    → 아직 끝나지 않은 행사를 모두 받으려면 from=오늘, to=먼 미래.
//  · 페이지 크기는 10 고정. rows / numOfRows / perPage 모두 무시된다.
//  · 페이지 번호 파라미터는 PageNo (대문자 P). cPage·pageNo는 무시된다.
export const PAGE_SIZE = 10;        // 서버 고정값. 변경 불가.
export const PAGE_PARAM = 'PageNo';

// 수집 범위: 오늘 ~ N년 뒤에 끝나는 행사까지
export const YEARS_AHEAD = 4;

export const MAX_PAGES = 3000;      // 안전장치 (무한루프 방지)
export const REQUEST_DELAY_MS = 90; // 요청 간 간격
// 공공데이터포털은 간헐적으로 연결을 끊는다(undici 'fetch failed').
// 수백 번 요청하는 동안 한 번만 실패해도 전체가 중단되므로 재시도를 넉넉히 둔다.
export const MAX_RETRY = 6;

// 상세정보 보강: 1건당 1요청이라 실행당 상한을 둔다.
// 결과는 data/detail-cache.json에 캐시되어 다음 실행 때 재사용된다.
export const DETAIL_BUDGET = Number(process.env.DETAIL_BUDGET || 1600);

// ── 분야 분류 ────────────────────────────────────────────────
// realmName 실측값: 전시, 교육/체험, 뮤지컬/오페라, 연극, 음악/콘서트,
//                   행사/축제, 국악, 아동/가족, 기타, 무용/발레, 영화, 미술
// serviceName 실측값: 전시, 공연, 교육/체험, 행사/축제
//   → realmName이 더 정확한 편이라 우선 사용하고, 없으면 serviceName으로 보완.
export const CATEGORY_RULES = [
  { id: 'exhibition',  label: '전시·미술', color: '#C2185B', emoji: '🎨',
    match: ['전시', '미술', '조각', '공예', '사진', '디자인', '건축'] },
  { id: 'education',   label: '교육·체험', color: '#2E9E5B', emoji: '🧑‍🏫',
    match: ['교육', '체험', '강좌', '워크숍', '워크샵'] },
  { id: 'performance', label: '공연',      color: '#4472C4', emoji: '🎭',
    match: ['공연', '음악', '콘서트', '연극', '뮤지컬', '오페라', '무용', '발레',
            '국악', '클래식', '아동', '가족', '영화', '서커스', '마술', '대중'] },
  { id: 'festival',    label: '축제·행사', color: '#F57C00', emoji: '🎪',
    match: ['축제', '행사', '문학', '페스티벌'] },
];
export const DEFAULT_CATEGORY = 'etc';

export function classify(realmName, serviceName) {
  for (const source of [realmName, serviceName]) {
    const s = String(source || '').trim();
    if (!s) continue;
    for (const rule of CATEGORY_RULES) {
      if (rule.match.some((k) => s.includes(k))) return rule.id;
    }
  }
  return DEFAULT_CATEGORY;
}

// ── 좌표 검증 ────────────────────────────────────────────────
export const KOREA_BOUNDS = { minLat: 32.5, maxLat: 39.6, minLng: 124.0, maxLng: 132.5 };

export function isValidKoreaCoord(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = KOREA_BOUNDS;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

// ── 텍스트 정리 ──────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 이 API는 엔티티가 이중 인코딩되어 온다: `&amp;#39;` → `&#39;` → `'` */
export function decodeEntities(str) {
  let s = String(str == null ? '' : str);
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&([a-zA-Z]+);/g, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
  }
  return s;
}

/**
 * 제목에 `<언디스커버리 : FESTA>` 같은 꺾쇠가 정상 내용으로 들어있으므로
 * 태그 제거는 `<영문자로 시작하는 것`만 대상으로 한다.
 */
export function cleanText(str, { stripTags = false } = {}) {
  let s = decodeEntities(str);
  if (stripTags) s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** GitHub Pages는 HTTPS라 http 이미지는 혼합콘텐츠로 차단된다. */
export function httpsify(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
}

export const PATHS = {
  // 소스별 원본 (수집 단계 산출물)
  kcisa: 'data/sources/kcisa.json',
  manual: 'data/sources/manual.json',
  // 병합 결과 (프론트엔드가 읽는 파일)
  events: 'data/events.json',
  meta: 'data/meta.json',
  // 캐시
  geocodeCache: 'data/geocode-cache.json',
  detailCache: 'data/detail-cache.json',
};
