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
```

`AVATAR_BRIDGE_TOKEN`이 없으면 브릿지는 **켜지지 않습니다** (fail-closed).

로그: `sudo journalctl -u shiro-orchestrator -f`

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
