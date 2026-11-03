import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type Client,
  type Interaction,
} from "discord.js";
import { CHAT_MODELS, chatModelKey, isChatModelKey, setChatModel, type ChatModelKey } from "../llm/model-choice.js";

// Discord slash commands. Only /model for now: the owner switches the conversation model
// between Gemini 3.8 Flash and Gemini 3 Flash. Registered globally on start-up (set() replaces
// the whole list, so a command removed here disappears from Discord too). Anyone can see a
// global command; only the owner's use of it does anything.

const LABELS: Record<ChatModelKey, string> = {
  "3.8": "Gemini 3.8 Flash",
  "3.0": "Gemini 3 Flash",
};

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("model")
    .setNameLocalizations({ ko: "모델" })
    .setDescription("Switch Shiro's conversation model (owner only)")
    .setDescriptionLocalizations({ ko: "시로의 대화 모델 바꾸기 (주인님 전용)" })
    .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("version")
        .setNameLocalizations({ ko: "버전" })
        .setDescription("Which model; leave empty to toggle")
        .setDescriptionLocalizations({ ko: "어느 모델로 할지 (비우면 반대쪽으로 바꿈)" })
        .setRequired(false)
        .addChoices(...(Object.keys(CHAT_MODELS) as ChatModelKey[]).map((key) => ({ name: LABELS[key], value: key })))
    )
    .toJSON(),
];

export async function registerSlashCommands(client: Client<true>): Promise<void> {
  try {
    await client.application.commands.set(COMMANDS);
    console.log(`[commands] registered: ${COMMANDS.map((c) => `/${c.name}`).join(", ")}`);
  } catch (err) {
    // A failed registration only costs the commands; chat goes on as before.
    console.error("[commands] registration failed:", err);
  }
}

export async function handleInteraction(interaction: Interaction, ownerUserId: string): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "model") return;

  if (interaction.user.id !== ownerUserId) {
    await interaction.reply({ content: "이건 주인님만 쓸 수 있어.", flags: MessageFlags.Ephemeral });
    return;
  }

  const before = chatModelKey();
  const asked = interaction.options.getString("version");
  const next: ChatModelKey = isChatModelKey(asked) ? asked : before === "3.8" ? "3.0" : "3.8";
  setChatModel(next);
  console.log(`[commands] chat model ${CHAT_MODELS[before]} -> ${CHAT_MODELS[next]}`);

  const content =
    next === before
      ? `이미 ${LABELS[next]}(${CHAT_MODELS[next]})로 대화하고 있어.`
      : `대화 모델을 ${LABELS[before]} → ${LABELS[next]}(${CHAT_MODELS[next]})로 바꿨어. 다음 메시지부터 적용돼.`;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
