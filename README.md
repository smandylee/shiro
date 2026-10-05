# 시로 (Shiro)

디스코드에서 대화하는 감정 기반 개인 비서와, 그 감정을 실시간으로 연기하는 데스크톱 아바타.

```
orchestrator/   시로 본체 — 디스코드 봇, Gemini 대화, 기억, 구글 연동
                (AWS Lightsail VM, 홍콩. systemd 서비스로 24/7 구동)
avatar/         Electron 데스크톱 아바타 — 투명 창, 클릭 통과, 항상 위
```

시로가 답할 때마다 `[emotion:xxx]` 태그를 붙이고, 오케스트레이터가 그걸 파싱해
WebSocket으로 아바타에 밀어줍니다. 아바타는 그 감정대로 꼬리·귀·고개·눈을 움직입니다.

---

## 새 컴퓨터에서 시작하기

### 1. 아바타 (로컬)

```bash
cd avatar
npm install
cp config.example.json config.json
```

`config.json`을 열어서 두 값을 채웁니다:

| 키 | 값 |
|---|---|
| `bridgeUrl` | `ws://100.87.102.46:18790` (VM의 Tailscale 주소) |
| `bridgeToken` | VM의 `/etc/shiro.env`에 있는 `AVATAR_BRIDGE_TOKEN`과 **똑같은 값** |

> **토큰은 이 저장소에 없습니다.** `config.json`은 `.gitignore`에 있어요.
> VM에서 `sudo grep AVATAR_BRIDGE_TOKEN /etc/shiro.env`로 확인하거나,
> 비밀번호 관리자에 넣어둔 값을 쓰세요.

**Tailscale이 켜져 있어야 합니다.** VM은 공인 IP로 브릿지를 열지 않고
Tailscale 주소에만 바인딩합니다.

```bash
npm start
```

- `Ctrl+Shift+S` — 조작 패널 켜기/끄기 (감정 미리보기, 크기, 디버그 오버레이)
- `Ctrl+Shift+Q` — 종료

### 2. 오케스트레이터 (VM)

이미 `shiro-orchestrator.service`로 돌고 있습니다. 코드를 고쳤으면:

```bash
scp -i ~/.ssh/lightsail-siro.pem src/... ubuntu@100.87.102.46:~/orchestrator/src/...
ssh -i ~/.ssh/lightsail-siro.pem ubuntu@100.87.102.46 'sudo systemctl restart shiro-orchestrator'
```

환경변수는 `/etc/shiro.env` (root 전용). 필요한 키:

```
DISCORD_BOT_TOKEN  DISCORD_OWNER_USER_ID
GOOGLE_CLOUD_PROJECT  GOOGLE_CLOUD_LOCATION  GOOGLE_APPLICATION_CREDENTIALS
PINECONE_API_KEY
OPENCLAW_GATEWAY_URL  OPENCLAW_GATEWAY_TOKEN
AVATAR_BRIDGE_TOKEN  AVATAR_BRIDGE_HOST
TYPECAST_API_KEY  TYPECAST_VOICE_ID
```

`AVATAR_BRIDGE_TOKEN`이 없으면 브릿지는 **켜지지 않습니다** (fail-closed).
`TYPECAST_*`가 없으면 목소리만 꺼지고 나머지는 그대로 동작합니다. 아바타가 접속해 있지
않을 때도 TTS를 호출하지 않아서 비용이 나가지 않아요.

로그: `sudo journalctl -u shiro-orchestrator -f`

---

## 구글 연동 (Gmail · 캘린더 · 드라이브)

VM 의 `~/.openclaw/secrets/` 에 파일이 둘 있다. 둘 다 권한은 `600` 이어야 한다.

```
google-oauth-client.json   OAuth 클라이언트 (client_id / client_secret)
google-oauth-token.json    로그인해서 받은 토큰 (refresh_token 이 핵심)
```

### 토큰이 죽으면

**증상:** 시로가 메일·일정을 못 본다. 로그에 `invalid_grant — Token has been expired or revoked`.
이제는 토큰이 죽으면 **디스코드 DM 으로 알려준다** (계속 안 되면 하루에 한 번).

**고치는 법 — PC 에서 한 줄:**

```bash
node tools/google-reauth.js
```

SSH 터널을 열고 서버에서 인증 스크립트를 돌린 뒤 로그인 창을 띄운다. 로그인과 권한 승인만 직접 하면 된다.
**재시작은 필요 없다** — 서버가 죽은 토큰을 버리고 다음 확인(5분 안)에 새 파일을 읽는다.
(`avatar/config.json` 의 `deployHost` / `deployKeyPath` 를 그대로 쓴다.)

### 일주일마다 끊겼던 이유

Google Cloud Console 의 OAuth 동의 화면이 **"테스트"** 상태면 리프레시 토큰이 **7일 만에 만료**된다.
로그인을 다시 해도 7일짜리를 새로 받을 뿐이라 계속 반복된다. **"프로덕션"으로 게시하면 이 규칙이 빠진다.**

- 콘솔: <https://console.cloud.google.com/auth/audience> → **앱 게시**
- 게시해도 **검증 신청은 하지 않는다.** 개인용이라 "확인되지 않은 앱" 경고와 사용자 100명 상한만 붙는다.
  (Gmail 권한은 검증에 몇 달과 보안 심사가 붙는 등급이다.)
- **게시한 뒤에** 로그인해야 한다. 그 전에 받은 토큰은 계속 7일짜리다.
- 확인하는 법: 토큰 파일에 `refresh_token_expires_in` 키가 **있으면** 7일짜리, **없으면** 아니다.
  (키 이름만 본다. 값은 출력하지 않는다.)

게시한 뒤에도 끊기는 경우는 구글 **비밀번호를 바꿨을 때**(Gmail 권한이 든 토큰은 이때 무효가 된다)와
계정 보안 페이지에서 **권한을 직접 뺐을 때**, 6개월 이상 안 썼을 때뿐이다.

### 로그에 비밀값이 새던 문제 (고쳤다)

구글 호출이 실패하면 에러 객체 전체가 로그에 찍혔는데, 거기에 **요청 본문**이 들어 있다 —
토큰 갱신 실패라면 `refresh_token` 과 `client_secret` 이 평문으로. 5분마다 실패하는 동안
로그에 1만 3천 줄이 쌓였다. 지금은 `orchestrator/src/google/errors.ts` 가 두 군데서 막는다.

- 토큰 갱신 실패는 요청이 붙어 있지 않은 `GoogleAuthError` 로 바꿔서 던진다.
- 어떤 `GaxiosError` 든 로그에 찍으면 한 줄 요약(`Google 400 invalid_grant — ...`)만 나온다.

에러를 로그에 찍을 때는 `console.error(err)` 대신 `describeError(err)` 를 쓴다.

---

## PC 에서 시로 켜두기

시로와 이어지는 PC 쪽 프로그램은 셋이다 — **서버로 가는 SSH 터널, 개발 워커, 아바타.**
크롤러가 모은 취업 공고도 아바타가 켜져 있어야 시로에게 전달된다. 예전엔 전부 손으로 켰고,
PC 를 껐다 켜면 말없이 끊겼다. 지금은 작업 스케줄러에 등록해뒀다:

```powershell
powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1            # 등록 (여러 번 해도 안전)
powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1 -Remove    # 제거
```

| 작업 (`\Shiro\`) | 언제 | 하는 일 |
|---|---|---|
| `Up` | 로그온 때 | 터널·개발 워커·아바타를 올린다. 터널과 워커는 끊기면 다시 올린다 |
| `JobSpy-0900` / `JobSpy-2100` | 매일 09:00 / 21:00 | 취업 공고 크롤러. PC 가 꺼져 있었으면 켜질 때 한 번 돈다 |

- **터널이 필요한 이유:** 서버의 브릿지는 Tailscale 주소(`100.87.102.46:18790`)에만 떠 있는데, 이 PC 에서 거기로는
  핑만 가고 포트가 막혀 있다. 그래서 SSH 로 돌아간다. `avatar/config.json` 의 `deployHost` / `deployKeyPath` 를
  배포·재인증 도구와 같이 쓴다. 서버 방화벽은 건드리지 않았다.
- **아바타는 한 번만 켠다.** 주인님이 닫았다면 일부러 닫은 것이니 다시 켜지 않는다.
- **로그:** `tools/autostart/shiro-up.log`, `avatar/devworker.log`, `tools/jobspy/crawl.log`
- **지금 바로 띄우기:** `Start-ScheduledTask -TaskPath '\Shiro\' -TaskName 'Up'`
- 로그온한 사용자 권한으로만 돈다 (관리자 권한 없음, 비밀번호 저장 없음). 로그아웃하면 같이 멈춘다.
- **마크 봇과 서버는 아직 안 들어 있다.**
- **한글이 든 `.ps1` 은 UTF-8 BOM 으로 저장해야 한다.** Windows PowerShell 5.1 은 BOM 이 없으면 파일을 시스템
  코드페이지(949)로 읽는다. 그러면 한글이 깨지면서 따옴표가 사라져 문법 오류가 난다 (한 번 당했다).

---

## 서버 채팅 참여

시로는 원래 DM 만 받았다. 켜 둔 서버에서는 채팅을 읽다가 **끼어들 만할 때만** 말한다 (`orchestrator/src/guildchat.ts`).
호출하지 않아도 되고, 말할지 말지는 시로가 정한다.

주인님이 서버 채널에서 쓴다 (주인님만 된다):

```
!시로 켜기    이 서버를 켠다. 채널에 "여기 읽는다" 는 안내 한 줄을 남긴다
!시로 끄기    끈다
!시로 상태    켜져 있는지
```

켠 서버 목록은 SQLite `settings` 의 `guildChatServers` (서버 ID 의 JSON 배열) 에 있다.
**켜지 않은 서버의 메시지는 읽지도 않고 버린다.**

동작: 메시지가 오면 8초 동안 조용해지길 기다렸다가, 최근 20개를 디스코드에서 읽고 Gemini 에게 "말할지 말지, 말한다면
무엇을" 을 한 번에 묻는다. 기본은 조용하다. 멘션이나 답글이면 반드시 답한다.

**주인님만 있는 서버는 다르다.** 서버의 사람이 주인님 한 명뿐(나머지 봇)이면 DM 과 똑같이 전부 쓴다 — 메일·일정·기억·명령·목소리.
사람 목록은 1분마다 다시 읽고, 못 읽거나 100명이 넘으면 "다른 사람이 있다" 로 본다. 사람이 들어오면 그 서버는 아래 단체 모드로
내려가고 주인님께 DM 이 간다. 멘션·답글·"시로" 호출이면 바로 답하고, 아니면 주인님이 시로에게 하는 말인지 (다른 봇에게 하는 말은 아닌지)
판단을 거친다. 어떤 채널이든 된다. 주의: 같은 서버의 다른 봇은 시로가 채널에 쓴 글을 읽을 수 있다.

나머지 서버는 **주인님이 아닌 사람들**의 대화를 다루기 때문에 아래는 전부 일부러 그렇게 만든 것이다:

- **도구도 주인님 정보도 주지 않는다.** 호출에 `tools` 가 없어서, 서버에서 누가 뭘 써도 메일·캘린더·셸·기억에 닿을 길이 없다.
  주인님 일정 같은 걸 다른 사람이 물으면 "말 못 해", 주인님이 물으면 "DM 으로 물어봐" 로 넘긴다 (시험함).
- **모두에게 공개된 채널만 읽는다.** 시로는 서버에서 관리자라 비공개 채널도 볼 수 있지만 읽지 않는다.
- **대화를 저장하지 않는다.** 읽을 때마다 디스코드에서 가져오고, 로그에는 "말했다/조용했다" 만 남긴다.
- **한도가 있다.** 서버당 시간당 판단 30번, 스스로 끼어들기는 채널당 3분에 한 번, 말한 뒤 15초는 조용. 실제 비용이라 필수다.
- 멘션(`@everyone` 등)을 못 걸게 막고, 다른 봇은 무시하고, 서버 사람의 말은 지시가 아니라 대화 내용으로만 본다.
- 서버 대화는 아바타와 목소리로 가지 않는다 (친구들 대화로 주인님 아바타가 흔들리지 않게).

시로를 서버에 초대할 때 **관리자 권한은 필요 없다.** 메시지 보기·보내기·메시지 기록 보기면 된다.

---

## 아바타는 어떻게 만들어졌나

원본 일러스트 한 장(`avatar/shiro_base.png`, NovelAI)을
[See-through](https://github.com/shitagaki-lab/see-through)로 21개 레이어로 분해했습니다
(`avatar/seethrough/out/`). 가려진 부분까지 전부 복원해주기 때문에,
파츠를 움직여도 뒤에 구멍이 나지 않습니다.

### 파이프라인

```bash
cd avatar
node tools/build-layers.mjs      # See-through 출력 -> layers/ + layers.json
node tools/build-tail-rig.mjs    # 꼬리 중심선 추출 -> tail-rig.json (build-layers 다음에)
node tools/composite.mjs         # 전체를 한 장으로 합쳐서 확인
```

두 번째를 첫 번째보다 먼저 돌리면 안 됩니다. 순서가 중요합니다.

### 확인용 도구 (Electron 안 켜고 그림으로 확인)

```bash
node tools/preview-tail.mjs 34 3 5     # 꼬리: 진폭 34도, 3프레임, 바이어스 5
node tools/preview-face.mjs happy,sad  # 표정
node tools/compare.mjs 400 400 900 800 # 원본 vs 레이어 합성 나란히
```

### 알아둘 것

- **꼬리는 회전이 아니라 휘어집니다.** 픽셀에서 뽑은 중심선을 24마디 체인으로
  만들고, 파동이 뿌리에서 끝으로 타고 내려갑니다 (`renderer/tail.js`).
  `emotions.js`의 `tailAmp`는 관절 각도가 아니라 **꼬리 전체가 휘는 각도**입니다.
- **꼬리 위상은 절대 시계에서 계산하면 안 됩니다.** `time * speed`로 하면
  속도가 바뀔 때 위상이 통째로 점프해서 꼬리가 튕겨 나갑니다. 매 프레임 누적하세요.
- **눈썹은 못 씁니다.** 앞머리가 눈썹을 완전히 덮어서, 22도로 꺾어도 화면상
  차이가 없습니다. 표정은 눈 크기·동공·볼터치·입으로 만듭니다.
- **`face.png`는 눈·입·눈썹이 없는 빈 얼굴입니다.** 그래서 입 레이어를
  갈아끼우는 것만으로 표정을 바꿀 수 있습니다.

### 표정용 입 만들기 (진행 중)

지금 입은 "벌린 미소" 하나뿐입니다. 나머지는 NovelAI **인페인팅**으로 뽑습니다
(새로 생성하면 얼굴이 어긋나서 안 됩니다):

- 베이스: `avatar/shiro_base.png` (1536×1536, 그대로 유지)
- 마스크: `avatar/mouth-mask.png`
- 필요한 모양: 닫은 입 / 작은 o / 시무룩 / (선택) 물결

1536 → 1280은 정확히 6:5 단순 리사이즈라 좌표가 그대로 대응됩니다.
See-through를 다시 돌릴 필요는 없습니다.

## 시로가 개발을 요청하는 기능

시로는 코드를 직접 짜지 않는다. 원하는 것을 **말로 적어서 요청**하면, 주인님이 승인한 뒤
주인님 PC의 Claude Code가 격리된 git worktree에서 작업하고 결과를 알려준다.

### 흐름
1. 시로가 `request_dev_task` 로 요청을 올린다 (예: "메일 확인이 자꾸 실패해요"). 아직 실행되지 않는다.
2. 주인님이 승인하면 `approve_dev_task` → 아바타를 거쳐 PC에서 Claude Code 실행.
3. 끝나면 무엇이 바뀌었는지, 비용이 얼마인지 DM으로 온다. 이때 판정이 셋 중 하나로 온다:
   - **완료** — 만들었다. 브랜치가 생긴다.
   - **반려** — 이미 되어 있거나, 효과가 없거나, 너무 막연해서 안 했다. 아무것도 안 바뀐다.
   - **넘김** — 할 만한데 워커 권한 밖이라 못 했다 (패키지 설치, 서버 설정 등). 주인님이 Claude Code 세션에서 직접 해야 한다.
4. 주인님이 결과를 보고 **"배포해"** 라고 하면 `deploy_dev_task` 로 서버에 올라간다. 말하지 않으면 브랜치로 남는다.

### 켜는 법
아바타 `config.json` 에 `"allowDevTasks": true`. 기본값은 꺼짐.
`devModel`(기본 sonnet), `devMaxBudgetUsd`(기본 2) 로 모델과 비용 상한을 정한다.

요청을 처리하는 건 아바타가 아니라 **별도 워커**다. 아바타(Electron)가 꺼져 있어도 요청이 처리되도록,
같은 설정 파일을 읽는 작은 프로세스로 따로 돈다.

```powershell
cd avatar
npm run devworker
```

로그온할 때 자동으로 뜬다 (`tools/autostart`, 위의 "PC 에서 시로 켜두기" 참고).
워커가 꺼져 있으면 시로가 승인 단계에서 "아바타가 꺼져 있어서 보낼 수 없어"라고 알려준다.
기록은 `avatar/devworker.log` 에 남는다.

### 배포
결과가 마음에 들면 시로한테 "배포해"라고 하면 된다. 올리는 건 Claude Code가 아니라
**워커가 `tools/deploy/deploy.js` 를 그대로 실행**하는 것이다. 코드를 짠 쪽은 `ssh` 자체가 없고,
이 스크립트는 브랜치 이름 하나만 받는다 — 서버에서 무엇을 할지는 고를 수 없다.

순서: main 에 합치기 → `tsc` → `orchestrator/src` 업로드 → 서비스 재시작 → 로그에 로그인 확인.
**안 올라오면 서버를 이전 코드로 되돌리고 main 도 되돌린 뒤** 왜 실패했는지 알려준다.

다음 경우는 올리지 않고 주인님한테 넘긴다:
- `package.json` 이 바뀜 (서버에서 패키지를 새로 깔아야 함)
- `orchestrator/src` 밖의 서버 파일이 바뀜
- 가드레일 파일이 바뀜
- 체크아웃이 지저분하거나, main 이 아니거나, 워크트리에 커밋 안 된 게 남아 있음

켜는 법: `config.json` 에 `"allowDeploy": true` 와 `deployHost`·`deployKeyPath`
(`deployRemoteDir`·`deployService` 는 기본값 있음). 기본값은 꺼짐.

### 안전장치
- **worktree 격리**: 작업은 `.claude/worktrees/` 안 별도 브랜치에서만. 본체 체크아웃은 건드릴 수 없다.
- **배포 수단 차단**: 코드를 짜는 쪽은 `git push`, `ssh`, `scp`, `curl`, `WebFetch` 전부 금지. 서버로 가는 길은
  주인님이 따로 승인하는 위 배포 경로 하나뿐이고, 그 경로도 정해진 순서만 밟는다.
- **worktree 정리 주의**: 타입 체크용 `node_modules` junction 은 체크가 끝나면 바로 떼어낸다.
  붙어 있는 채로 `git worktree remove -f` 를 하면 링크를 따라가 **실제 `node_modules` 를 비운다** (한 번 당했다).
- **승인 없이는 실행되지 않는다**: 메일·웹·화면에서 읽은 낚시성 지시가 요청으로 둔갑해도 주인님이 먼저 본다.
- **가드레일 파일 경고**: 승인 게이트, 페르소나 안전 규칙 등이 바뀌면 결과에 ⚠️ 로 표시된다 (`avatar/devtask.js` 의 `GUARDRAIL_FILES`).
- **쓸데없는 요청은 잘린다**: 막연하거나 이미 되어 있거나 효과가 없는 요청이면 코드를 바꾸지 않고 왜 안 했는지만 알려준다.
- **타입 체크**: 작업이 끝나면 워크트리에서 `tsc` 를 돌려 결과를 함께 보고한다. 실패하면 성공으로 취급하지 않는다.
- 한 번에 하나만, 비용 상한과 시간 제한(기본 15분) 있음.

### 비용
요청 하나에 약 $0.2~0.5 (프로젝트 맥락을 매번 읽기 때문에 짧은 작업도 기본 비용이 붙는다).
