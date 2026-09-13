# AGENTS.md — 작업 전 반드시 읽을 것

이 문서는 **이미 알아낸 사실**을 적어둔 것이다.
같은 것을 다시 조사하지 말 것. (공식 문서가 틀린 항목이 많다)

## 프로젝트

공공데이터 + art-map.co.kr 기반 전국 전시·공연 지도.
정적 사이트(GitHub Pages) + GitHub Actions가 서버 역할. 서버·DB 없음.

- 배포: https://allmytown-cpu.github.io/art-map/
- 저장소: allmytown-cpu/art-map

## 데이터 흐름

```
scripts/fetch-events.mjs     → data/sources/kcisa.json    (공공데이터, 매일)
scripts/sources/artmap.mjs   → data/sources/artmap.json   (art-map.co.kr, 주 1회)
scripts/import-link.mjs      → data/sources/manual.json   (링크 수동 추가)
                    ↓
scripts/build-events.mjs  →  data/events.json  ←  프론트엔드는 이것만 읽음
```

`data/events.json`을 직접 고치지 말 것. 항상 소스를 고치고 `npm run build`.

## 공공데이터 API (15138937) — 문서가 틀림

| 항목 | 실제 |
|---|---|
| Base | `https://apis.data.go.kr/B553457/cultureinfo` |
| 폐기됨 | `~/nopenapi/rest/publicperformancedisplays/*` (전부 404) |
| 오퍼레이션 | `period2` `area2` `realm2` `detail2` `livelihood2` — **`2` 없는 건 폐기** |
| 페이지 번호 | **`PageNo`** (대문자 P). `cPage`/`pageNo` 무시 |
| 페이지 크기 | **10 고정.** `rows`/`numOfRows` 무시 |
| `from`/`to` | **`endDate` 기준.** startDate 아님 |
| 엔티티 | **이중 인코딩** (`&amp;#39;` → `&#39;` → `'`) |
| 썸네일 | `http://` 로 옴 → https 변환 필수 |
| 한도 | 10,000회/일 (`X-RateLimit-Remaining` 헤더로 확인) |

주소·요금·전화·설명은 목록에 없고 `detail2`에만 있음 (1건 1요청, seq 캐시).

## art-map.co.kr

- 목록(좌표 포함): `POST /data/new_exhibition.php`
  `{start(+4씩), wrap(+1씩), type:'exhibition', area:'0', cate:'', od:'0', v_cnt:'0', online:'0'}`
  응답 HTML에 `push_val("제목", 위도, 경도, idx, "장소/지역", 갤러리id, "포스터")`
  → **지오코딩 불필요**
- 상세: `GET /exhibition/view.php?idx=N` 의 `#view_table` (th→td)
  제목은 `.container`의 **첫 자식 div**. `font-size:26px`로 찾으면 문의 팝업을 집는다.
- 목록은 시작일 내림차순이고 **대부분 종료된 전시**. 787건 수집 시 진행중 29건.
- robots.txt는 `/art-map*/`만 Yeti에게 금지. 목록·상세는 제한 없음.
  그래도 요청 간격을 두고 주 1회만 돌린다.

## opengallery.co.kr

`https://www.opengallery.co.kr/exhibition/{id}/`

- `og:title` = `전시명 | 갤러리명` (뒤의 갤러리명은 떼어낸다)
- `og:description` = `[지역] 갤러리 | 시작 ~ 종료`
- `table.exhibitionDetail-infoTable-table` → 작가 / 장소 / 기간 / 시간 / 관람료
- `.exhibitionDetail-location-name` = 갤러리명,
  바로 뒤 `.exhibitionDetail-sm` = **도로명 주소** (좌표는 없음 → 지오코딩)
- 등록자가 보도자료를 붙여넣어 제목에 `[출처] …` 가 섞이는 경우가 있어 잘라낸다.

## 지도 (네이버)

- `index.html`의 `ncpKeyId=ior0d6uleb` (Client Secret은 GitHub Secrets)
- **`#map`에 `position:absolute; inset:0` 쓰지 말 것.**
  네이버가 초기화하며 컨테이너 position을 인라인으로 덮어써서 높이가 0이 되고
  타일은 정상 로드되는데 화면엔 아무것도 안 보인다. `100vw/100dvh`로 못박을 것.
- NCP 콘솔에 `https://allmytown-cpu.github.io` 등록되어 있음.

## 지오코딩

`scripts/lib/geocode.mjs` — 가젯티어(기존 좌표 재사용) → 네이버 → Nominatim.
- 네이버 엔드포인트는 `maps.apigw.ntruss.com` (naveropenapi.* 는 구독 필요 오류)
- 실패 캐시에 `by`(지오코더명)를 기록한다. 안 그러면 Nominatim의 실패가
  네이버 호출을 영구히 막는다. (실제로 발생했던 버그)

## 캐시 / 서비스 워커

- CSS/JS는 `index.html`에서 `?v=N`으로 참조. **고치면 N을 올릴 것.**
- HTML·데이터는 네트워크 우선. 안 그러면 수정이 사용자에게 반영되지 않는다.
- 캐시가 꼬이면 `?nosw=1`로 접속 → 워커·캐시 전체 삭제.

## 중복 제거 (build-events.mjs)

한국 전시·공연 제목은 시리즈 접두어가 길어(`2026 PLOT STAGE`, `지브리 콘서트:`)
서로 다른 프로그램의 유사도가 쉽게 0.6을 넘는다. **느슨하게 잡으면 멀쩡한 전시가
사라진다** (초안에서 9건 오삭제됨).

현재 기준: 다른 소스끼리만 + 기간 겹침 + 시작일 14일 이내 +
(유사도 0.95 또는 0.85&같은장소). 기준을 낮추려면 반드시 오삭제 검증할 것.

## 로컬 실행

```powershell
$env:DATA_GO_KR_SERVICE_KEY="..."   # 공공데이터 Decoding 키
$env:NCP_APIGW_KEY_ID="ior0d6uleb"
$env:NCP_APIGW_KEY="..."
npm run fetch      # 공공데이터
npm run geocode    # 좌표 보정
npm run build      # events.json 생성
npm run serve      # http://localhost:5173  (file:// 로 열면 동작 안 함)
npm run add -- "<전시 URL>" --dry
```

PowerShell에서 한글이 깨지면:
`$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`

## 워크플로

| 파일 | 트리거 | 하는 일 |
|---|---|---|
| `update-data.yml` | 매일 06:10 KST · 수동 | 공공데이터 수집 → 지오코딩 → 빌드 → 커밋 |
| `import-artmap.yml` | 매주 월 05:30 KST · 수동 | art-map 수집 → 빌드 → 커밋 |
| `add-exhibition.yml` | 수동 | URL 하나 추가 |

`update-data.yml`에 **push 트리거를 다시 넣지 말 것.** 스크립트 고칠 때마다
전체 수집이 돌고 봇 커밋과 충돌한다.
