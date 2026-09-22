# JobSpy 크롤러 (시로 채용 공고 기능)

주인님 PC에서 [JobSpy](https://github.com/speedyapply/JobSpy)로 홍콩 공고를 소량 조회해서
`output/`에 JSON으로 남기면, 켜져 있는 아바타가 그 파일을 읽어 서버로 전달합니다.
**로그인도, API 키도 필요 없습니다.** LinkedIn은 로그인 없이 보는 공개 검색만 씁니다.

이 서버(Lightsail VM)에서는 절대 돌리지 마세요 — 데이터센터 IP는 훨씬 쉽게 차단됩니다.

## 설치 (한 번만)

```powershell
cd tools\jobspy
py -3.12 -m venv venv
venv\Scripts\pip install -r requirements.txt
```

## 시험 실행

```powershell
venv\Scripts\python crawl.py
```

`output/` 폴더에 `20260922T120000Z.json` 같은 파일이 생기면 성공입니다. `crawl.log`에 사이트별 결과 수가 남습니다.
아바타가 켜져 있으면 최대 1분 안에 파일을 읽어 서버로 보내고 지웁니다(전송 실패 시 다음에 다시 시도, 파일은 남아 있음).

## 자동 실행 (Windows 작업 스케줄러)

1. **작업 스케줄러** 실행 → **기본 작업 만들기**
2. 트리거: 매일, 원하는 시각 1~2개 (예: 오전 9시)
3. 동작: 프로그램 시작
   - 프로그램: `C:\Users\User\Desktop\virtual-assistant\tools\jobspy\venv\Scripts\python.exe`
   - 인수: `crawl.py`
   - 시작 위치: `C:\Users\User\Desktop\virtual-assistant\tools\jobspy`
4. "가장 높은 권한으로 실행" 체크 불필요. PC가 꺼져 있으면 그날은 건너뜁니다 — 정상입니다.

## 설정 (`config.json`)

| 필드 | 뜻 |
|---|---|
| `queries` | 검색어 목록. 하나씩 순서대로 조회 |
| `location`, `countryIndeed` | 검색 지역. 기본 홍콩 |
| `sites` | `linkedin`, `indeed` (Google, Glassdoor는 잘 깨져서 뺐음) |
| `resultsPerQuery` | 검색어 하나당 최대 결과 수 |
| `hoursOld` | 이 시간 이내에 올라온 공고만 (기본 720시간 = 30일) |
| `requestGapSeconds`, `queryGapSeconds` | 요청 사이 쉬는 시간. 줄이면 차단 위험이 커짐 |
| `fetchLinkedinDescriptions` | LinkedIn 공고 본문까지 가져올지. **켜면 공고마다 추가 요청**이라 기본 꺼짐 |

## 시로에게 물어보기

Discord에서 "새 공고 있어?"라고 물으면 아직 안 보여준 공고를 알려줍니다. 한 번 보여준 공고는 다시 안 나옵니다.
시로는 스스로 먼저 알려주지 않습니다 — 물어봐야만 확인합니다.

## 안전 수칙 (지키세요)

- **LinkedIn 비밀번호나 쿠키를 이 폴더의 어떤 파일에도 넣지 않습니다.** 로그인 없이 돌아가는 구조입니다.
- **하루 1~2회면 충분합니다.** 자주 돌릴수록 IP가 차단될 위험이 커집니다.
- `venv/`, `output/`, `crawl.log`는 git에 올라가지 않습니다(`.gitignore`).
