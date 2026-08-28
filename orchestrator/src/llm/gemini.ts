import {
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Tool,
  Type,
} from "@google/genai";
import { recordUsage, estimateKrw, formatUsage, type UsageCounts } from "../memory/usage.js";
import { ai } from "./client.js";
import { SYSTEM_PROMPT } from "../persona.js";
import { runApprovedCommand } from "../openclaw/client.js";
import { proposeCommand, getPendingCommand, markCommand, cancelPending } from "../pc/commands.js";
import { listUnreadEmails, searchEmails, readEmail } from "../google/gmail.js";
import { listUpcomingEvents, createEvent, deleteEvent, type Repeat } from "../google/calendar.js";
import {
  addTodo,
  listOpenTodos,
  listRecentlyDone,
  completeTodo,
  removeTodo,
  formatTodo,
} from "../memory/todos.js";
import { saveNote, listNotes, readNote, searchNotes } from "../google/drive.js";
import { sendDirectMessage, notifyOwner } from "../discord/actions.js";
import { setContact, listContacts, findContactsByName } from "../memory/contacts.js";
import { lookUpNamuWiki } from "../knowledge/namuwiki.js";

const MODEL = "gemini-3.7-flash";

export type ChatTurn = { role: "user" | "model"; text: string };
// Inline binary sent alongside the message — images and PDFs alike.
export type MediaPart = { mimeType: string; data: string };

export type ChatOptions = {
  memoryContext?: string;
  sessionKey?: string;
  images?: MediaPart[];
  isOwner: boolean;
  senderId: string;
  contactName?: string;
};

const ownerTools: FunctionDeclaration[] = [
  {
    name: "propose_command",
    description:
      "주인님이 컴퓨터에서 뭔가 실행/확인해달라고 할 때 사용한다 (파일 목록 보기, 폴더 정리, 스크립트 실행 등). 이 도구는 명령을 **실행하지 않고 주인님께 보여주기만** 한다. 실행하려면 주인님이 승인한 뒤 approve_command를 써야 한다. 호출한 뒤에는 반드시 어떤 명령을 왜 실행하려는지 주인님께 그대로 설명하고 승인해달라고 말한다. 이메일·캘린더·노트·웹 검색은 각각 전용 도구가 있으니 이걸 쓰지 않는다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: "실행할 셸 명령 한 줄. 주인님이 읽고 판단할 수 있게 명확하게 쓴다",
        },
        reason: {
          type: Type.STRING,
          description: "이 명령을 실행하려는 이유 (주인님에게 보여줄 설명)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "approve_command",
    description:
      "주인님이 대기 중인 명령을 승인했을 때만 사용한다 (예: '응 실행해', '그거 돌려'). 주인님이 명확히 승인하지 않았으면 절대 쓰지 않는다. 승인 의사가 애매하면 다시 물어본다.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "cancel_command",
    description: "주인님이 대기 중인 명령을 취소하거나 거절했을 때 사용한다 (예: '아니 하지마', '취소').",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "look_up_namuwiki",
    description:
      "게임/애니/서브컬처/한국 관련 주제를 나무위키에서 찾아볼 때 사용한다. 특히 프로젝트 문(림버스 컴퍼니, 로보토미 코퍼레이션, 라이브러리 오브 루이나) 관련 질문은 반드시 이 도구로 확인하고 답한다 — 기억에 의존해서 답하면 다른 게임 용어와 헷갈려서 틀린 답을 하게 된다(예: '클래시'를 다른 게임 시스템으로 착각). 캐릭터, 스토리, 전투 시스템, 인격, E.G.O, 시즌 내용 등 세부 사항을 물어보면 추측하지 말고 이걸 쓴다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: "찾아볼 항목 이름. 가능하면 정확한 문서명으로 (예: '림버스 컴퍼니', '이상(림버스 컴퍼니)', 'Limbus Company/전투')",
        },
        question: {
          type: Type.STRING,
          description: "그 항목에서 특별히 알고 싶은 것 (선택). 예: '클래시 시스템이 어떻게 작동해?'",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "check_gmail",
    description:
      "주인님의 Gmail에서 안 읽은 메일 목록(보낸사람/제목/미리보기)을 확인할 때 사용한다. 결과의 [id:...] 값을 read_email에 넘기면 본문 전체를 읽을 수 있다. 메일 내용을 알아야 답할 수 있는 질문이면 목록만 보고 추측하지 말고 반드시 read_email로 본문을 확인한다.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "read_email",
    description:
      "메일 한 통의 본문 전체를 읽을 때 사용한다. check_gmail이나 search_email 결과에 있는 [id:...] 값을 넘긴다. '그 메일 뭐라고 왔어?', '내용 요약해줘' 같은 요청에는 반드시 이걸 써서 실제 본문을 확인하고 답한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        messageId: { type: Type.STRING, description: "읽을 메일의 id (목록 결과의 [id:...] 값)" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "search_email",
    description:
      "주인님의 Gmail 전체에서 조건에 맞는 메일을 찾을 때 사용한다 (안 읽은 것뿐 아니라 전체). Gmail 검색 문법을 그대로 쓴다: 보낸사람은 from:이름, 제목은 subject:단어, 기간은 after:2026/08/01, 첨부는 has:attachment, 여러 조건은 공백으로 이어 붙인다. 예: '항공권 예약메일 찾아줘' → subject:항공권 OR 항공권 예약.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Gmail 검색 문법으로 된 검색어" },
      },
      required: ["query"],
    },
  },
  {
    name: "check_calendar",
    description: "주인님의 Google 캘린더에서 다가오는 일정을 확인할 때 사용한다.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "create_calendar_event",
    description:
      "주인님의 Google 캘린더에 새 일정을 추가할 때 사용한다. 사용자가 특정 시간대를 언급하면(예: '한국시간 3시', 'KST 기준') 절대 직접 환산하지 말고, ISO 8601 형식에 그 시간대의 UTC 오프셋을 그대로 붙여서 넘긴다 (예: 한국시간 오후 3시 → 2026-08-25T15:00:00+09:00). 사용자가 시간대를 따로 말하지 않으면 오프셋 없이 홍콩 현지 시각(Asia/Hong_Kong)으로 넘긴다 — 이 경우엔 자동으로 홍콩 시간대로 처리된다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING, description: "일정 제목" },
        startIso: {
          type: Type.STRING,
          description:
            "시작 시각, ISO 8601 형식. 사용자가 언급한 시간대의 UTC 오프셋을 그대로 붙인다 (예: 한국시간이면 2026-08-25T15:00:00+09:00). 시간대 언급이 없으면 오프셋 없이 홍콩 로컬 시각만 적는다 (예: 2026-08-25T15:00:00) — 직접 다른 시간대로 암산 환산하지 않는다.",
        },
        endIso: {
          type: Type.STRING,
          description: "종료 시각, startIso와 같은 규칙(오프셋 포함 여부 등)을 따른다.",
        },
        repeatFreq: {
          type: Type.STRING,
          description:
            "반복 주기. 'WEEKLY'(매주), 'DAILY'(매일), 'MONTHLY'(매달) 중 하나. 반복 일정이면 반드시 이걸 쓴다 — 예를 들어 '매주 화요일 수업'은 첫 주 날짜를 startIso로 주고 repeatFreq='WEEKLY'로 한 번만 호출한다. 절대 주차별로 여러 번 호출하지 않는다.",
        },
        repeatCount: {
          type: Type.NUMBER,
          description: "총 몇 회 반복할지 (예: 13주 수업이면 13). repeatUntil과 함께 쓰지 않는다.",
        },
        repeatUntil: {
          type: Type.STRING,
          description: "반복 종료 날짜 (ISO 형식). 횟수 대신 '언제까지'로 지정할 때 쓴다.",
        },
      },
      required: ["summary", "startIso", "endIso"],
    },
  },
  {
    name: "add_todo",
    description:
      "주인님이 '이거 해야 해', '나중에 ~하기로 했어' 처럼 할 일을 말하면 기록해둔다. 시간이 정해진 약속/수업은 캘린더(create_calendar_event)에 넣고, 시간이 특정되지 않은 할 일은 여기에 넣는다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: "할 일 내용" },
        dueIso: {
          type: Type.STRING,
          description: "마감 기한이 있으면 ISO 형식으로 (선택). 없으면 비워둔다",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "list_todos",
    description: "주인님의 할 일 목록을 확인할 때 사용한다. '뭐 할 거 있지?', '할 일 뭐 남았어?' 같은 질문에 추측하지 말고 이걸로 확인한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        includeDone: { type: Type.BOOLEAN, description: "최근에 끝낸 것도 같이 볼지 (기본: 안 봄)" },
      },
    },
  },
  {
    name: "complete_todo",
    description: "주인님이 할 일을 끝냈다고 하면 완료 처리한다. 번호를 모르면 먼저 list_todos로 확인한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.NUMBER, description: "완료할 할 일의 번호 (목록의 [숫자])" },
      },
      required: ["id"],
    },
  },
  {
    name: "remove_todo",
    description: "할 일을 목록에서 아예 지운다 (완료가 아니라 취소/삭제일 때).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.NUMBER, description: "지울 할 일의 번호" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "주인님의 Google 캘린더에서 일정을 하나 삭제할 때 사용한다. 먼저 check_calendar로 목록을 확인해서 정확한 id를 알아낸 다음 호출한다. 지울 일정이 여러 개면 각각 한 번씩 호출한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING, description: "삭제할 일정의 id (check_calendar 결과의 [id:...] 값)" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "save_note",
    description:
      "주인님이 정리/저장을 요청한 내용을 노트로 저장할 때 사용한다 (예: 수업 필기, 회의록, 리서치 요약 등). Google Drive의 'Shiro Notes' 폴더에 마크다운 파일로 저장되며, 주인님이 옵시디언으로 볼 수 있다. 같은 제목으로 다시 저장하면 기존 노트를 덮어쓰니, 기존 노트에 내용을 덧붙이는 거라면 먼저 read_note로 읽어서 합친 다음 저장한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "노트 제목 (파일명으로도 쓰임, 특수문자 피할 것)" },
        content: { type: Type.STRING, description: "노트 본문, 마크다운 형식" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notes",
    description: "저장해둔 노트 제목 목록을 확인할 때 사용한다. '무슨 노트 있어?', '저번에 정리한 거 뭐였지?' 같은 질문에 추측하지 말고 이걸로 확인한다.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "read_note",
    description: "저장해둔 노트 하나의 내용을 읽을 때 사용한다. 제목을 정확히 모르면 먼저 list_notes나 search_notes로 확인한다. 노트 내용에 대해 답하려면 반드시 이걸로 실제 내용을 읽고 답한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "읽을 노트의 제목 (확장자 없이)" },
      },
      required: ["title"],
    },
  },
  {
    name: "search_notes",
    description: "노트 내용 안에서 특정 단어/주제를 검색할 때 사용한다. 어느 노트에 있는지 모를 때 쓴다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "노트 본문에서 찾을 단어나 문구" },
      },
      required: ["query"],
    },
  },
  {
    name: "send_discord_dm",
    description:
      "주인님이 '이 사람한테 메시지 보내줘'라고 지시했을 때 사용한다. 받는 사람은 name(기억해둔 사람의 이름) 또는 userId(정확한 Discord ID) 중 하나로 지정한다. 주인님이 이름만 말했으면 name에 그 이름을 그대로 넣는다 — 이미 기억해둔 사람이면 시로가 알아서 ID를 찾아서 보낸다. 이름만 듣고 미리 ID를 되묻지 않는다. 기억에 없거나 같은 이름이 여러 명이면 도구가 그렇게 알려주니, 그때만 주인님께 물어본다. 주인님이 직접 지시하지 않았는데 먼저 나서서 다른 사람에게 메시지를 보내지 않는다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "받는 사람의 이름. 기억해둔 사람이면 이것만으로 충분하다" },
        userId: { type: Type.STRING, description: "받는 사람의 정확한 Discord 사용자 ID (숫자). 이름으로 못 찾을 때만 쓴다" },
        message: { type: Type.STRING, description: "보낼 메시지 내용" },
      },
      required: ["message"],
    },
  },
  {
    name: "remember_person",
    description:
      "새로운 사람에 대한 정보를 기억해둘 때 사용한다. 예: 주인님이 '얘는 내 친구 민수야, 디스코드 ID는 12345야'라고 알려줬을 때. 정확한 Discord 사용자 ID를 모르면 쓰지 않는다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        userId: { type: Type.STRING, description: "그 사람의 정확한 Discord 사용자 ID (숫자)" },
        name: { type: Type.STRING, description: "그 사람의 이름/호칭" },
        note: { type: Type.STRING, description: "추가로 기억해둘 정보 (선택)" },
      },
      required: ["userId", "name"],
    },
  },
  {
    name: "check_usage",
    description:
      "주인님이 '토큰 얼마나 썼어?', '요즘 비용 얼마나 나와?' 처럼 시로의 사용량/비용을 물어보면 사용한다. 금액은 추정치라는 걸 반드시 같이 말한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        days: { type: Type.NUMBER, description: "며칠치를 볼지 (기본 7일)" },
      },
    },
  },
  {
    name: "list_known_people",
    description: "시로가 기억하고 있는 사람들(이름, Discord ID) 목록을 확인할 때 사용한다. '그 사람 누구야?', '내가 소개한 사람 목록 보여줘' 같은 질문에 정확히 답하려면 이 도구를 써야 한다 — 추측하지 않는다.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

// Tool calls that touch the owner's private data — exchanges that use any of
// these are excluded from the shared long-term memory pool.
const PERSONAL_TOOLS = new Set([
  "propose_command",
  "approve_command",
  "check_gmail",
  "read_email",
  "search_email",
  "check_calendar",
  "create_calendar_event",
  "delete_calendar_event",
  "add_todo",
  "list_todos",
  "complete_todo",
  "remove_todo",
  "save_note",
  "list_notes",
  "read_note",
  "search_notes",
]);

const guestTools: FunctionDeclaration[] = [
  {
    name: "remember_person",
    description: "지금 대화 상대가 스스로 자기 이름을 알려줬을 때, 그 이름을 기억해두는 데 사용한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "상대방이 알려준 이름/호칭" },
        note: { type: Type.STRING, description: "추가로 기억해둘 정보 (선택)" },
      },
      required: ["name"],
    },
  },
  {
    name: "notify_owner",
    description:
      "대화 상대가 주인님의 지금 근황/뭐 하는지/어디 있는지처럼 시로가 실시간으로는 알 수 없는 걸 물어봤을 때, 주인님한테 바로 DM으로 물어봐주는 데 사용한다. 그냥 잡담이나 이미 아는 내용이면 쓰지 않는다 — 진짜로 주인님한테 물어봐야 하는 질문일 때만.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING, description: "주인님에게 전달할 질문 내용" },
      },
      required: ["question"],
    },
  },
];

async function generateWithRetry(contents: Content[], config: Record<string, unknown>) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent({ model: MODEL, contents, config });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const delay = Math.min(3000 * 2 ** attempt, 30000);
        console.warn(`  -> rate limited (429), retrying in ${delay}ms... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// Tracks what happened earlier in the *current* turn, so a command can't be
// proposed and approved before the owner has seen it.
type TurnState = { proposedThisTurn: boolean };

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sessionKey: string | undefined,
  isOwner: boolean,
  senderId: string,
  contactName: string | undefined,
  turn: TurnState
): Promise<string> {
  switch (name) {
    case "propose_command": {
      const command = (args.command as string | undefined)?.trim();
      if (!command) return "실행할 명령이 비어 있어.";
      const reason = args.reason as string | undefined;
      proposeCommand(command, reason);
      turn.proposedThisTurn = true;
      return [
        "명령을 대기열에 올렸어. 아직 실행하지 않았어.",
        "이 명령을 주인님께 그대로 보여주고 승인을 받아야 해:",
        "",
        command,
        reason ? `\n(이유: ${reason})` : "",
        "",
        "주인님이 승인하시면 그때 approve_command를 쓴다. 10분 지나면 만료돼.",
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "approve_command": {
      if (turn.proposedThisTurn) {
        return "방금 올린 명령은 이번에 바로 실행할 수 없어. 주인님께 명령을 보여드리고, 주인님이 승인하시면 그때 실행해.";
      }
      const pending = getPendingCommand();
      if (!pending) {
        return "승인 대기 중인 명령이 없어. (아직 안 올렸거나, 10분이 지나 만료됐어)";
      }
      let output: string;
      try {
        output = await runApprovedCommand(pending.command);
      } catch (err) {
        markCommand(pending.id, "rejected");
        throw err;
      }
      markCommand(pending.id, "approved");
      return `실행한 명령: ${pending.command}\n\n결과:\n${output}`;
    }
    case "cancel_command":
      return cancelPending() ? "대기 중이던 명령을 취소했어." : "취소할 명령이 없어.";
    case "look_up_namuwiki":
      return lookUpNamuWiki(args.topic as string, args.question as string | undefined);
    case "check_gmail":
      return listUnreadEmails();
    case "read_email":
      return readEmail(args.messageId as string);
    case "search_email":
      return searchEmails(args.query as string);
    case "check_calendar":
      return listUpcomingEvents();
    case "create_calendar_event": {
      const freq = args.repeatFreq as Repeat["freq"] | undefined;
      const repeat: Repeat | undefined = freq
        ? {
            freq,
            count: typeof args.repeatCount === "number" ? args.repeatCount : undefined,
            untilIso: args.repeatUntil as string | undefined,
          }
        : undefined;
      return createEvent(args.summary as string, args.startIso as string, args.endIso as string, repeat);
    }
    case "delete_calendar_event":
      return deleteEvent(args.eventId as string);
    case "add_todo": {
      const todo = addTodo(args.text as string, args.dueIso as string | undefined);
      return `할 일 추가했어:\n${formatTodo(todo)}`;
    }
    case "list_todos": {
      const open = listOpenTodos();
      const parts: string[] = [];
      parts.push(
        open.length === 0 ? "남은 할 일이 없어." : `할 일 ${open.length}개:\n${open.map(formatTodo).join("\n")}`
      );
      if (args.includeDone) {
        const done = listRecentlyDone();
        if (done.length > 0) {
          parts.push(`\n최근에 끝낸 것:\n${done.map((t) => `- [${t.id}] ${t.text}`).join("\n")}`);
        }
      }
      return parts.join("\n");
    }
    case "complete_todo":
      return completeTodo(args.id as number)
        ? `[${args.id}] 완료 처리했어.`
        : `[${args.id}] 번 할 일을 못 찾았어. (이미 끝냈거나 없는 번호야)`;
    case "remove_todo":
      return removeTodo(args.id as number) ? `[${args.id}] 목록에서 지웠어.` : `[${args.id}] 번 할 일을 못 찾았어.`;
    case "save_note":
      return saveNote(args.title as string, args.content as string);
    case "list_notes":
      return listNotes();
    case "read_note":
      return readNote(args.title as string);
    case "search_notes":
      return searchNotes(args.query as string);
    case "send_discord_dm": {
      const message = args.message as string;
      let targetId = (args.userId as string | undefined)?.trim();

      if (!targetId) {
        const name_ = (args.name as string | undefined)?.trim();
        if (!name_) return "누구한테 보낼지 알려줘 — 이름이나 Discord ID가 필요해.";

        const matches = findContactsByName(name_);
        if (matches.length === 0) {
          return `"${name_}"이(가) 누군지 아직 기억에 없어. 정확한 Discord ID를 알려주면 보내고 기억해둘게.`;
        }
        if (matches.length > 1) {
          const options = matches.map((c) => `${c.name}(id:${c.discord_user_id})`).join(", ");
          return `"${name_}"이라는 이름으로 기억해둔 사람이 여러 명이야: ${options}. 누구인지 ID로 알려줘.`;
        }
        targetId = matches[0].discord_user_id;
      }

      return sendDirectMessage(targetId, message);
    }
    case "remember_person": {
      const userId = isOwner ? (args.userId as string) : senderId;
      const name_ = args.name as string;
      setContact(userId, name_, args.note as string | undefined);
      return `기억해뒀어: ${userId} = ${name_}`;
    }
    case "check_usage":
      return formatUsage(typeof args.days === "number" ? args.days : 7);
    case "list_known_people": {
      const contacts = listContacts();
      if (contacts.length === 0) return "아직 기억해둔 사람이 없어.";
      return contacts.map((c) => `- ${c.name} (id:${c.discord_user_id})${c.note ? ` — ${c.note}` : ""}`).join("\n");
    }
    case "notify_owner": {
      // Carry the sender's id, not just their name: the owner's reply ("걔한테
      // 안 된다고 해줘") arrives in a different channel, and without the id in
      // context Shiro has no way to tell who "걔" is.
      const who = contactName ? `${contactName}(id:${senderId})` : `모르는 사람(id:${senderId})`;
      return notifyOwner(`${who}이(가) 물어봤어: ${args.question as string}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export type ChatResult = { text: string; touchedPersonalData: boolean };

export async function chat(history: ChatTurn[], userMessage: string, opts: ChatOptions): Promise<ChatResult> {
  const { memoryContext, sessionKey, images, isOwner, senderId, contactName } = opts;

  const userParts: Part[] = [{ text: userMessage }];
  for (const img of images ?? []) {
    userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }

  const contents: Content[] = [
    ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: "user" as const, parts: userParts },
  ];

  let systemInstruction = SYSTEM_PROMPT;
  if (memoryContext) {
    systemInstruction += `\n\n[예전 기억 - 참고만 하고 언급은 자연스럽게]\n${memoryContext}`;
  }
  if (!isOwner) {
    systemInstruction += contactName
      ? `\n\n[지금 대화 상대는 주인님이 아니라 다른 사람이야]
- 상대방: ${contactName}
- 캐주얼하게 대화 상대로만 대한다. 주인님을 대하는 것과는 다르게, 이 사람을 "주인님"이라고 부르지 않는다.
- 주인님의 개인 정보(메일 내용, 일정, 저장한 노트 등)를 이 사람에게 언급하거나 대신 확인/실행해주지 않는다.
- 이 사람이 주인님의 지금 근황/뭐 하는지/어디 있는지처럼 시로가 실시간으로 알 수 없는 걸 물어보면, notify_owner 도구로 주인님한테 바로 물어봐준다.`
      : `\n\n[지금 대화 상대는 주인님이 아니라 처음 보는 사람이야, 이름을 몰라]
- 아직 누군지 모르니 대화 초반에 자연스럽게 "누구세요?" / "이름이 뭐야?" 하고 먼저 물어본다. 상대가 이름을 알려주면 반드시 remember_person 도구를 호출해서 기억해둔다.
- 캐주얼하게 대화 상대로만 대한다. 이 사람을 "주인님"이라고 부르지 않는다.
- 주인님의 개인 정보(메일 내용, 일정, 저장한 노트 등)를 이 사람에게 언급하거나 대신 확인/실행해주지 않는다.
- 이 사람이 주인님의 지금 근황/뭐 하는지/어디 있는지처럼 시로가 실시간으로 알 수 없는 걸 물어보면, notify_owner 도구로 주인님한테 바로 물어봐준다.`;
  }

  // Google Search / URL grounding is handled by Vertex itself (no functionCall
  // round trip) and billed per grounded request, so it's kept owner-only —
  // guests could otherwise turn Shiro into a free open search proxy.
  const tools: Tool[] = [{ functionDeclarations: isOwner ? ownerTools : guestTools }];
  if (isOwner) {
    tools.push({ googleSearch: {} }, { urlContext: {} });
  }

  const config = { systemInstruction, tools };

  // Usage is summed across every round, since the cost of one Discord message
  // is the whole loop, not the last call.
  const used: UsageCounts = { input: 0, output: 0, cached: 0 };
  const tally = (res: { usageMetadata?: GenerateContentResponseUsageMetadata }) => {
    const u = res.usageMetadata;
    if (!u) return;
    used.input += u.promptTokenCount ?? 0;
    used.output += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    used.cached += u.cachedContentTokenCount ?? 0;
  };

  let response = await generateWithRetry(contents, config);
  tally(response);
  let touchedPersonalData = false;
  const turn: TurnState = { proposedThisTurn: false };

  // Every round resends the whole conversation plus all prior tool traffic, so
  // input tokens grow roughly quadratically with round count. These caps bound
  // a runaway loop; a bulk timetable registration measured ~6 rounds, and its
  // many calls arrive in parallel within a round rather than as extra rounds.
  const MAX_ROUNDS = Number(process.env.SHIRO_MAX_TOOL_ROUNDS ?? 20);
  const MAX_TOOL_CALLS = Number(process.env.SHIRO_MAX_TOOL_CALLS ?? 150);
  let toolCallsUsed = 0;
  let hitLimit: "rounds" | "calls" | null = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const calls = response.functionCalls ?? [];
    if (calls.length === 0) break;

    if (toolCallsUsed + calls.length > MAX_TOOL_CALLS) {
      hitLimit = "calls";
      break;
    }
    if (round === MAX_ROUNDS - 1) {
      hitLimit = "rounds";
      break;
    }
    toolCallsUsed += calls.length;

    for (const call of calls) {
      if (call.name && PERSONAL_TOOLS.has(call.name)) touchedPersonalData = true;
    }

    // Mark the proposal before running anything: a round that contains both
    // propose_command and approve_command must not execute, no matter which
    // order the parallel calls happen to resolve in.
    if (calls.some((call) => call.name === "propose_command")) {
      turn.proposedThisTurn = true;
    }

    const results = await Promise.all(
      calls.map(async (call) => {
        console.log(`  -> tool call: ${call.name}(${JSON.stringify(call.args)})`);
        try {
          return await runTool(call.name!, (call.args as Record<string, unknown>) ?? {}, sessionKey, isOwner, senderId, contactName, turn);
        } catch (err) {
          console.error(`tool ${call.name} failed:`, err);
          return "작업 실행 중에 오류가 나서 실패했어.";
        }
      })
    );

    contents.push({
      role: "model",
      parts: response.candidates?.[0]?.content?.parts ?? calls.map((call) => ({ functionCall: call })),
    });
    contents.push({
      role: "user",
      parts: calls.map((call, i) => ({
        functionResponse: { name: call.name!, response: { result: results[i] } },
      })),
    });

    response = await generateWithRetry(contents, config);
    tally(response);
  }

  if (hitLimit) {
    const stopped = response.functionCalls ?? [];
    console.warn(
      `  -> tool loop capped (${hitLimit}) after ${toolCallsUsed} calls; ${stopped.length} call(s) dropped`
    );

    // Answer the pending calls with a refusal rather than appending a second
    // user turn — every functionCall needs a matching functionResponse, and the
    // roles have to keep alternating.
    if (stopped.length > 0) {
      contents.push({
        role: "model",
        parts: response.candidates?.[0]?.content?.parts ?? stopped.map((call) => ({ functionCall: call })),
      });
      contents.push({
        role: "user",
        parts: stopped.map((call) => ({
          functionResponse: {
            name: call.name!,
            response: {
              result:
                "도구 호출 한도에 걸려서 이 작업은 실행하지 않았어. 지금까지 실제로 처리한 것과 아직 못 한 것을 주인님께 솔직하게 정리해서 알려줘. 다 했다고 뭉뚱그리지 말고, 남은 건 이어서 하면 된다고 말해.",
            },
          },
        })),
      });
    }

    // Withhold the tools so the model has to reply in words instead of looping.
    response = await generateWithRetry(contents, { systemInstruction });
    tally(response);
  }

  recordUsage("chat", used);
  console.log(
    `  -> tokens: in ${used.input.toLocaleString()} / out ${used.output.toLocaleString()}` +
      (used.cached > 0 ? ` / cached ${used.cached.toLocaleString()}` : "") +
      ` (~${estimateKrw(used.input, used.output)}원, 도구 ${toolCallsUsed}회)`
  );

  const text = response.text;
  if (!text) {
    throw new Error(`empty response from ${MODEL}: ${JSON.stringify(response)}`);
  }
  return { text, touchedPersonalData };
}
