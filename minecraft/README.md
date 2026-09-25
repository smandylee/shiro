# 시로 마인크래프트

시로가 혼자 플레이하는 마인크래프트. 주인님은 서버에 들어가지 않는다.
여기에는 **이 폴더를 어떻게 돌리나**만 적는다. 어디까지 했고 다음에 뭘 하는지는 `WORKLOG.md`.

## 구성

```
minecraft/
  bot.js        mineflayer 봇 (진입점)
  jdk/          Java 25 (커밋 안 함)
  server/       Paper 서버 + 월드 (커밋 안 함)
```

## 버전을 이렇게 고른 이유

| 항목 | 값 | 이유 |
|---|---|---|
| 마크 | **26.1.2** | mineflayer 가 지원하는 마지막 계열이 26.1 이다. 26.2/26.3 은 아직 안 된다 |
| 프로토콜 | **775** | 26.1 / 26.1.1 / 26.1.2 가 전부 775 라, 서버는 26.1.2 를 쓰고 봇은 `version: "26.1"` 로 고정한다 |
| Paper | **26.1.2 빌드 74** | |
| Java | **25** | 26.x 서버의 최소 요구 버전 |

봇의 버전은 **자동 감지에 맡기지 않는다**. 서버가 올라가는 날 조용히 어긋나기 때문이다.

## Java 를 이 폴더 안에 둔 이유

이 PC 에는 Java 17 이 이미 깔려 있고 `JAVA_HOME` 도 거기를 가리킨다. 그걸 25 로 바꾸면
이 기계의 다른 Java 용도가 같이 흔들린다. 그래서 JDK 25 를 `minecraft/jdk/` 에만 풀어두고
**마크 서버만** 그 java.exe 를 쓴다. 시스템 설정은 건드리지 않는다.

## 준비 (처음 한 번)

1. Temurin JDK 25 (Windows x64 zip) 를 받아 `jdk/` 에 푼다.
2. Paper jar 를 받아 `server/` 에 둔다 — <https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds/latest>
   두 주소 다 SHA-256 을 함께 주므로, **받은 파일은 체크섬을 대조한 뒤** 쓴다.
3. 서버를 한 번 돌려 설정 파일을 만들게 한다. EULA 미동의로 바로 꺼진다.
4. `server/eula.txt` 의 `eula=true` — **Mojang EULA 동의**다. 주인님이 직접 정한다.
5. `server/server.properties` 를 아래대로 맞춘다.
6. `npm install`

## 서버 설정에서 중요한 것

```properties
server-ip=127.0.0.1          # 이 PC 밖에서는 접속 자체가 불가능
online-mode=false            # 계정 없이 이름만으로 접속
enforce-secure-profile=false # 오프라인 모드에서 채팅 서명이 봇을 막는 것을 방지
spawn-protection=0           # 봇이 스폰 근처에서 블록을 놓을 수 있게
```

`online-mode=false` 는 **아무 이름으로나 들어올 수 있다**는 뜻이다.
그래서 `server-ip=127.0.0.1` 이 짝으로 반드시 필요하다. 포트를 공유기에서 열지 않는다.

## 돌리기

```bash
# 서버
cd minecraft/server
"../jdk/jdk-25.0.4.1+1/bin/java.exe" -Xms1G -Xmx3G -XX:+UseG1GC -XX:G1HeapRegionSize=8M -jar paper-26.1.2-74.jar --nogui

# 봇 (다른 창에서)
cd minecraft
npm run bot
```

환경변수로 덮어쓸 수 있다: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_VERSION`.

## 지킬 것

- **게임 안 채팅은 전부 손님이다.** 주인님은 서버에 들어오지 않으므로 게임 안에 "주인"은 없다.
  게임 채팅에는 마크 행동 도구만 주고, 개인 데이터 도구와 검색 그라운딩은 절대 주지 않는다.
- 월드·jar·JDK·로그는 커밋하지 않는다 (`.gitignore`).
- 서버가 이 PC 에서 돌기 때문에, **PC 가 꺼져 있으면 시로도 마크를 못 한다.**
