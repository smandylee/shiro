# CLAUDE.md

시로(Shiro) — 디스코드 감정 비서(`orchestrator/`)와 그 감정을 연기하는
데스크톱 아바타(`avatar/`). 자세한 설치·배포·파이프라인은 `README.md`에 있다.

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
  src/index.ts        디스코드 DM 진입점, 채널별 직렬화
  src/llm/gemini.ts   대화 + 도구 루프 (가장 큰 파일, 여기가 핵심)
  src/persona.ts      시스템 프롬프트, [emotion:xxx] 태그 파싱
  src/memory/         SQLite(단기·설정·연락처·할일·사용량) + Pinecone(장기)
  src/avatar/bridge.ts  WebSocket 서버(:18790), 토큰 인증
avatar/         Electron, CommonJS. 로컬 PC에서 투명 오버레이로.
  renderer/app.js       레이어 합성 + 애니메이션 루프
  renderer/emotions.js  감정별 포즈 값
  renderer/tail.js      꼬리 벤딩(체인 + 삼각형 워프)
  tools/*.mjs           레이어 빌드 파이프라인 및 확인용 렌더
```

## 명령

```bash
cd orchestrator && npm start     # tsx src/index.ts
cd avatar && npm start           # electron .
cd avatar && node tools/preview-tail.mjs 34 3 5   # Electron 없이 그림으로 확인
```

테스트 스위트는 없다. 아바타 변경은 `tools/preview-*.mjs`로 렌더해서 눈으로 확인한다.

## 건드릴 때 주의

- **꼬리 위상은 매 프레임 누적한다.** `time * speed`로 계산하면 속도가 바뀌는
  순간 위상이 통째로 점프해서 꼬리가 튕겨 나간다 (`app.js`의 `tailPhase`).
- **레이어 빌드 순서**: `build-layers.mjs` → `build-tail-rig.mjs`. 뒤바꾸면 안 된다.
- **눈썹은 못 쓴다.** 앞머리가 완전히 덮는다. 표정은 눈 크기·동공·볼터치·입으로만.
- **fail-closed를 유지한다.** `DISCORD_OWNER_USER_ID`가 없으면 기동을 거부하고,
  `AVATAR_BRIDGE_TOKEN`이 없으면 브릿지를 켜지 않는다. 편의를 위해 완화하지 않는다.
- **손님(주인이 아닌 사용자)에게는 도구를 늘리지 않는다.** 개인 데이터 도구와
  구글 검색 그라운딩은 주인 전용이다 (`gemini.ts`의 `ownerTools` / `guestTools`).
- 비밀값은 저장소에 없다. VM은 `/etc/shiro.env`, 아바타는 `avatar/config.json`
  (둘 다 gitignore). 예시 파일만 커밋한다.
