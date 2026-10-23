# CLAUDE.md

시로(Shiro) — 디스코드 감정 비서(`orchestrator/`)와 그 감정을 연기하는
데스크톱 아바타(`avatar/`), 그리고 마인크래프트를 혼자 하는 봇(`minecraft/`).
자세한 설치·배포·파이프라인은 `README.md`와 `docs/`에 있다.

**공개 문서는 영어다.** `README.md`, `docs/`, 각 폴더의 `README.md`는 외국 사람이 읽게 영어로 쓴다
(2026-10-23에 한국어를 영어로 바꿨다). 일부러 한국어로 남긴 건 **작업용인 `WORKLOG.md`·`CLAUDE.md`** 뿐이다.
그림 파일을 새로 추가하면 `LICENSE-ASSETS.md`의 표에도 넣는다 (코드는 MIT, 그림은 CC BY-NC 4.0).
**`LICENSE`는 표준 MIT 본문 그대로 둔다** — 뭘 덧붙이면 GitHub가 라이선스를 인식하지 못한다 (한 번 `Other`로 잡혔다).
부가 설명은 `NOTICE.md`에 쓴다.

## 세션 규칙

**시작할 때 `WORKLOG.md`를 읽는다.** 여러 컴퓨터를 옮겨가며 작업하므로,
지금 이 저장소에서 뭐가 끝났고 뭐가 남았는지는 거기에만 적혀 있다.

**작업을 마치면 `WORKLOG.md`를 갱신한다** — [상태]와 [다음]을 고치고,
[기록] 맨 위에 날짜와 함께 한 줄. 그 다음 커밋하고 **푸시까지 한다.**
푸시하지 않으면 다른 컴퓨터에서는 아무 일도 없었던 것과 같다.

사용자와는 한국어로 대화한다.

## 구조

```
orchestrator/   TS, ESM, tsx로 실행. VM(홍콩 Lightsail)에서 systemd로 24/7.
  src/index.ts        디스코드 진입점, 채널별 직렬화
  src/turn.ts         한 번의 대화 처리 (글·음성 공통): 기억 → 모델 → 스트리밍 답 → 저장
  src/llm/gemini.ts   대화 + 도구 루프 (가장 큰 파일, 여기가 핵심)
  src/persona.ts      시스템 프롬프트, [emotion:xxx] 태그 파싱 (가드레일 파일)
  src/chatter.ts      시로가 먼저 말 거는 것: 물어보고 싶은 것 목록 → 지금이 때인지 판단
  src/wonder.ts       대화와 무관하게 스스로 궁금해하기 (목록이 비면 소재를 만든다)
  src/proactive.ts    아침 브리핑·할 일 알림, 새벽 학습(프로필·기분)을 부르는 틱
  src/voice.ts        음성 받아쓰기 (Gemini)
  src/memory/         SQLite(단기·설정·연락처·할일·사용량·프로필·기분·궁금증) + Pinecone(장기)
    mood.ts           기분과 "남은 마음" (계산·문구는 mood-core.ts, 새벽 회고는 mood-learn.ts)
  src/browser.ts      브라우저 도구: 요청 검증, 결과 정제, 같은 턴 승인 거부
  src/avatar/bridge.ts  WebSocket 서버(:18790), 토큰 인증, 클라이언트 역할(avatar/dev/minecraft)
avatar/         Electron, CommonJS. 로컬 PC에서 투명 오버레이로.
  renderer/app.js       레이어 합성 + 애니메이션 루프
  renderer/emotions.js  감정별 포즈 값
  renderer/tail.js      꼬리 벤딩(체인 + 삼각형 워프)
  mesh/                 얼굴 회전용 메시 엔진
  browser.js            시로 전용 브라우저 (허용 사이트·비밀번호 금지·되돌리기 어려운 행동 승인 — 규칙은 여기서 코드로 강제)
  tools/*.mjs           레이어 빌드 파이프라인 및 확인용 렌더
minecraft/      Node. 마크 전용 PC에서 시로가 혼자 노는 봇 (설계는 docs/minecraft.md)
tools/          deploy(배포 스크립트), jobspy(채용 크롤러), autostart, google-reauth.js
```

## 명령

```bash
cd orchestrator && npm start     # tsx src/index.ts
cd avatar && npm start           # electron .
cd avatar && node tools/preview-tail.mjs 34 3 5   # Electron 없이 그림으로 확인
cd avatar && node tools/record-demo.mjs          # 진짜 렌더러를 크롬으로 녹화해 README 용 GIF 로 (puppeteer-core·ffmpeg 필요)
cd avatar && npx electron tools/test-browser.js  # 브라우저 안전 규칙 시험 (진짜 Electron 필요, 창이 잠깐 뜬다)
cd orchestrator && npx tsx tests/browser.test.ts && npx tsx tests/bridge-roles.test.ts   # 브리지·브라우저 서버 쪽 시험
```

테스트 스위트는 없지만, **안전 규칙이 걸린 곳(브라우저, 브리지 역할)은 시험 파일이 있다** — 고치면 위 시험을 돌린다.
아바타 변경은 `tools/preview-*.mjs`로 렌더해서 눈으로 확인한다.
orchestrator 로직은 모델·DB를 가짜로 바꿔 단위로 시험하고, 프롬프트 행동은 같은 말에
옵션을 끔/켬으로 서버 모델에 던져 비교한다 (예: WORKLOG 10/19의 기분·궁금증 기록).

## 건드릴 때 주의

- **꼬리 위상은 매 프레임 누적한다.** `time * speed`로 계산하면 속도가 바뀌는
  순간 위상이 통째로 점프해서 꼬리가 튕겨 나간다 (`app.js`의 `tailPhase`).
- **레이어 빌드 순서**: `build-layers.mjs` → `build-tail-rig.mjs`. 뒤바꾸면 안 된다.
- **눈썹은 못 쓴다.** 앞머리가 완전히 덮는다. 표정은 눈 크기·동공·볼터치·입으로만.
- **fail-closed를 유지한다.** `DISCORD_OWNER_USER_ID`가 없으면 기동을 거부하고,
  `AVATAR_BRIDGE_TOKEN`이 없으면 브릿지를 켜지 않는다. 편의를 위해 완화하지 않는다.
- **손님(주인이 아닌 사용자)에게는 도구를 늘리지 않는다.** 개인 데이터 도구와
  구글 검색 그라운딩은 주인 전용이다 (`gemini.ts`의 `ownerTools` / `guestTools`).
  기분(`moodBlock`) 같은 개인 상태도 주인님 대화에만 붙인다.
- **`persona.ts`는 가드레일 파일이다** (안전 규칙이 들어 있고, 시로가 요청한 개발 작업이
  건드리면 경고가 붙는다). 기분·궁금증처럼 상태에 따라 달라지는 말투는 `persona.ts`를 고치지
  말고 `gemini.ts`에서 프롬프트 뒤에 블록으로 붙인다. **평소 상태면 아무것도 안 붙인다**
  (늘 붙이면 그 상태를 연기하게 된다).
- **음성으로 온 말(`viaVoice`)은 모델의 생각(thinking)을 끈다.** 첫 글자가 약 2초 빨라진다.
  글로 친 메시지는 켜 둔다 — 도구를 많이 쓰는 작업에서는 따져 보는 쪽이 낫다.
- **먼저 말 거는 건 `chatter.ts`의 조건을 모두 따른다**: 주인님이 30분 넘게 조용하고,
  안 답한 질문이 없고, `mute_chatter`로 막히지 않았을 때만. 새 출처(`wonder.ts` 같은)를
  만들어도 이 조건을 우회하지 않는다.
- **브리지 클라이언트는 auth 프레임에 `role`(avatar/dev/minecraft)을 밝힌다.** 화면 캡처·브라우저 요청은 avatar 역할에게만
  간다 (예전엔 "마지막에 접속한 클라이언트"로 보내서, 개발 워커가 늦게 붙으면 캡처가 전부 시간 초과됐다). 클라이언트를 새로 만들면 role 을 붙인다.
- **시로 전용 브라우저의 안전 규칙은 `avatar/browser.js`에서 코드로 강제한다** (허용 사이트·리다이렉트 검사, 비밀번호/인증번호 칸 입력 금지,
  제출·삭제·결제·로그아웃은 승인 전 정지, 로그인은 주인님이 직접). 프롬프트에 맡기지 않는다. 승인은 **멈춘 바로 그 턴에는 못 하고** 다음 메시지에서만 한다
  (`browser.ts`). Electron 창을 `show()` 했다가 `hide()` 하면 그 뒤에 다른 출처로 이동한 페이지가 클릭을 못 받는다 — 숨기지 말고 `destroy()` 후 새로 만든다.
- **응답이 갑자기 몇 분씩 느려지면 서비스부터 재시작한다.** 서버·네트워크·모델은 정상이고
  돌던 프로세스만 느린 일이 있었다 (WORKLOG 10/19).
- **이 맥북(macOS 13.0)에서는 `better-sqlite3`가 단독으로도 segfault**라서 orchestrator를
  로컬로 못 돌린다. DB가 걸린 코드는 복사본에서 `node:sqlite`로 바꿔 끼워 시험하고,
  모델 호출이 필요한 시험은 서버에서 짧은 스크립트로 한다.

## 서버 배포 (손으로 할 때)

`tools/deploy/deploy.js`는 시로의 개발 요청 결과를 올리는 용도다. 직접 올릴 땐 이 순서를 지킨다.

1. 서버 `~/orchestrator/src`가 **직전에 배포한 커밋과 같은지** 비교한다 (줄바꿈 CRLF는 무시).
   서버에서만 고친 게 있으면 덮어쓰지 말고 보고한다.
2. **처리 중인 답이 없는지** 본다 (저널의 마지막 `[DM]` 뒤에 `emotion=` 줄이 있어야 한다).
   재시작하면 쓰던 답이 끊긴다.
3. 바뀐 파일만 `src.new-<시각>`에 올려 체크섬을 맞추고, 이름만 바꿔 교체한 뒤
   `sudo systemctl restart shiro-orchestrator`, 저널에서 `logged in as` 를 확인한다.
4. **서버에서 `rm -rf`를 쓰지 않는다** (안전 점검이 막는다). 이전 코드는 `src.prev-<시각>`로
   남기고 되돌리는 한 줄을 WORKLOG에 적는다. 쌓인 백업은 주인님이 직접 정리한다.

## 저장소와 비밀값

- **이 저장소는 공개(PUBLIC)다.** 서버 IP, 접속 명령, 키 경로(README에 이미 있는 것 제외),
  토큰, **주인님의 대화 내용**은 `WORKLOG.md`·`CLAUDE.md`·`README.md`를 포함해 어디에도
  커밋하지 않는다. 접속 정보는 개인 메모에 둔다. (공인 IP가 한 번 올라간 적이 있다 — 커밋 `249f542`.)
- 비밀값은 저장소에 없다. VM은 `/etc/shiro.env`, 아바타는 `avatar/config.json`
  (둘 다 gitignore). 예시 파일만 커밋한다.
