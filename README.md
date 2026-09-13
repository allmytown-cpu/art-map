# ART MAP · 내 주변 전시·공연 지도

공공데이터포털 [한눈에보는문화정보 조회서비스](https://www.data.go.kr/data/15138937/openapi.do)를 기반으로
전국의 **전시·공연·축제·교육행사**를 네이버 지도에 올리고, **내 GPS 위치에서 가까운 순**으로 보여주는
웹사이트 + 설치형 앱(PWA)입니다.

🔗 **배포 주소**: https://allmytown-cpu.github.io/art-map/

---

## 어떻게 동작하나

공공데이터포털 API는 브라우저에서 직접 호출할 수 없습니다. (CORS 미지원, 서비스키 노출)
그래서 **GitHub Actions가 서버 역할**을 대신합니다.

```
  ┌─ GitHub Actions (매일 06:10 KST 자동 실행) ─────────────┐
  │  1. period2 API 호출 (서비스키는 Secrets에 보관)        │
  │  2. XML → JSON 변환 · 분야 분류 · 중복 제거             │
  │  3. 좌표 없는 항목은 주소로 지오코딩 보완               │
  │  4. data/events.json 커밋                               │
  └──────────────────────────┬──────────────────────────────┘
                             ↓ (커밋 감지 → 자동 재배포)
  ┌─ GitHub Pages (정적 호스팅, 무료) ──────────────────────┐
  │  index.html + 네이버 지도 → 마커 · 클러스터링           │
  │  navigator.geolocation → 가까운 순 정렬                 │
  └─────────────────────────────────────────────────────────┘
```

서버·데이터베이스 비용이 들지 않고, 서비스키가 프론트엔드에 노출되지 않으며,
사용자는 API를 기다리지 않고 정적 JSON을 바로 받으므로 로딩도 빠릅니다.

---

## 최초 설정 (한 번만)

### 1. GitHub Secrets 등록

저장소 → **Settings → Secrets and variables → Actions → New repository secret**

| 이름 | 값 | 필수 |
|---|---|:---:|
| `DATA_GO_KR_SERVICE_KEY` | 공공데이터포털 마이페이지의 **일반 인증키(Decoding)** | ✅ |
| `NCP_APIGW_KEY_ID` | 네이버 클라우드 플랫폼 API Gateway Access Key ID | 선택 |
| `NCP_APIGW_KEY` | 네이버 클라우드 플랫폼 Secret Key | 선택 |

> `NCP_*`는 **Geocoding**(주소→좌표) 용입니다. 없으면 OpenStreetMap Nominatim으로 대체하지만
> 초당 1회 제한이라 한 번에 200건씩만 처리됩니다(며칠에 걸쳐 자동 누적).

### 2. GitHub Pages 활성화

**Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `/ (root)`**

### 3. 네이버 지도 도메인 등록

[NCP 콘솔](https://console.ncloud.com) → **Services → Maps → Application**
→ 애플리케이션 `art-map`(Key ID: `ior0d6uleb`)의 **Web 서비스 URL**에 아래가 등록되어 있어야 합니다:

```
https://allmytown-cpu.github.io
http://localhost:5173
```

> - 코드에서 쓰는 위치: `index.html`의 `ncpKeyId=ior0d6uleb`
> - 도메인만 등록합니다. 끝에 `/`나 `/art-map` 같은 경로는 붙이지 마세요.
> - 인증에 실패하면 화면에 "네이버 지도 인증 실패" 안내가 뜹니다(`navermap_authFailure`).

### 4. 첫 데이터 수집 실행

**Actions → 데이터 갱신 → Run workflow**

---

## 로컬 개발

```powershell
npm install

# 데이터 수집 (서비스키 필요)
$env:DATA_GO_KR_SERVICE_KEY = "발급받은_Decoding_키"
npm run fetch          # data/events.json 생성
npm run geocode        # 좌표 없는 항목 보정 (선택)

# 미리보기  →  http://localhost:5173
npm run serve
```

> `index.html`을 파일로 직접 열면(`file://`) 브라우저가 `fetch`를 막아 데이터가 표시되지 않습니다.
> 반드시 `npm run serve`를 사용하세요.

---

## 파일 구조

```
art-map/
├── index.html                    앱 본체 (마크업)
├── assets/
│   ├── app.js                    지도·필터·GPS 정렬 로직
│   ├── style.css                 스타일 (모바일 우선)
│   └── icon.svg                  앱 아이콘
├── data/
│   ├── events.json               ← Actions가 매일 생성 (직접 수정 X)
│   ├── meta.json                 갱신 시각·건수·분야 분포
│   ├── detail-cache.json         detail2 응답 캐시 (seq 기준, 재호출 방지)
│   └── geocode-cache.json        지오코딩 결과 캐시
├── scripts/
│   ├── config.mjs                API 주소·분야 분류 규칙
│   ├── fetch-events.mjs          1단계: 공공데이터 수집
│   ├── geocode.mjs               2단계: 좌표 보정
│   └── serve.mjs                 로컬 미리보기 서버
├── .github/workflows/
│   └── update-data.yml           매일 자동 갱신
├── manifest.webmanifest          PWA 설치 정보
└── sw.js                         서비스 워커 (오프라인 캐시)
```

---

## 주요 기능

- **분야 필터** — 전시·미술 / 공연 / 축제·행사 / 교육·체험 / 기타
- **내 위치 기준 정렬** — 📍 버튼 → GPS 허용 시 가까운 순으로 목록 재정렬, 거리 표시
- **이 지역만 보기** — 🔄 버튼 → 지도를 움직일 때마다 화면 안의 행사만 표시
- **검색** — 행사명·장소·지역 통합 검색
- **마커 클러스터링** — 전국 수천 건도 부담 없이 렌더링
- **PWA** — 모바일 브라우저에서 "홈 화면에 추가" 시 앱처럼 실행
- **오프라인 지원** — 마지막으로 받은 데이터는 네트워크 없이도 열람 가능

---

## 이 API를 다룰 때 주의할 점 (실측으로 확인함)

공식 개발가이드(culture.go.kr)의 내용이 현행과 다릅니다. 아래는 직접 호출해 확인한 사실입니다.

| 항목 | 실제 동작 |
|---|---|
| Base URL | `https://apis.data.go.kr/B553457/cultureinfo` |
| 폐기된 주소 | `~/nopenapi/rest/publicperformancedisplays/*` → **전부 404** (`NO_OPENAPI_SERVICE_ERROR`) |
| 오퍼레이션 | `period2` `area2` `realm2` `detail2` `livelihood2` — **`2` 없는 구버전은 전부 폐기** |
| 페이지 번호 | **`PageNo`** (대문자 P). `cPage`·`pageNo`는 **무시됨** |
| 페이지 크기 | **10 고정.** `rows`·`numOfRows`·`perPage` 모두 **무시됨** |
| `from`/`to` | **`startDate`가 아니라 `endDate` 기준**으로 필터링됨 |
| 좌표 | `gpsX`=경도, `gpsY`=위도. 약 14%가 빈 문자열 |
| 썸네일 | `http://`로 내려옴 → HTTPS 페이지에서 차단되므로 변환 필수 |
| 엔티티 | **이중 인코딩**되어 옴 (`&amp;#39;` → `&#39;` → `'`). 두 번 디코딩해야 함 |
| 목록 vs 상세 | 주소·요금·전화·설명·홈페이지는 목록에 없고 `detail2`에만 있음 (1건당 1요청) |

`from`/`to`가 `endDate` 기준이라는 점이 특히 중요합니다.
"아직 끝나지 않은 행사 전체"를 받으려면 `from=오늘`, `to=먼 미래`로 **한 번에** 조회해야 합니다.
기간을 월 단위로 쪼개면 오히려 누락이 생깁니다.

### 좌표가 없는 항목

전체의 약 14%(160건 내외)는 좌표가 없습니다. 그런데 이들 대부분은
**주소도 장소명도 비어 있고 시도명만 있는** 상설 프로그램(`2026년 체험교육 프로그램` 등)이라
지오코딩으로도 위치를 찾을 수 없습니다. 분야별로 보면 교육·체험과 축제에 몰려 있고,
**전시는 297건 중 297건이 좌표를 가지고 있어** 이 앱의 주 용도에는 영향이 없습니다.

보정은 3단계로 시도합니다.
1. `detail2`의 좌표
2. **같은 장소에서 열리는 다른 행사의 좌표를 재사용** (API 호출 없음)
3. 주소·장소명 지오코딩 (`scripts/geocode.mjs`)

끝내 못 찾은 항목은 목록에는 나오지만 지도에는 표시되지 않으며, 상세 화면에 그 사실을 안내합니다.

### 호출량

- 목록: 총건수 ÷ 10 페이지 (현재 약 114회)
- 상세: 캐시에 없는 신규 행사만. 첫 실행은 약 1,140회, 이후는 하루 수십 회 수준
- 개발계정 일일 한도가 10,000회이므로 충분합니다. `DETAIL_BUDGET`으로 실행당 상한을 조절할 수 있습니다.

### 분야 분류

`realmName`(예: `음악/콘서트`, `뮤지컬/오페라`, `전시`, `교육/체험`)을 우선 사용하고,
값이 없거나 매칭되지 않으면 `serviceName`(`전시`/`공연`/`교육_체험`/`행사/축제`)으로 보완합니다.
규칙은 `scripts/config.mjs`의 `CATEGORY_RULES` 한 곳에만 있습니다.

---

## 출처

데이터: 공공데이터포털 · 한국문화정보원 「한눈에보는문화정보 조회서비스」
지도: NAVER Maps API v3
