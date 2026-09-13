# ART MAP · 내 주변 전시·공연 지도

공공데이터와 전시 정보 사이트를 모아 **전국의 전시·공연·축제·교육행사**를 네이버 지도에 올리고,
**내 위치에서 가까운 순**으로 보여주는 웹사이트 + 설치형 앱(PWA)입니다.

🔗 **https://allmytown-cpu.github.io/art-map/**
🛠 **관리자(전시 추가)**: https://allmytown-cpu.github.io/art-map/admin.html

---

## 어떻게 동작하나

서버도 데이터베이스도 없습니다. **GitHub Actions가 서버 역할**을 대신합니다.

```
 ┌─ GitHub Actions ────────────────────────────────────────────┐
 │  매일 06:10   공공데이터포털 API      → sources/kcisa.json   │
 │  매주 월요일  art-map.co.kr 크롤      → sources/artmap.json  │
 │  수시(수동)   링크 하나 추가          → sources/manual.json  │
 │                        ↓                                     │
 │              build-events.mjs (병합·중복제거)                │
 │                        ↓                                     │
 │                  data/events.json  커밋                      │
 └────────────────────────┬────────────────────────────────────┘
                          ↓ 커밋 감지 → 자동 재배포
 ┌─ GitHub Pages ──────────────────────────────────────────────┐
 │  index.html + 네이버 지도 → 마커 · 클러스터링                │
 │  navigator.geolocation → 가까운 순 정렬                      │
 └─────────────────────────────────────────────────────────────┘
```

공공데이터 API는 브라우저에서 직접 못 부릅니다(CORS 미지원, 서비스키 노출).
그래서 수집을 Actions에서 하고, 프론트엔드는 **정적 JSON 하나만** 읽습니다.
비용 0원, 키 노출 0, 로딩도 빠릅니다.

---

## 데이터 소스

| 소스 | 주기 | 건수 | 특징 |
|---|---|---|---|
| 공공데이터포털 [한눈에보는문화정보](https://www.data.go.kr/data/15138937/openapi.do) | 매일 | ~1,140 | 전국 공연·전시·축제·교육 |
| [art-map.co.kr](https://art-map.co.kr) | 매주 | ~30 | 사립·상업 갤러리 전시. 좌표 포함 |
| 직접 추가 | 수시 | — | 관리자 페이지에서 링크 또는 수동 입력 |

현재 **약 1,160건 · 좌표 보유 87%**.
좌표가 없는 항목은 목록에는 나오되 지도에는 표시되지 않습니다.

---

## 주요 기능

- **분야 필터** — 전시·미술 / 공연 / 축제·행사 / 교육·체험 / 기타 (건수 실시간 표시)
- **내 위치 기준 정렬** — 📍 버튼 → 가까운 순 재정렬, 거리 표시(`330m`, `4.2km`)
- **이 지역만 보기** — 🔄 버튼 → 지도 화면 안의 행사만
- **통합 검색** — 행사명·장소·지역
- **마커 클러스터링** — 천 건 단위도 부담 없이
- **PWA** — "홈 화면에 추가" 시 앱처럼 실행, 오프라인 열람 가능

---

## 전시 추가하기 (관리자)

https://allmytown-cpu.github.io/art-map/admin.html

### 1. 최초 1회 — GitHub 토큰

[Fine-grained token 발급](https://github.com/settings/personal-access-tokens/new)

- **Repository access**: `Only select repositories` → `art-map`
- **Permissions → Repository permissions → Actions**: `Read and write`
- 나머지는 전부 `No access` (`Metadata: Read-only`는 자동)

발급한 토큰을 관리자 페이지 1번 칸에 붙여넣고 저장합니다.
토큰은 **그 브라우저에만** 저장되며 서버로 전송되지 않습니다.

### 2. 전시 추가

| 링크 종류 | 방법 |
|---|---|
| `art-map.co.kr` | URL만 붙여넣기 → 자동 추출 |
| `opengallery.co.kr` | URL만 붙여넣기 → 자동 추출 |
| 그 외 사이트 | URL + `직접 입력` 펼쳐서 값 채우기 |
| 링크 자체가 없음 | URL 비우고 `직접 입력`만 |

**직접 입력 시 최소 항목**: 제목 · 시작일 · 종료일 · (장소명 **또는** 주소)

> **주소를 넣으면 위도·경도는 자동으로 찾습니다.** 좌표를 직접 칠 필요 없습니다.
> 도로명+건물번호까지 쓰면 정확도가 가장 높습니다. (예: `서울 종로대로 152`)

추가 후 지도 반영까지 **약 60~90초** 걸립니다(GitHub Pages 재배포).
관리자 페이지가 진행 상황을 실시간으로 보여주고, 반영되면 알려줍니다.

목록에서 잘못 들어간 항목은 **[삭제]** 할 수 있습니다.

---

## 로컬 개발

```powershell
npm install

$env:DATA_GO_KR_SERVICE_KEY = "공공데이터 Decoding 키"
$env:NCP_APIGW_KEY_ID       = "ior0d6uleb"
$env:NCP_APIGW_KEY          = "NCP Client Secret"

npm run fetch      # 공공데이터 → sources/kcisa.json
npm run geocode    # 좌표 보정
npm run build      # 소스 병합 → data/events.json
npm run serve      # http://localhost:5173

npm run add -- "https://art-map.co.kr/exhibition/view.php?idx=32424" --dry
node scripts/sources/artmap.mjs
```

> `index.html`을 `file://`로 직접 열면 브라우저가 `fetch`를 막아 데이터가 안 뜹니다.
> 반드시 `npm run serve`를 쓰세요.
>
> PowerShell에서 한글이 깨지면:
> `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`

---

## 파일 구조

```
art-map/
├── index.html                 지도 앱
├── admin.html                 관리자 (전시 추가/삭제)
├── assets/
│   ├── app.js                 지도·필터·GPS 정렬
│   ├── style.css
│   └── icon.svg
├── data/
│   ├── events.json            ← 프론트엔드는 이것만 읽음 (직접 수정 금지)
│   ├── meta.json              갱신 시각·건수·분야 분포
│   ├── sources/
│   │   ├── kcisa.json         공공데이터
│   │   ├── artmap.json        art-map.co.kr
│   │   └── manual.json        직접 추가
│   ├── detail-cache.json      공공데이터 상세 캐시
│   ├── artmap-detail-cache.json
│   └── geocode-cache.json     지오코딩 결과 캐시
├── scripts/
│   ├── config.mjs             API 주소·분야 분류·텍스트 정리
│   ├── fetch-events.mjs       공공데이터 수집
│   ├── geocode.mjs            좌표 보정
│   ├── import-link.mjs        링크/수동 입력으로 1건 추가
│   ├── build-events.mjs       소스 병합 → events.json
│   ├── serve.mjs              로컬 미리보기 서버
│   ├── sources/artmap.mjs     art-map.co.kr 일괄 수집
│   └── lib/
│       ├── http.mjs           HTML 가져오기(인코딩 판별)
│       ├── extract.mjs        전시 정보 추출 어댑터
│       └── geocode.mjs        주소 → 좌표
├── .github/workflows/
│   ├── update-data.yml        매일 06:10 KST
│   ├── import-artmap.yml      매주 월 05:30 KST
│   └── add-exhibition.yml     수동 (관리자 페이지가 호출)
├── manifest.webmanifest       PWA
├── sw.js                      서비스 워커
├── AGENTS.md                  ★ 코드 수정 전 필독
└── PROJECT.md                 제작 기록·의사결정
```

---

## 설정 (한 번만 해둔 것)

**GitHub Secrets** (Settings → Secrets and variables → Actions)

| 이름 | 용도 |
|---|---|
| `DATA_GO_KR_SERVICE_KEY` | 공공데이터포털 일반 인증키(Decoding) |
| `NCP_APIGW_KEY_ID` | 네이버 클라우드 Client ID |
| `NCP_APIGW_KEY` | 네이버 클라우드 Client Secret (지오코딩) |

**GitHub Pages**: Settings → Pages → `Deploy from a branch` / `main` / `/ (root)`

**NCP 콘솔** → Maps → Application `artmap` → Web 서비스 URL에
`https://allmytown-cpu.github.io`, `http://localhost:5173` 등록

---

## 알아둘 점

- **코드를 고치기 전에 [`AGENTS.md`](AGENTS.md)를 먼저 읽으세요.**
  공공데이터 API 공식 문서가 실제와 다른 항목이 많고, 네이버 지도 컨테이너에는
  다시 밟기 쉬운 함정이 있습니다. 이미 알아낸 것을 다시 조사하지 않기 위한 문서입니다.
- `data/events.json`을 직접 고치지 마세요. 항상 `data/sources/*`를 고치고 `npm run build`.
- CSS/JS를 고치면 `index.html`의 `?v=N`을 올리세요. 안 그러면 캐시 때문에 반영되지 않습니다.
- 캐시가 꼬이면 `?nosw=1`로 접속하면 서비스 워커와 캐시가 삭제됩니다.

---

## 출처

- 데이터: 공공데이터포털 · 한국문화정보원 「한눈에보는문화정보 조회서비스」
- 전시 정보: [ARTMAP](https://art-map.co.kr), [오픈갤러리](https://www.opengallery.co.kr)
- 지도: NAVER Maps API v3
