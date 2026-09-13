// ─────────────────────────────────────────────────────────────
//  ART MAP - 데이터 수집 공통 설정
// ─────────────────────────────────────────────────────────────

// 공공데이터포털 · 한국문화정보원 「한눈에보는문화정보 조회서비스」(15138937)
export const API_BASE =
  'https://apis.data.go.kr/B553457/nopenapi/rest/publicperformancedisplays';

// period2 = 기간별 조회(확장판). 좌표(gpsX/gpsY)·요금·URL 등 추가 필드 포함.
// 혹시 period2가 응답하지 않으면 period로 자동 폴백한다.
export const OPERATIONS = ['period2', 'period'];

// 수집 범위: 오늘부터 N개월 뒤까지 (진행중 + 예정)
export const MONTHS_AHEAD = 3;
// 이미 시작했지만 아직 끝나지 않은 행사를 놓치지 않으려고 과거도 조금 본다.
export const MONTHS_BEHIND = 2;

// 한 번에 가져올 행 수 (API 최대치는 보통 100)
export const ROWS_PER_PAGE = 100;
// 안전장치: 이 이상은 요청하지 않음 (무한루프 방지)
export const MAX_PAGES = 400;
// 요청 간 간격(ms). 공공데이터포털 과도한 호출 방지.
export const REQUEST_DELAY_MS = 120;

// ── 분야(realmName) → 앱 카테고리 매핑 ────────────────────────
// API의 realmName 값은 표기가 들쭉날쭉해서 "포함 여부"로 판정한다.
export const CATEGORY_RULES = [
  { id: 'exhibition', label: '전시·미술', color: '#C2185B', emoji: '🎨',
    match: ['전시', '미술', '조각', '공예', '사진', '디자인', '건축'] },
  { id: 'performance', label: '공연',      color: '#4472C4', emoji: '🎭',
    match: ['음악', '연극', '무용', '국악', '뮤지컬', '오페라', '콘서트',
            '클래식', '대중음악', '서커스', '마술', '영화', '공연'] },
  { id: 'festival',    label: '축제·행사', color: '#F57C00', emoji: '🎪',
    match: ['축제', '행사', '문학', '축제-기타', '축제-문화/예술'] },
  { id: 'education',   label: '교육·체험', color: '#2E9E5B', emoji: '🧑‍🏫',
    match: ['교육', '체험', '강좌', '워크숍', '워크샵'] },
];
export const DEFAULT_CATEGORY = 'etc';
export const CATEGORY_ETC = { id: 'etc', label: '기타', color: '#757575', emoji: '📌' };

export function classifyRealm(realmName = '') {
  const s = String(realmName).trim();
  if (!s) return DEFAULT_CATEGORY;
  for (const rule of CATEGORY_RULES) {
    if (rule.match.some((k) => s.includes(k))) return rule.id;
  }
  return DEFAULT_CATEGORY;
}

// ── 대한민국 영역 밖 좌표는 잘못된 데이터로 간주 ──────────────
export const KOREA_BOUNDS = { minLat: 32.5, maxLat: 39.6, minLng: 124.0, maxLng: 132.5 };

export function isValidKoreaCoord(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const b = KOREA_BOUNDS;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

export const PATHS = {
  events: 'data/events.json',
  meta: 'data/meta.json',
  geocodeCache: 'data/geocode-cache.json',
};
