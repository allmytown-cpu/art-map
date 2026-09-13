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

[NCP 콘솔](https://console.ncloud.com) → **Services → AI·NAVER API → Maps → Application**
→ 사용 중인 애플리케이션의 **Web 서비스 URL**에 아래를 추가:

```
https://allmytown-cpu.github.io
http://localhost:5173
```

> 현재 코드가 쓰는 키: `index.html`의 `ncpKeyId=ldzn2y3ng1`

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
│   ├── meta.json                 갱신 시각·건수 등 메타정보
│   └── geocode-cache.json        지오코딩 결과 캐시 (재호출 방지)
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

## 데이터 관련 알아둘 점

- 원본 API의 `gpsX`/`gpsY`가 **비어 있는 레코드가 상당수** 있습니다. 이런 항목은 주소로 좌표를 추정하며,
  상세 화면에 "추정 위치" 안내가 표시됩니다. 끝내 못 찾은 항목은 목록에만 나오고 지도에는 없습니다.
- `realmName` 값의 표기가 일정하지 않아 `scripts/config.mjs`의 `CATEGORY_RULES`에서
  **키워드 포함 여부**로 분류합니다. 분류가 어색하면 이 규칙만 고치면 됩니다.
- 종료일이 지난 행사는 수집 단계에서 제외됩니다.

---

## 출처

데이터: 공공데이터포털 · 한국문화정보원 「한눈에보는문화정보 조회서비스」
지도: NAVER Maps API v3
