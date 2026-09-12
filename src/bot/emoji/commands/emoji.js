import {
  AttachmentBuilder,
  MessageFlags
} from "discord.js";
import { logger } from "../../../lib/logger.js";
import { DISCORD_EMOJI_LIMIT, generateEmoji } from "../generate.js";
import { EmojiError, failureKind, toEmojiError } from "../utils/errors.js";
import { parseFormat, extensionFor } from "../utils/options.js";
import { loadSource } from "../utils/source.js";
import { toggleFavorite } from "./favorites.js";
import { defaultAnimation, isManifestOption, isPlaceholder, suggestFor } from "./options.js";
import {
  buildStylesPicker,
  buildStyleSearchModal,
  buildGotoPageModal,
  ensureStyleFocus,
  findStyle,
  pageStyles,
  totalStylePages,
  warmTargetBoards
} from "./styles-picker.js";
import {
  buildCachedControlsReply,
  buildControls,
  buildFinishScreen,
  buildPostPicker,
  buildServerModal,
  buildTargetChooser,
  buildUploadModal,
  describe,
  parseCid,
  resultFileName,
  RESULT_HINT
} from "./ui.js";
import { createSession, endSession, getSession, touchSession } from "./session.js";
import { isSceneAnimation } from "../providers/offline/scene-pack.js";
const AVATAR_SIZE = 512;
function serverIconSource(interaction) {
  const guild = interaction.guild;
  const url = guild?.iconURL({ extension: "png", size: AVATAR_SIZE });
  return url ? { url, label: `${guild.name}'s icon` } : null;
}
function resolveSource(interaction) {
  const attachment = interaction.options.getAttachment("image");
  if (attachment) {
    const type = attachment.contentType?.toLowerCase() ?? "";
    if (type && !type.startsWith("image/")) {
      throw new EmojiError("not_an_image", "That attachment isn't an image.");
    }
    return { url: attachment.url, label: attachment.name ?? "your upload" };
  }
  const user = interaction.options.getUser("user");
  if (user) {
    return {
      url: user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }),
      label: `${user.username}'s avatar`
    };
  }
  if (interaction.options.getBoolean("server")) {
    const icon = serverIconSource(interaction);
    if (!icon) throw new EmojiError("no_source", "This server doesn't have an icon set.");
    return icon;
  }
  const url = interaction.options.getString("url");
  if (url) return { url: url.trim(), label: "your link" };
  return {
    url: interaction.user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }),
    label: "your avatar"
  };
}
function toGenerateOptions(session) {
  if (!session.image) throw new EmojiError("no_source", "Pick something to animate first.");
  const scene = isSceneAnimation(session.animation);
  return {
    image: session.image,
    animation: session.animation,
    format: session.format,
    ...scene ? {
      ...session.speed ? { speed: session.speed } : {},
      ...session.size ? { size: session.size } : {}
    } : {
      ...session.speed ? { speed: session.speed } : {},
      ...session.direction ? { direction: session.direction } : {},
      ...session.size ? { size: session.size } : {},
      ...session.color ? { color: session.color } : {},
      ...session.quality ? { quality: session.quality } : {},
      ...session.platform ? { platform: session.platform } : {}
    }
  };
}
async function buildReply(session, token) {
  if (!session.image) {
    throw new EmojiError("no_source", "Pick something to animate first.");
  }
  const result = await generateEmoji(toGenerateOptions(session));
  session.lastResult = {
    buffer: result.buffer,
    format: result.format,
    bytes: result.bytes,
    providerId: result.providerId,
    cached: result.cached
  };
  session.view = "controls";
  const file = new AttachmentBuilder(result.buffer, { name: resultFileName(result.buffer, result.format) });
  const sourceLabel = session.sourceLabel ?? "your image";
  const lines = [
    describe(session, result.bytes, result.providerId, result.cached),
    `-# from ${sourceLabel}`,
    RESULT_HINT
  ];
  if (/avatar/i.test(sourceLabel)) {
    lines.push("-# Tip: tap **Upload image** to animate a Discord attachment instead of an avatar.");
  }
  if (!isSceneAnimation(session.animation) && result.bytes > DISCORD_EMOJI_LIMIT) {
    lines.push("-# \u26A0\uFE0F Over Discord's 256 KB custom-emoji limit \u2014 try a smaller size or a different format.");
  }
  return {
    content: lines.join("\n"),
    embeds: [],
    files: [file],
    components: buildControls(session, token)
  };
}
function failureReply(err, token) {
  const session = token ? getSession(token) : void 0;
  return {
    content: failureMessage(err),
    files: [],
    embeds: [],
    components: session && token ? buildControls(session, token) : []
  };
}
function failureMessage(err) {
  const emojiError = toEmojiError(err);
  const kind = failureKind(err);
  if (emojiError.code === "internal") {
    logger.error({ err }, "emoji command failed unexpectedly");
  }
  switch (kind) {
    case "setup":
      return `\u{1F6E0}\uFE0F ${emojiError.message}`;
    case "transient":
      return `\u23F3 ${emojiError.message}
-# This usually clears on its own \u2014 try again in a few seconds.`;
    default:
      return `\u274C ${emojiError.message}`;
  }
}
async function handleEmojiCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const optional = (name) => {
    const value = interaction.options.getString(name)?.trim();
    return value && !isPlaceholder(value) ? value : void 0;
  };
  const namedTarget = Boolean(
    interaction.options.getAttachment("image") || interaction.options.getUser("user") || interaction.options.getString("url") || interaction.options.getBoolean("server") || optional("animation")
  );
  let token;
  try {
    const animation = optional("animation") ?? defaultAnimation();
    if (!namedTarget) {
      const created2 = createSession({
        image: null,
        ownerId: interaction.user.id,
        sourceLabel: null,
        animation: animation ?? "",
        format: parseFormat(interaction.options.getString("format")),
        view: "target"
      });
      await interaction.editReply(buildTargetChooser(created2.token));
      warmOpeningAvatar(interaction, animation ?? "", parseFormat(interaction.options.getString("format")));
      return;
    }
    const source = resolveSource(interaction);
    const image = await loadSource(source.url);
    if (!animation) {
      throw new EmojiError(
        "provider_unavailable",
        "The emoji generator isn't set up on this server yet. An admin needs to run MakeEmoji discovery first."
      );
    }
    const created = createSession({
      image,
      ownerId: interaction.user.id,
      sourceLabel: source.label,
      animation,
      format: parseFormat(interaction.options.getString("format")),
      ...optional("speed") ? { speed: optional("speed") } : {},
      ...optional("direction") ? { direction: optional("direction") } : {},
      ...optional("size") ? { size: optional("size") } : {},
      ...optional("color") ? { color: optional("color") } : {},
      ...optional("quality") ? { quality: optional("quality") } : {},
      ...optional("platform") ? { platform: optional("platform") } : {}
    });
    token = created.token;
    await interaction.editReply(await buildReply(created.session, token));
  } catch (err) {
    await interaction.editReply(failureReply(err, token));
  }
}
async function handleEmojiInteraction(interaction) {
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;
  const parsed = parseCid(interaction.customId);
  if (!parsed) return;
  const { action, token } = parsed;
  const session = getSession(token);
  if (!session) {
    await interaction.reply({
      content: "\u231B That emoji session has expired. Run `/emoji` again to start a new one.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({
      content: "\u{1F512} These controls belong to whoever ran `/emoji`. Run your own to get a set!",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (action === "done") {
    if (!interaction.isMessageComponent()) return;
    if (!session.lastResult) {
      endSession(token);
      await interaction.update({ content: "\u2705 **Done!**", embeds: [], files: [], components: [] });
      return;
    }
    touchSession(token, { view: "finish" });
    await interaction.update(buildFinishScreen(session, token));
    return;
  }
  if (action === "dismiss") {
    if (!interaction.isMessageComponent()) return;
    endSession(token);
    await interaction.deferUpdate().catch(() => {
    });
    await interaction.deleteReply().catch(() => {
    });
    return;
  }
  if (action === "keep_editing") {
    if (!interaction.isMessageComponent()) return;
    await interaction.deferUpdate();
    const updated2 = touchSession(token, { view: "controls" });
    if (!updated2) return;
    const reply = buildCachedControlsReply(updated2, token) ?? await buildReply(updated2, token);
    await interaction.editReply(reply);
    return;
  }
  if (action.startsWith("styles")) {
    await handleStylesAction(interaction, session, token, action);
    return;
  }
  if (action === "upload" || action === "upload_modal") {
    await handleUploadAction(interaction, token, action);
    return;
  }
  if (action === "pick_user" && interaction.isUserSelectMenu()) {
    await handleTargetPick(interaction, token, "member");
    return;
  }
  if (action === "pick_me" && interaction.isButton()) {
    await handleTargetPick(interaction, token, "me");
    return;
  }
  if (action === "pick_fav" && interaction.isButton()) {
    touchSession(token, { styleFilter: "favorites", stylePage: 0, styleFocus: null });
    await handleTargetPick(interaction, token, "me");
    return;
  }
  if (action === "pick_server" && interaction.isButton()) {
    await interaction.showModal(buildServerModal(token)).catch(() => {
    });
    return;
  }
  if (action === "server_modal" && interaction.isModalSubmit()) {
    await handleServerModal(interaction, token);
    return;
  }
  if (action.startsWith("target_") && interaction.isButton()) {
    await handleTargetAction(interaction, session, token, action);
    return;
  }
  if (action.startsWith("post") && interaction.isMessageComponent()) {
    await handlePostAction(interaction, session, token, action);
    return;
  }
  if (!interaction.isMessageComponent()) return;
  const patch = patchFor(action, interaction);
  if (!patch) return;
  await interaction.deferUpdate();
  const updated = touchSession(token, patch);
  if (!updated) return;
  try {
    await interaction.editReply(await buildReply(updated, token));
  } catch (err) {
    await interaction.editReply(failureReply(err, token));
  }
}
async function handleTargetPick(interaction, token, kind) {
  let source;
  if (kind === "member" && interaction.isUserSelectMenu()) {
    const user = interaction.users.first();
    source = user ? {
      url: user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }),
      label: `${user.username}'s avatar`
    } : null;
  } else if (kind === "server") {
    source = serverIconSource(interaction);
  } else {
    source = {
      url: interaction.user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }),
      label: "your avatar"
    };
  }
  if (!source) {
    await interaction.reply({
      content: "\u274C This server doesn't have an icon set. Pick a member or upload an image instead.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  }
  await interaction.deferUpdate();
  await enterStyleBrowser(interaction, token, source);
}
async function handleServerModal(interaction, token) {
  const raw = interaction.fields.getTextInputValue("server_id").trim();
  let source;
  if (!raw) {
    source = serverIconSource(interaction);
  } else if (!/^\d{5,25}$/.test(raw)) {
    source = null;
    await interaction.reply({
      content: "\u274C That doesn't look like a server ID. Right-click a server \u2192 Copy Server ID (needs Developer Mode).",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  } else {
    const guild = await interaction.client.guilds.fetch(raw).catch(() => null);
    const url = guild?.iconURL({ extension: "png", size: AVATAR_SIZE }) ?? null;
    source = url && guild ? { url, label: `${guild.name}'s icon` } : null;
    if (!source) {
      await interaction.reply({
        content: "\u274C I couldn't get that server's icon \u2014 I need to be a member of it, and it must have an icon set.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {
      });
      return;
    }
  }
  if (!source) {
    await interaction.reply({
      content: "\u274C This server doesn't have an icon set. Pick a member or upload an image instead.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  }
  await interaction.deferUpdate();
  await enterStyleBrowser(interaction, token, source);
}
async function enterStyleBrowser(interaction, token, source) {
  try {
    const image = await loadSource(source.url);
    const current = getSession(token);
    const updated = touchSession(token, {
      image,
      sourceLabel: source.label,
      view: "styles",
      stylePage: 0,
      styleFocus: current?.animation ?? null,
      lastResult: void 0
    });
    if (!updated) return;
    await interaction.editReply(await buildStylesPicker(updated, token));
  } catch (err) {
    await interaction.editReply(failureReply(err, token));
  }
}
async function handleTargetAction(interaction, session, token, action) {
  const source = action === "target_server" ? serverIconSource(interaction) : {
    url: interaction.user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE }),
    label: "your avatar"
  };
  if (!source) {
    await interaction.reply({
      content: "\u274C This server doesn't have an icon set.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  }
  await interaction.deferUpdate();
  try {
    const image = await loadSource(source.url);
    const updated = touchSession(token, {
      image,
      sourceLabel: source.label,
      view: "controls",
      lastResult: void 0
    });
    if (!updated) return;
    await interaction.editReply(await buildReply(updated, token));
  } catch (err) {
    await interaction.editReply(failureReply(err, token));
  }
}
function warmOpeningAvatar(interaction, animation, format) {
  const url = interaction.user.displayAvatarURL({ extension: "png", size: AVATAR_SIZE });
  void (async () => {
    const image = await loadSource(url).catch(() => null);
    if (image) warmTargetBoards(image, interaction.user.id, "your avatar", animation, format);
  })();
}
async function handlePostAction(interaction, session, token, action) {
  if (action === "post" && interaction.isButton()) {
    if (!session.lastResult) {
      await interaction.reply({
        content: "\u274C Nothing to post yet \u2014 generate an emoji first.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {
      });
      return;
    }
    touchSession(token, { view: "post" });
    await interaction.update(buildPostPicker(session, token));
    return;
  }
  if (action === "post_back" && interaction.isButton()) {
    await interaction.deferUpdate();
    const updated = touchSession(token, { view: "controls" });
    if (!updated) return;
    const reply = buildCachedControlsReply(updated, token);
    if (reply) await interaction.editReply(reply);
    return;
  }
  if (action !== "post_pick" || !interaction.isChannelSelectMenu()) return;
  const result = session.lastResult;
  const channelId = interaction.values[0];
  if (!result || !channelId) return;
  await interaction.deferUpdate();
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new EmojiError("internal", "That channel can't receive messages.");
    }
    await channel.send({
      files: [new AttachmentBuilder(result.buffer, {
        name: `emoji.${extensionFor(result.format)}`
      })]
    });
    const updated = touchSession(token, { view: "controls" }) ?? session;
    const reply = buildCachedControlsReply(updated, token);
    if (reply) await interaction.editReply(reply);
    await interaction.followUp({
      content: `\u2705 Posted to <#${channelId}>.`,
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), channelId },
      "could not post emoji to channel"
    );
    await interaction.followUp({
      content: "\u274C Couldn't post there \u2014 I may not have permission to send messages or attach files in that channel.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
  }
}
async function handleUploadAction(interaction, token, action) {
  if (action === "upload" && interaction.isButton()) {
    await interaction.showModal(buildUploadModal(token)).catch(() => {
    });
    return;
  }
  if (action !== "upload_modal" || !interaction.isModalSubmit()) return;
  const files = interaction.fields.getUploadedFiles("image", false);
  const attachment = files?.first();
  if (!attachment) {
    await interaction.reply({
      content: "\u274C No image was attached. Tap **Upload image** again and pick a file.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  }
  const type = attachment.contentType?.toLowerCase() ?? "";
  if (type && !type.startsWith("image/")) {
    await interaction.reply({
      content: "\u274C That attachment isn't an image. Upload a PNG, JPG, GIF, or WebP.",
      flags: MessageFlags.Ephemeral
    }).catch(() => {
    });
    return;
  }
  await interaction.deferUpdate();
  try {
    await enterStyleBrowser(interaction, token, {
      url: attachment.url,
      label: attachment.name ?? "your upload"
    });
  } catch (err) {
    await interaction.editReply(failureReply(err, token));
  }
}
async function handleStylesAction(interaction, session, token, action) {
  if (action === "styles_search" && interaction.isButton()) {
    await interaction.showModal(
      buildStyleSearchModal(token, session.styleQuery ?? "")
    ).catch(() => {
    });
    return;
  }
  if (action === "styles_goto" && interaction.isButton()) {
    const { page, pages } = pageStyles(session, session.ownerId);
    await interaction.showModal(buildGotoPageModal(token, pages, page)).catch(() => {
    });
    return;
  }
  if (action === "styles_modal" && interaction.isModalSubmit()) {
    const query = interaction.fields.getTextInputValue("query").trim();
    await interaction.deferUpdate().catch(() => {
    });
    const queryChanged = query !== (session.styleQuery ?? "");
    touchSession(token, {
      view: "styles",
      styleQuery: query,
      styleFocus: null,
      ...queryChanged ? { stylePage: 0 } : {}
    });
    const updated2 = getSession(token);
    if (!updated2) return;
    await interaction.editReply(await buildStylesPicker(updated2, token));
    return;
  }
  if (action === "styles_goto_modal" && interaction.isModalSubmit()) {
    const pageRaw = interaction.fields.getTextInputValue("page").trim();
    await interaction.deferUpdate().catch(() => {
    });
    const requested = Number.parseInt(pageRaw, 10);
    if (pageRaw && Number.isFinite(requested)) {
      const maxPage = totalStylePages(session, session.ownerId) - 1;
      touchSession(token, {
        stylePage: Math.min(Math.max(0, requested - 1), maxPage),
        styleFocus: null
      });
    }
    const updated2 = getSession(token);
    if (!updated2) return;
    await interaction.editReply(await buildStylesPicker(updated2, token));
    return;
  }
  if (!interaction.isMessageComponent()) return;
  if (action === "styles_apply" && interaction.isButton()) {
    await interaction.deferUpdate();
    const focus = ensureStyleFocus(session, session.ownerId);
    if (!findStyle(focus)) {
      await interaction.editReply(await buildStylesPicker(session, token));
      return;
    }
    const updated2 = touchSession(token, {
      animation: focus,
      styleFocus: focus,
      view: "controls"
    });
    if (!updated2) return;
    try {
      await interaction.editReply(await buildReply(updated2, token));
    } catch (err) {
      await interaction.editReply(failureReply(err, token));
    }
    return;
  }
  if (action === "styles_target" && interaction.isButton()) {
    await interaction.deferUpdate();
    touchSession(token, { view: "target" });
    await interaction.editReply(buildTargetChooser(token));
    return;
  }
  if (action === "styles_back" && interaction.isButton()) {
    await interaction.deferUpdate();
    touchSession(token, { view: "controls" });
    const updated2 = getSession(token);
    if (!updated2) return;
    const cached = buildCachedControlsReply(updated2, token);
    if (cached) {
      await interaction.editReply(cached);
      return;
    }
    try {
      await interaction.editReply(await buildReply(updated2, token));
    } catch (err) {
      await interaction.editReply(failureReply(err, token));
    }
    return;
  }
  await interaction.deferUpdate();
  if (action === "styles") {
    touchSession(token, {
      view: "styles",
      styleFocus: session.animation
    });
  } else if (action === "styles_prev") {
    touchSession(token, {
      stylePage: Math.max(0, (session.stylePage ?? 0) - 1),
      styleFocus: null
    });
  } else if (action === "styles_next") {
    touchSession(token, {
      stylePage: (session.stylePage ?? 0) + 1,
      styleFocus: null
    });
  } else if (action === "styles_filter" && interaction.isButton()) {
    touchSession(token, {
      styleFilter: session.styleFilter === "favorites" ? "all" : "favorites",
      stylePage: 0,
      styleFocus: null
    });
  } else if (action === "styles_fav" && interaction.isButton()) {
    const focus = ensureStyleFocus(session, session.ownerId);
    if (findStyle(focus)) toggleFavorite(session.ownerId, focus);
  } else if (action.startsWith("styles_n") && interaction.isButton()) {
    const index = Number.parseInt(action.slice("styles_n".length), 10);
    const { rows } = pageStyles(session, session.ownerId);
    const pick = Number.isInteger(index) ? rows[index] : void 0;
    if (pick) touchSession(token, { styleFocus: pick.value });
  } else if (action === "styles_page" && interaction.isStringSelectMenu()) {
    const target = Number.parseInt(interaction.values[0] ?? "", 10);
    if (Number.isInteger(target)) {
      const maxPage = totalStylePages(session, session.ownerId) - 1;
      touchSession(token, {
        stylePage: Math.min(Math.max(0, target), maxPage),
        styleFocus: null
      });
    }
  } else {
    return;
  }
  const updated = getSession(token);
  if (!updated) return;
  await interaction.editReply(await buildStylesPicker(updated, token));
}
async function handleEmojiAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (!isManifestOption(focused.name)) {
    await interaction.respond([]);
    return;
  }
  await interaction.respond(suggestFor(focused.name, String(focused.value ?? "")));
}
function patchFor(action, interaction) {
  if (interaction.isStringSelectMenu() && action.startsWith("set_")) {
    const key = action.slice("set_".length);
    const value = interaction.values[0];
    if (!value || !isManifestOption(key)) return null;
    return { [key]: value };
  }
  if (interaction.isButton() && action.startsWith("format_")) {
    return { format: parseFormat(action.slice("format_".length)) };
  }
  return null;
}
export {
  handleEmojiAutocomplete,
  handleEmojiCommand,
  handleEmojiInteraction
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZW1vamkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gL2Vtb2ppIFx1MjAxNCB0dXJuIGFueSBpbWFnZSBpbnRvIGFuIGFuaW1hdGVkIGVtb2ppLCBnZW5lcmF0ZWQgYnkgTWFrZUVtb2ppLlxuLy9cbi8vIFRoZSBjb21tYW5kIG93bnMgRGlzY29yZDogcmVzb2x2aW5nIHdoYXQgdGhlIHVzZXIgcG9pbnRlZCBhdCwgZGVmZXJyaW5nLFxuLy8gcmVwbHlpbmcsIGFuZCB0aGUgY29udHJvbCBwYW5lbC4gSXQgY29udGFpbnMgbm8gbmV0d29ya2luZyBvciBhdXRvbWF0aW9uIG9mXG4vLyBpdHMgb3duIFx1MjAxNCBnZW5lcmF0aW9uIGdvZXMgdGhyb3VnaCBgZ2VuZXJhdGVFbW9qaWAsIHdoaWNoIHBpY2tzIGEgcHJvdmlkZXIgYW5kXG4vLyBzZXJ2ZXMgZnJvbSBjYWNoZSB3aGVuIGl0IGNhbi5cbi8vXG4vLyBFbnRyeSBwb2ludHMsIG1hdGNoaW5nIGhvdyBpbmRleC50cyByb3V0ZXMgaW50ZXJhY3Rpb25zOlxuLy8gICBcdTIwMjIgaGFuZGxlRW1vamlDb21tYW5kICAgICBcdTIwMTQgdGhlIHNsYXNoIGNvbW1hbmRcbi8vICAgXHUyMDIyIGhhbmRsZUVtb2ppSW50ZXJhY3Rpb24gXHUyMDE0IGNvbXBvbmVudHMgLyBtb2RhbHMgd2hvc2UgY3VzdG9tSWQgc3RhcnRzIGBlbW9qaTpgXG4vLyAgIFx1MjAyMiBoYW5kbGVFbW9qaUF1dG9jb21wbGV0ZSBcdTIwMTQgdGhlIG1hbmlmZXN0LWJhY2tlZCBvcHRpb24gcGlja2Vyc1xuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmltcG9ydCB7XG4gIEF0dGFjaG1lbnRCdWlsZGVyLCBNZXNzYWdlRmxhZ3MsXG4gIHR5cGUgQXV0b2NvbXBsZXRlSW50ZXJhY3Rpb24sIHR5cGUgQnV0dG9uSW50ZXJhY3Rpb24sXG4gIHR5cGUgQ2hhdElucHV0Q29tbWFuZEludGVyYWN0aW9uLCB0eXBlIEludGVyYWN0aW9uLFxuICB0eXBlIE1lc3NhZ2VDb21wb25lbnRJbnRlcmFjdGlvbiwgdHlwZSBNb2RhbFN1Ym1pdEludGVyYWN0aW9uLFxuICB0eXBlIFVzZXJTZWxlY3RNZW51SW50ZXJhY3Rpb24sXG59IGZyb20gXCJkaXNjb3JkLmpzXCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi4vLi4vLi4vbGliL2xvZ2dlci5qc1wiO1xuaW1wb3J0IHsgRElTQ09SRF9FTU9KSV9MSU1JVCwgZ2VuZXJhdGVFbW9qaSB9IGZyb20gXCIuLi9nZW5lcmF0ZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHZW5lcmF0ZU9wdGlvbnMgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IEVtb2ppRXJyb3IsIGZhaWx1cmVLaW5kLCB0b0Vtb2ppRXJyb3IgfSBmcm9tIFwiLi4vdXRpbHMvZXJyb3JzLmpzXCI7XG5pbXBvcnQgeyBwYXJzZUZvcm1hdCwgZXh0ZW5zaW9uRm9yIH0gZnJvbSBcIi4uL3V0aWxzL29wdGlvbnMuanNcIjtcbmltcG9ydCB7IGxvYWRTb3VyY2UgfSBmcm9tIFwiLi4vdXRpbHMvc291cmNlLmpzXCI7XG5pbXBvcnQgeyB0b2dnbGVGYXZvcml0ZSB9IGZyb20gXCIuL2Zhdm9yaXRlcy5qc1wiO1xuaW1wb3J0IHsgZGVmYXVsdEFuaW1hdGlvbiwgaXNNYW5pZmVzdE9wdGlvbiwgaXNQbGFjZWhvbGRlciwgc3VnZ2VzdEZvciB9IGZyb20gXCIuL29wdGlvbnMuanNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkU3R5bGVzUGlja2VyLCBidWlsZFN0eWxlU2VhcmNoTW9kYWwsIGJ1aWxkR290b1BhZ2VNb2RhbCwgZW5zdXJlU3R5bGVGb2N1cyxcbiAgZmluZFN0eWxlLCBwYWdlU3R5bGVzLCB0b3RhbFN0eWxlUGFnZXMsIHdhcm1UYXJnZXRCb2FyZHMsXG59IGZyb20gXCIuL3N0eWxlcy1waWNrZXIuanNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQ2FjaGVkQ29udHJvbHNSZXBseSwgYnVpbGRDb250cm9scywgYnVpbGRGaW5pc2hTY3JlZW4sIGJ1aWxkUG9zdFBpY2tlcixcbiAgYnVpbGRTZXJ2ZXJNb2RhbCwgYnVpbGRUYXJnZXRDaG9vc2VyLCBidWlsZFVwbG9hZE1vZGFsLCBkZXNjcmliZSwgcGFyc2VDaWQsXG4gIHJlc3VsdEZpbGVOYW1lLCBSRVNVTFRfSElOVCxcbn0gZnJvbSBcIi4vdWkuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVNlc3Npb24sIGVuZFNlc3Npb24sIGdldFNlc3Npb24sIHRvdWNoU2Vzc2lvbiwgdHlwZSBFbW9qaVNlc3Npb24gfSBmcm9tIFwiLi9zZXNzaW9uLmpzXCI7XG5pbXBvcnQgeyBpc1NjZW5lQW5pbWF0aW9uIH0gZnJvbSBcIi4uL3Byb3ZpZGVycy9vZmZsaW5lL3NjZW5lLXBhY2suanNcIjtcblxuLyoqIEF2YXRhcnMgYXJlIGZldGNoZWQgbGFyZ2Ugc28gdGhlcmUncyBkZXRhaWwgdG8gd29yayB3aXRoIGJlZm9yZSBkb3duc2NhbGluZy4gKi9cbmNvbnN0IEFWQVRBUl9TSVpFID0gNTEyO1xuXG4vKiogV2hlcmUgdGhlIGltYWdlIGNhbWUgZnJvbS4gKi9cbmludGVyZmFjZSBTb3VyY2UgeyB1cmw6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9XG5cbi8qKiBBbnl0aGluZyBjYXJyeWluZyBhIGd1aWxkIHdlIGNhbiByZWFkIGFuIGljb24gZnJvbS4gKi9cbmludGVyZmFjZSBHdWlsZENhcnJpZXIge1xuICBndWlsZDogeyBuYW1lOiBzdHJpbmc7IGljb25VUkwob3B0aW9uczogeyBleHRlbnNpb246IFwicG5nXCI7IHNpemU6IG51bWJlciB9KTogc3RyaW5nIHwgbnVsbCB9IHwgbnVsbDtcbn1cblxuLyoqIFRoZSBndWlsZCdzIG93biBpY29uLCBvciBudWxsIHdoZW4gdGhlIHNlcnZlciBoYXMgbm9uZSBzZXQuICovXG5mdW5jdGlvbiBzZXJ2ZXJJY29uU291cmNlKGludGVyYWN0aW9uOiBHdWlsZENhcnJpZXIpOiBTb3VyY2UgfCBudWxsIHtcbiAgY29uc3QgZ3VpbGQgPSBpbnRlcmFjdGlvbi5ndWlsZDtcbiAgY29uc3QgdXJsID0gZ3VpbGQ/Lmljb25VUkwoeyBleHRlbnNpb246IFwicG5nXCIsIHNpemU6IEFWQVRBUl9TSVpFIH0pO1xuICByZXR1cm4gdXJsID8geyB1cmwsIGxhYmVsOiBgJHtndWlsZCEubmFtZX0ncyBpY29uYCB9IDogbnVsbDtcbn1cblxuLyoqXG4gKiBQaWNrIHRoZSBpbWFnZSB0byBhbmltYXRlLCBpbiBwcmlvcml0eSBvcmRlcjogYW4gZXhwbGljaXQgYXR0YWNobWVudCwgdGhlbiBhXG4gKiBuYW1lZCBtZW1iZXIncyBhdmF0YXIsIHRoZW4gYSBVUkwsIGFuZCBmaW5hbGx5IHRoZSBjYWxsZXIncyBvd24gYXZhdGFyIHNvIHRoZVxuICogY29tbWFuZCBhbHdheXMgZG9lcyBzb21ldGhpbmcgdXNlZnVsIHdpdGggbm8gb3B0aW9ucyBhdCBhbGwuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVTb3VyY2UoaW50ZXJhY3Rpb246IENoYXRJbnB1dENvbW1hbmRJbnRlcmFjdGlvbik6IFNvdXJjZSB7XG4gIGNvbnN0IGF0dGFjaG1lbnQgPSBpbnRlcmFjdGlvbi5vcHRpb25zLmdldEF0dGFjaG1lbnQoXCJpbWFnZVwiKTtcbiAgaWYgKGF0dGFjaG1lbnQpIHtcbiAgICBjb25zdCB0eXBlID0gYXR0YWNobWVudC5jb250ZW50VHlwZT8udG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuICAgIGlmICh0eXBlICYmICF0eXBlLnN0YXJ0c1dpdGgoXCJpbWFnZS9cIikpIHtcbiAgICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFwibm90X2FuX2ltYWdlXCIsIFwiVGhhdCBhdHRhY2htZW50IGlzbid0IGFuIGltYWdlLlwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgdXJsOiBhdHRhY2htZW50LnVybCwgbGFiZWw6IGF0dGFjaG1lbnQubmFtZSA/PyBcInlvdXIgdXBsb2FkXCIgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZXIgPSBpbnRlcmFjdGlvbi5vcHRpb25zLmdldFVzZXIoXCJ1c2VyXCIpO1xuICBpZiAodXNlcikge1xuICAgIHJldHVybiB7XG4gICAgICB1cmw6IHVzZXIuZGlzcGxheUF2YXRhclVSTCh7IGV4dGVuc2lvbjogXCJwbmdcIiwgc2l6ZTogQVZBVEFSX1NJWkUgfSksXG4gICAgICBsYWJlbDogYCR7dXNlci51c2VybmFtZX0ncyBhdmF0YXJgLFxuICAgIH07XG4gIH1cblxuICBpZiAoaW50ZXJhY3Rpb24ub3B0aW9ucy5nZXRCb29sZWFuKFwic2VydmVyXCIpKSB7XG4gICAgY29uc3QgaWNvbiA9IHNlcnZlckljb25Tb3VyY2UoaW50ZXJhY3Rpb24pO1xuICAgIGlmICghaWNvbikgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJub19zb3VyY2VcIiwgXCJUaGlzIHNlcnZlciBkb2Vzbid0IGhhdmUgYW4gaWNvbiBzZXQuXCIpO1xuICAgIHJldHVybiBpY29uO1xuICB9XG5cbiAgY29uc3QgdXJsID0gaW50ZXJhY3Rpb24ub3B0aW9ucy5nZXRTdHJpbmcoXCJ1cmxcIik7XG4gIGlmICh1cmwpIHJldHVybiB7IHVybDogdXJsLnRyaW0oKSwgbGFiZWw6IFwieW91ciBsaW5rXCIgfTtcblxuICByZXR1cm4ge1xuICAgIHVybDogaW50ZXJhY3Rpb24udXNlci5kaXNwbGF5QXZhdGFyVVJMKHsgZXh0ZW5zaW9uOiBcInBuZ1wiLCBzaXplOiBBVkFUQVJfU0laRSB9KSxcbiAgICBsYWJlbDogXCJ5b3VyIGF2YXRhclwiLFxuICB9O1xufVxuXG4vKiogU2Vzc2lvbiBzZXR0aW5ncyBhcyBhIHByb3ZpZGVyIHJlcXVlc3QuICovXG5mdW5jdGlvbiB0b0dlbmVyYXRlT3B0aW9ucyhzZXNzaW9uOiBFbW9qaVNlc3Npb24pOiBHZW5lcmF0ZU9wdGlvbnMge1xuICBpZiAoIXNlc3Npb24uaW1hZ2UpIHRocm93IG5ldyBFbW9qaUVycm9yKFwibm9fc291cmNlXCIsIFwiUGljayBzb21ldGhpbmcgdG8gYW5pbWF0ZSBmaXJzdC5cIik7XG4gIC8vIFNjZW5lcyBhcmUgd2hvbGUgY2xpcHMsIG5vdCBzbWFsbCBNYWtlRW1vamkgc3R5bGVzLiBUaGUgU2l6ZSBhbmQgU3BlZWRcbiAgLy8gY29udHJvbHMgRE8gYXBwbHkgXHUyMDE0IHRoZXkgc2V0IHRoZSBmaW5hbCBHSUYncyBsb25nIGVkZ2UgYW5kIHBsYXliYWNrIHNwZWVkIFx1MjAxNFxuICAvLyBidXQgdGhlIE1ha2VFbW9qaS1vbmx5IHNpZGUtY29udHJvbHMgKGRpcmVjdGlvbi9jb2xvdXIvcXVhbGl0eS9wbGF0Zm9ybSlcbiAgLy8gZG9uJ3QgbWFwIG9udG8gYSBjb21wb3NpdGVkIHNjZW5lLCBzbyB0aG9zZSBhcmUgZHJvcHBlZC5cbiAgY29uc3Qgc2NlbmUgPSBpc1NjZW5lQW5pbWF0aW9uKHNlc3Npb24uYW5pbWF0aW9uKTtcbiAgcmV0dXJuIHtcbiAgICBpbWFnZTogc2Vzc2lvbi5pbWFnZSxcbiAgICBhbmltYXRpb246IHNlc3Npb24uYW5pbWF0aW9uLFxuICAgIGZvcm1hdDogc2Vzc2lvbi5mb3JtYXQsXG4gICAgLi4uKHNjZW5lID8ge1xuICAgICAgLi4uKHNlc3Npb24uc3BlZWQgPyB7IHNwZWVkOiBzZXNzaW9uLnNwZWVkIH0gOiB7fSksXG4gICAgICAuLi4oc2Vzc2lvbi5zaXplID8geyBzaXplOiBzZXNzaW9uLnNpemUgfSA6IHt9KSxcbiAgICB9IDoge1xuICAgICAgLi4uKHNlc3Npb24uc3BlZWQgPyB7IHNwZWVkOiBzZXNzaW9uLnNwZWVkIH0gOiB7fSksXG4gICAgICAuLi4oc2Vzc2lvbi5kaXJlY3Rpb24gPyB7IGRpcmVjdGlvbjogc2Vzc2lvbi5kaXJlY3Rpb24gfSA6IHt9KSxcbiAgICAgIC4uLihzZXNzaW9uLnNpemUgPyB7IHNpemU6IHNlc3Npb24uc2l6ZSB9IDoge30pLFxuICAgICAgLi4uKHNlc3Npb24uY29sb3IgPyB7IGNvbG9yOiBzZXNzaW9uLmNvbG9yIH0gOiB7fSksXG4gICAgICAuLi4oc2Vzc2lvbi5xdWFsaXR5ID8geyBxdWFsaXR5OiBzZXNzaW9uLnF1YWxpdHkgfSA6IHt9KSxcbiAgICAgIC4uLihzZXNzaW9uLnBsYXRmb3JtID8geyBwbGF0Zm9ybTogc2Vzc2lvbi5wbGF0Zm9ybSB9IDoge30pLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKiogR2VuZXJhdGUgYW5kIGJ1aWxkIHRoZSBEaXNjb3JkIG1lc3NhZ2UgcGF5bG9hZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkUmVwbHkoc2Vzc2lvbjogRW1vamlTZXNzaW9uLCB0b2tlbjogc3RyaW5nKSB7XG4gIGlmICghc2Vzc2lvbi5pbWFnZSkge1xuICAgIC8vIEV2ZXJ5IHBhdGggdGhhdCByZW5kZXJzIGEgcmVzdWx0IHNldHMgYW4gaW1hZ2UgZmlyc3Q7IHRoaXMgZ3VhcmRzIHRoZSB0eXBlXG4gICAgLy8gYW5kIHR1cm5zIGEgbG9naWMgc2xpcCBpbnRvIGEgY2xlYW4gbWVzc2FnZSByYXRoZXIgdGhhbiBhIGNyYXNoLlxuICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFwibm9fc291cmNlXCIsIFwiUGljayBzb21ldGhpbmcgdG8gYW5pbWF0ZSBmaXJzdC5cIik7XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ2VuZXJhdGVFbW9qaSh0b0dlbmVyYXRlT3B0aW9ucyhzZXNzaW9uKSk7XG5cbiAgc2Vzc2lvbi5sYXN0UmVzdWx0ID0ge1xuICAgIGJ1ZmZlcjogcmVzdWx0LmJ1ZmZlcixcbiAgICBmb3JtYXQ6IHJlc3VsdC5mb3JtYXQsXG4gICAgYnl0ZXM6IHJlc3VsdC5ieXRlcyxcbiAgICBwcm92aWRlcklkOiByZXN1bHQucHJvdmlkZXJJZCxcbiAgICBjYWNoZWQ6IHJlc3VsdC5jYWNoZWQsXG4gIH07XG4gIHNlc3Npb24udmlldyA9IFwiY29udHJvbHNcIjtcblxuICBjb25zdCBmaWxlID0gbmV3IEF0dGFjaG1lbnRCdWlsZGVyKHJlc3VsdC5idWZmZXIsIHsgbmFtZTogcmVzdWx0RmlsZU5hbWUocmVzdWx0LmJ1ZmZlciwgcmVzdWx0LmZvcm1hdCkgfSk7XG4gIGNvbnN0IHNvdXJjZUxhYmVsID0gc2Vzc2lvbi5zb3VyY2VMYWJlbCA/PyBcInlvdXIgaW1hZ2VcIjtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgZGVzY3JpYmUoc2Vzc2lvbiwgcmVzdWx0LmJ5dGVzLCByZXN1bHQucHJvdmlkZXJJZCwgcmVzdWx0LmNhY2hlZCksXG4gICAgYC0jIGZyb20gJHtzb3VyY2VMYWJlbH1gLFxuICAgIFJFU1VMVF9ISU5ULFxuICBdO1xuXG4gIGlmICgvYXZhdGFyL2kudGVzdChzb3VyY2VMYWJlbCkpIHtcbiAgICBsaW5lcy5wdXNoKFwiLSMgVGlwOiB0YXAgKipVcGxvYWQgaW1hZ2UqKiB0byBhbmltYXRlIGEgRGlzY29yZCBhdHRhY2htZW50IGluc3RlYWQgb2YgYW4gYXZhdGFyLlwiKTtcbiAgfVxuXG4gIGlmICghaXNTY2VuZUFuaW1hdGlvbihzZXNzaW9uLmFuaW1hdGlvbikgJiYgcmVzdWx0LmJ5dGVzID4gRElTQ09SRF9FTU9KSV9MSU1JVCkge1xuICAgIC8vIFN0aWxsIHNlbmQgaXQgXHUyMDE0IGl0J3MgYSBwZXJmZWN0bHkgZ29vZCBmaWxlLCBqdXN0IG5vdCB1cGxvYWRhYmxlIGFzIGFcbiAgICAvLyBjdXN0b20gZW1vamkuIFNheSBzbyByYXRoZXIgdGhhbiBoYW5kaW5nIG92ZXIgc29tZXRoaW5nIHRoYXQgd2lsbCBiZVxuICAgIC8vIHJlamVjdGVkIGF0IHRoZSBwb2ludCBvZiB1c2UuXG4gICAgbGluZXMucHVzaChcIi0jIFx1MjZBMFx1RkUwRiBPdmVyIERpc2NvcmQncyAyNTYgS0IgY3VzdG9tLWVtb2ppIGxpbWl0IFx1MjAxNCB0cnkgYSBzbWFsbGVyIHNpemUgb3IgYSBkaWZmZXJlbnQgZm9ybWF0LlwiKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgY29udGVudDogbGluZXMuam9pbihcIlxcblwiKSxcbiAgICBlbWJlZHM6IFtdLFxuICAgIGZpbGVzOiBbZmlsZV0sXG4gICAgY29tcG9uZW50czogYnVpbGRDb250cm9scyhzZXNzaW9uLCB0b2tlbiksXG4gIH07XG59XG5cbi8qKlxuICogQSBmYWlsdXJlIHJlcGx5IHRoYXQga2VlcHMgdGhlIGNvbnRyb2wgcGFuZWwgd2hlbiB0aGUgc2Vzc2lvbiBpcyBzdGlsbCBhbGl2ZS5cbiAqXG4gKiBXaXBpbmcgdGhlIGNvbXBvbmVudHMgb24gYSB0cmFuc2llbnQgZXJyb3IgKE1ha2VFbW9qaSB0aW1pbmcgb3V0LCBhIHJhdGVcbiAqIGxpbWl0KSBzdHJhbmRlZCB0aGUgdXNlcjogdGhlIHNldHRpbmdzIHRoZXkgaGFkIGJ1aWx0IHVwIHdlcmUgc3RpbGwgaW4gdGhlXG4gKiBzZXNzaW9uLCBidXQgdGhlIG9ubHkgd2F5IGJhY2sgdG8gdGhlbSB3YXMgcmUtcnVubmluZyB0aGUgY29tbWFuZC4gUmVidWlsZGluZ1xuICogdGhlIHBhbmVsIGxldHMgdGhlbSBzaW1wbHkgdHJ5IGFnYWluLCBvciBhZGp1c3QgYSBzZXR0aW5nIGFuZCByZXRyeS5cbiAqL1xuZnVuY3Rpb24gZmFpbHVyZVJlcGx5KGVycjogdW5rbm93biwgdG9rZW4/OiBzdHJpbmcpIHtcbiAgY29uc3Qgc2Vzc2lvbiA9IHRva2VuID8gZ2V0U2Vzc2lvbih0b2tlbikgOiB1bmRlZmluZWQ7XG4gIHJldHVybiB7XG4gICAgY29udGVudDogZmFpbHVyZU1lc3NhZ2UoZXJyKSxcbiAgICBmaWxlczogW10sXG4gICAgZW1iZWRzOiBbXSxcbiAgICBjb21wb25lbnRzOiBzZXNzaW9uICYmIHRva2VuID8gYnVpbGRDb250cm9scyhzZXNzaW9uLCB0b2tlbikgOiBbXSxcbiAgfTtcbn1cblxuLyoqXG4gKiBUdXJuIGFueSBmYWlsdXJlIGludG8gYSBzaG9ydCwgdXNlci1mYWNpbmcgbWVzc2FnZS5cbiAqXG4gKiBUaGUgcHJlZml4IGFuZCB0aGUgZm9sbG93LXVwIGxpbmUgZGVwZW5kIG9uIHdoYXQgdGhlIHVzZXIgY2FuIGFjdHVhbGx5IGRvOlxuICogcmV0cnlpbmcgYSBtaXNzaW5nIGJyb3dzZXIgd2lsbCBuZXZlciB3b3JrLCBhbmQgdGVsbGluZyBzb21lb25lIHRoZWlyIHNlcnZlclxuICogaXMgbWlzY29uZmlndXJlZCB3aGVuIE1ha2VFbW9qaSBtZXJlbHkgdGltZWQgb3V0IHNlbmRzIHRoZW0gdG8gYW4gYWRtaW4gZm9yXG4gKiBub3RoaW5nLlxuICovXG5mdW5jdGlvbiBmYWlsdXJlTWVzc2FnZShlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICBjb25zdCBlbW9qaUVycm9yID0gdG9FbW9qaUVycm9yKGVycik7XG4gIGNvbnN0IGtpbmQgPSBmYWlsdXJlS2luZChlcnIpO1xuXG4gIGlmIChlbW9qaUVycm9yLmNvZGUgPT09IFwiaW50ZXJuYWxcIikge1xuICAgIGxvZ2dlci5lcnJvcih7IGVyciB9LCBcImVtb2ppIGNvbW1hbmQgZmFpbGVkIHVuZXhwZWN0ZWRseVwiKTtcbiAgfVxuXG4gIHN3aXRjaCAoa2luZCkge1xuICAgIGNhc2UgXCJzZXR1cFwiOlxuICAgICAgcmV0dXJuIGBcdUQ4M0RcdURFRTBcdUZFMEYgJHtlbW9qaUVycm9yLm1lc3NhZ2V9YDtcbiAgICBjYXNlIFwidHJhbnNpZW50XCI6XG4gICAgICByZXR1cm4gYFx1MjNGMyAke2Vtb2ppRXJyb3IubWVzc2FnZX1cXG4tIyBUaGlzIHVzdWFsbHkgY2xlYXJzIG9uIGl0cyBvd24gXHUyMDE0IHRyeSBhZ2FpbiBpbiBhIGZldyBzZWNvbmRzLmA7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBgXHUyNzRDICR7ZW1vamlFcnJvci5tZXNzYWdlfWA7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUVtb2ppQ29tbWFuZChpbnRlcmFjdGlvbjogQ2hhdElucHV0Q29tbWFuZEludGVyYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFRoZSBkYXNoYm9hcmQgaXMgYSBwcml2YXRlIHdvcmtzcGFjZTogb25seSB0aGUgY2FsbGVyIGFjdHMgb24gaXQsIGFuZCB0aGVcbiAgLy8gY2x1dHRlciBvZiBicm93c2luZyBzaG91bGRuJ3Qgc2l0IGluIHRoZSBjaGFubmVsLiBTaGFyaW5nIGhhcHBlbnMgZXhwbGljaXRseVxuICAvLyB0aHJvdWdoIFBvc3QsIHdoaWNoIHNlbmRzIGEgcmVhbCBwdWJsaWMgbWVzc2FnZS5cbiAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJSZXBseSh7IGZsYWdzOiBNZXNzYWdlRmxhZ3MuRXBoZW1lcmFsIH0pO1xuXG4gIC8qKiBBIHVzZXItc3VwcGxpZWQgb3B0aW9uLCBpZ25vcmluZyB0aGUgYXV0b2NvbXBsZXRlIHBsYWNlaG9sZGVyLiAqL1xuICBjb25zdCBvcHRpb25hbCA9IChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IGludGVyYWN0aW9uLm9wdGlvbnMuZ2V0U3RyaW5nKG5hbWUpPy50cmltKCk7XG4gICAgcmV0dXJuIHZhbHVlICYmICFpc1BsYWNlaG9sZGVyKHZhbHVlKSA/IHZhbHVlIDogdW5kZWZpbmVkO1xuICB9O1xuXG4gIC8vIFBvd2VyLXVzZXIgZmFzdCBwYXRoOiBpZiBhIHRhcmdldCBvciBhIHN0eWxlIHdhcyBuYW1lZCBvbiB0aGUgY29tbWFuZCwgaG9ub3VyXG4gIC8vIGl0IGFuZCBza2lwIHRoZSBjaG9vc2VyLiBFdmVyeXRoaW5nIGVsc2Ugb3BlbnMgdGhlIHZpc3VhbCwgdGFyZ2V0LWZpcnN0IGZsb3cuXG4gIGNvbnN0IG5hbWVkVGFyZ2V0ID0gQm9vbGVhbihcbiAgICBpbnRlcmFjdGlvbi5vcHRpb25zLmdldEF0dGFjaG1lbnQoXCJpbWFnZVwiKVxuICAgICAgfHwgaW50ZXJhY3Rpb24ub3B0aW9ucy5nZXRVc2VyKFwidXNlclwiKVxuICAgICAgfHwgaW50ZXJhY3Rpb24ub3B0aW9ucy5nZXRTdHJpbmcoXCJ1cmxcIilcbiAgICAgIHx8IGludGVyYWN0aW9uLm9wdGlvbnMuZ2V0Qm9vbGVhbihcInNlcnZlclwiKVxuICAgICAgfHwgb3B0aW9uYWwoXCJhbmltYXRpb25cIiksXG4gICk7XG5cbiAgbGV0IHRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBhbmltYXRpb24gPSBvcHRpb25hbChcImFuaW1hdGlvblwiKSA/PyBkZWZhdWx0QW5pbWF0aW9uKCk7XG5cbiAgICBpZiAoIW5hbWVkVGFyZ2V0KSB7XG4gICAgICAvLyBUaGUgY29tbW9uIGNhc2U6IG5vIG9wdGlvbnMuIENyZWF0ZSBhIHNlc3Npb24gd2l0aCBubyBpbWFnZSB5ZXQgYW5kIHNob3dcbiAgICAgIC8vIHRoZSBcIndoYXQgZG8geW91IHdhbnQgdG8gYW5pbWF0ZT9cIiBzY3JlZW4uIFBpY2tpbmcgYSB0YXJnZXQgbG9hZHMgdGhlXG4gICAgICAvLyBzb3VyY2UgYW5kIGRyb3BzIHN0cmFpZ2h0IGludG8gdGhlIHN0eWxlIGJyb3dzZXIuXG4gICAgICBjb25zdCBjcmVhdGVkID0gY3JlYXRlU2Vzc2lvbih7XG4gICAgICAgIGltYWdlOiBudWxsLFxuICAgICAgICBvd25lcklkOiBpbnRlcmFjdGlvbi51c2VyLmlkLFxuICAgICAgICBzb3VyY2VMYWJlbDogbnVsbCxcbiAgICAgICAgYW5pbWF0aW9uOiBhbmltYXRpb24gPz8gXCJcIixcbiAgICAgICAgZm9ybWF0OiBwYXJzZUZvcm1hdChpbnRlcmFjdGlvbi5vcHRpb25zLmdldFN0cmluZyhcImZvcm1hdFwiKSksXG4gICAgICAgIHZpZXc6IFwidGFyZ2V0XCIsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShidWlsZFRhcmdldENob29zZXIoY3JlYXRlZC50b2tlbikpO1xuICAgICAgLy8gU3BlY3VsYXRpdmVseSB3YXJtIHRoZSBjYWxsZXIncyBhdmF0YXIgYm9hcmRzIHNvIFwiTXkgYXZhdGFyXCIgLyBcIlx1MkI1MFxuICAgICAgLy8gRmF2b3JpdGVzXCIgcGFpbnQgZnJvbSBjYWNoZS4gQmFja2dyb3VuZCwgYmVzdC1lZmZvcnQsIHlpZWxkcyB0byByZWFsIHdvcmsuXG4gICAgICB3YXJtT3BlbmluZ0F2YXRhcihpbnRlcmFjdGlvbiwgYW5pbWF0aW9uID8/IFwiXCIsIHBhcnNlRm9ybWF0KGludGVyYWN0aW9uLm9wdGlvbnMuZ2V0U3RyaW5nKFwiZm9ybWF0XCIpKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc291cmNlID0gcmVzb2x2ZVNvdXJjZShpbnRlcmFjdGlvbik7XG4gICAgY29uc3QgaW1hZ2UgPSBhd2FpdCBsb2FkU291cmNlKHNvdXJjZS51cmwpO1xuXG4gICAgaWYgKCFhbmltYXRpb24pIHtcbiAgICAgIC8vIFdpdGggbm8gbWFuaWZlc3QgdGhlcmUgaXMgbm8gYW5pbWF0aW9uIHRvIGRlZmF1bHQgdG8sIHNvIHNheSB3aGF0J3NcbiAgICAgIC8vIG1pc3NpbmcgcmF0aGVyIHRoYW4gc2VuZGluZyBhbiBlbXB0eSByZXF1ZXN0IGF0IHRoZSBwcm92aWRlci5cbiAgICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFxuICAgICAgICBcInByb3ZpZGVyX3VuYXZhaWxhYmxlXCIsXG4gICAgICAgIFwiVGhlIGVtb2ppIGdlbmVyYXRvciBpc24ndCBzZXQgdXAgb24gdGhpcyBzZXJ2ZXIgeWV0LiBBbiBhZG1pbiBuZWVkcyB0byBydW4gTWFrZUVtb2ppIGRpc2NvdmVyeSBmaXJzdC5cIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgY3JlYXRlZCA9IGNyZWF0ZVNlc3Npb24oe1xuICAgICAgaW1hZ2UsXG4gICAgICBvd25lcklkOiBpbnRlcmFjdGlvbi51c2VyLmlkLFxuICAgICAgc291cmNlTGFiZWw6IHNvdXJjZS5sYWJlbCxcbiAgICAgIGFuaW1hdGlvbixcbiAgICAgIGZvcm1hdDogcGFyc2VGb3JtYXQoaW50ZXJhY3Rpb24ub3B0aW9ucy5nZXRTdHJpbmcoXCJmb3JtYXRcIikpLFxuICAgICAgLi4uKG9wdGlvbmFsKFwic3BlZWRcIikgPyB7IHNwZWVkOiBvcHRpb25hbChcInNwZWVkXCIpISB9IDoge30pLFxuICAgICAgLi4uKG9wdGlvbmFsKFwiZGlyZWN0aW9uXCIpID8geyBkaXJlY3Rpb246IG9wdGlvbmFsKFwiZGlyZWN0aW9uXCIpISB9IDoge30pLFxuICAgICAgLi4uKG9wdGlvbmFsKFwic2l6ZVwiKSA/IHsgc2l6ZTogb3B0aW9uYWwoXCJzaXplXCIpISB9IDoge30pLFxuICAgICAgLi4uKG9wdGlvbmFsKFwiY29sb3JcIikgPyB7IGNvbG9yOiBvcHRpb25hbChcImNvbG9yXCIpISB9IDoge30pLFxuICAgICAgLi4uKG9wdGlvbmFsKFwicXVhbGl0eVwiKSA/IHsgcXVhbGl0eTogb3B0aW9uYWwoXCJxdWFsaXR5XCIpISB9IDoge30pLFxuICAgICAgLi4uKG9wdGlvbmFsKFwicGxhdGZvcm1cIikgPyB7IHBsYXRmb3JtOiBvcHRpb25hbChcInBsYXRmb3JtXCIpISB9IDoge30pLFxuICAgIH0pO1xuICAgIHRva2VuID0gY3JlYXRlZC50b2tlbjtcblxuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShhd2FpdCBidWlsZFJlcGx5KGNyZWF0ZWQuc2Vzc2lvbiwgdG9rZW4pKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGZhaWx1cmVSZXBseShlcnIsIHRva2VuKSk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUVtb2ppSW50ZXJhY3Rpb24oaW50ZXJhY3Rpb246IEludGVyYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghaW50ZXJhY3Rpb24uaXNNZXNzYWdlQ29tcG9uZW50KCkgJiYgIWludGVyYWN0aW9uLmlzTW9kYWxTdWJtaXQoKSkgcmV0dXJuO1xuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQ2lkKGludGVyYWN0aW9uLmN1c3RvbUlkKTtcbiAgaWYgKCFwYXJzZWQpIHJldHVybjtcblxuICBjb25zdCB7IGFjdGlvbiwgdG9rZW4gfSA9IHBhcnNlZDtcbiAgY29uc3Qgc2Vzc2lvbiA9IGdldFNlc3Npb24odG9rZW4pO1xuXG4gIGlmICghc2Vzc2lvbikge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLnJlcGx5KHtcbiAgICAgIGNvbnRlbnQ6IFwiXHUyMzFCIFRoYXQgZW1vamkgc2Vzc2lvbiBoYXMgZXhwaXJlZC4gUnVuIGAvZW1vamlgIGFnYWluIHRvIHN0YXJ0IGEgbmV3IG9uZS5cIixcbiAgICAgIGZsYWdzOiBNZXNzYWdlRmxhZ3MuRXBoZW1lcmFsLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBjb250cm9scyBiZWxvbmcgdG8gd2hvZXZlciByYW4gdGhlIGNvbW1hbmQuIEFueW9uZSBlbHNlIGdldHMgYSBwcml2YXRlXG4gIC8vIG51ZGdlIHJhdGhlciB0aGFuIHNpbGVudGx5IGhpamFja2luZyB0aGUgcmVuZGVyLlxuICBpZiAoaW50ZXJhY3Rpb24udXNlci5pZCAhPT0gc2Vzc2lvbi5vd25lcklkKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24ucmVwbHkoe1xuICAgICAgY29udGVudDogXCJcdUQ4M0RcdUREMTIgVGhlc2UgY29udHJvbHMgYmVsb25nIHRvIHdob2V2ZXIgcmFuIGAvZW1vamlgLiBSdW4geW91ciBvd24gdG8gZ2V0IGEgc2V0IVwiLFxuICAgICAgZmxhZ3M6IE1lc3NhZ2VGbGFncy5FcGhlbWVyYWwsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gRG9uZSBcdTIxOTIgdGhlIGNsZWFuIGZpbmlzaCBzY3JlZW4gKGJhcmUgZW1vamkgKyBTYXZlL1Bvc3QvRGlzbWlzcyksIG5vdCB0aGVcbiAgLy8gb2xkIHNldHRpbmdzLXBhbmVsIGR1bXAuIFRoZSBzZXNzaW9uIHN0YXlzIGFsaXZlIHNvIFBvc3QgYW5kIEtlZXAgZWRpdGluZ1xuICAvLyBzdGlsbCB3b3JrOyBEaXNtaXNzIGlzIHdoYXQgYWN0dWFsbHkgZW5kcyBpdC5cbiAgaWYgKGFjdGlvbiA9PT0gXCJkb25lXCIpIHtcbiAgICBpZiAoIWludGVyYWN0aW9uLmlzTWVzc2FnZUNvbXBvbmVudCgpKSByZXR1cm47XG4gICAgaWYgKCFzZXNzaW9uLmxhc3RSZXN1bHQpIHtcbiAgICAgIGVuZFNlc3Npb24odG9rZW4pO1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24udXBkYXRlKHsgY29udGVudDogXCJcdTI3MDUgKipEb25lISoqXCIsIGVtYmVkczogW10sIGZpbGVzOiBbXSwgY29tcG9uZW50czogW10gfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwgeyB2aWV3OiBcImZpbmlzaFwiIH0pO1xuICAgIGF3YWl0IGludGVyYWN0aW9uLnVwZGF0ZShidWlsZEZpbmlzaFNjcmVlbihzZXNzaW9uLCB0b2tlbikpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIERpc21pc3MgdGhlIHdob2xlIGRhc2hib2FyZCBcdTIwMTQgcmVtb3ZlIHRoZSBlcGhlbWVyYWwgbWVzc2FnZSBlbnRpcmVseS5cbiAgaWYgKGFjdGlvbiA9PT0gXCJkaXNtaXNzXCIpIHtcbiAgICBpZiAoIWludGVyYWN0aW9uLmlzTWVzc2FnZUNvbXBvbmVudCgpKSByZXR1cm47XG4gICAgZW5kU2Vzc2lvbih0b2tlbik7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZGVsZXRlUmVwbHkoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gRnJvbSB0aGUgZmluaXNoIHNjcmVlbiwgc2xpcCBiYWNrIGludG8gdGhlIGVkaXRpbmcgcGFuZWwgd2l0aG91dCBhIHJlLXJlbmRlci5cbiAgaWYgKGFjdGlvbiA9PT0gXCJrZWVwX2VkaXRpbmdcIikge1xuICAgIGlmICghaW50ZXJhY3Rpb24uaXNNZXNzYWdlQ29tcG9uZW50KCkpIHJldHVybjtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5kZWZlclVwZGF0ZSgpO1xuICAgIGNvbnN0IHVwZGF0ZWQgPSB0b3VjaFNlc3Npb24odG9rZW4sIHsgdmlldzogXCJjb250cm9sc1wiIH0pO1xuICAgIGlmICghdXBkYXRlZCkgcmV0dXJuO1xuICAgIGNvbnN0IHJlcGx5ID0gYnVpbGRDYWNoZWRDb250cm9sc1JlcGx5KHVwZGF0ZWQsIHRva2VuKSA/PyBhd2FpdCBidWlsZFJlcGx5KHVwZGF0ZWQsIHRva2VuKTtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkocmVwbHkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFN0eWxlIGJyb3dzZXIgXHUyMDE0IHNlYXJjaCBvcGVucyBhIG1vZGFsOyBldmVyeXRoaW5nIGVsc2UgcmUtcmVuZGVycyB0aGUgcGlja2VyXG4gIC8vIChvciByZWdlbmVyYXRlcyB3aGVuIEFwcGx5IGlzIHByZXNzZWQpLlxuICBpZiAoYWN0aW9uLnN0YXJ0c1dpdGgoXCJzdHlsZXNcIikpIHtcbiAgICBhd2FpdCBoYW5kbGVTdHlsZXNBY3Rpb24oaW50ZXJhY3Rpb24sIHNlc3Npb24sIHRva2VuLCBhY3Rpb24pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIE1pZC1zZXNzaW9uIERpc2NvcmQgdXBsb2FkIFx1MjAxNCByZXBsYWNlIGF2YXRhciAob3IgYW55IHNvdXJjZSkgd2l0aCBhbiBhdHRhY2htZW50LlxuICBpZiAoYWN0aW9uID09PSBcInVwbG9hZFwiIHx8IGFjdGlvbiA9PT0gXCJ1cGxvYWRfbW9kYWxcIikge1xuICAgIGF3YWl0IGhhbmRsZVVwbG9hZEFjdGlvbihpbnRlcmFjdGlvbiwgdG9rZW4sIGFjdGlvbik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gT3BlbmluZyBzY3JlZW46IGEgdGFyZ2V0IHdhcyBjaG9zZW4uIExvYWQgaXQgYW5kIGRyb3AgaW50byB0aGUgc3R5bGUgYnJvd3Nlci5cbiAgaWYgKGFjdGlvbiA9PT0gXCJwaWNrX3VzZXJcIiAmJiBpbnRlcmFjdGlvbi5pc1VzZXJTZWxlY3RNZW51KCkpIHtcbiAgICBhd2FpdCBoYW5kbGVUYXJnZXRQaWNrKGludGVyYWN0aW9uLCB0b2tlbiwgXCJtZW1iZXJcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChhY3Rpb24gPT09IFwicGlja19tZVwiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBhd2FpdCBoYW5kbGVUYXJnZXRQaWNrKGludGVyYWN0aW9uLCB0b2tlbiwgXCJtZVwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRmF2b3JpdGVzIHNob3J0Y3V0OiBqdW1wIHN0cmFpZ2h0IHRvIHRoZSBzdGFycmVkIHN0eWxlcyBvbiB0aGUgY2FsbGVyJ3Mgb3duXG4gIC8vIGF2YXRhci4gVGFyZ2V0IChvbiB0aGUgYm9hcmQpIGxldHMgdGhlbSBzd2l0Y2ggc3ViamVjdCBmcm9tIHRoZXJlLlxuICBpZiAoYWN0aW9uID09PSBcInBpY2tfZmF2XCIgJiYgaW50ZXJhY3Rpb24uaXNCdXR0b24oKSkge1xuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwgeyBzdHlsZUZpbHRlcjogXCJmYXZvcml0ZXNcIiwgc3R5bGVQYWdlOiAwLCBzdHlsZUZvY3VzOiBudWxsIH0pO1xuICAgIGF3YWl0IGhhbmRsZVRhcmdldFBpY2soaW50ZXJhY3Rpb24sIHRva2VuLCBcIm1lXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTZXJ2ZXIgdGFyZ2V0OiBvcGVuIGEgbW9kYWwgc28gdGhlIHVzZXIgY2FuIHR5cGUgYSBzZXJ2ZXIgSUQgKG9yIGxlYXZlIGl0XG4gIC8vIGJsYW5rIGZvciB0aGUgY3VycmVudCBzZXJ2ZXIpLCB0aGVuIHJlc29sdmUgdGhhdCBndWlsZCdzIGljb24uXG4gIGlmIChhY3Rpb24gPT09IFwicGlja19zZXJ2ZXJcIiAmJiBpbnRlcmFjdGlvbi5pc0J1dHRvbigpKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uc2hvd01vZGFsKGJ1aWxkU2VydmVyTW9kYWwodG9rZW4pKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChhY3Rpb24gPT09IFwic2VydmVyX21vZGFsXCIgJiYgaW50ZXJhY3Rpb24uaXNNb2RhbFN1Ym1pdCgpKSB7XG4gICAgYXdhaXQgaGFuZGxlU2VydmVyTW9kYWwoaW50ZXJhY3Rpb24sIHRva2VuKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoYWN0aW9uLnN0YXJ0c1dpdGgoXCJ0YXJnZXRfXCIpICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBhd2FpdCBoYW5kbGVUYXJnZXRBY3Rpb24oaW50ZXJhY3Rpb24sIHNlc3Npb24sIHRva2VuLCBhY3Rpb24pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChhY3Rpb24uc3RhcnRzV2l0aChcInBvc3RcIikgJiYgaW50ZXJhY3Rpb24uaXNNZXNzYWdlQ29tcG9uZW50KCkpIHtcbiAgICBhd2FpdCBoYW5kbGVQb3N0QWN0aW9uKGludGVyYWN0aW9uLCBzZXNzaW9uLCB0b2tlbiwgYWN0aW9uKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIWludGVyYWN0aW9uLmlzTWVzc2FnZUNvbXBvbmVudCgpKSByZXR1cm47XG5cbiAgY29uc3QgcGF0Y2ggPSBwYXRjaEZvcihhY3Rpb24sIGludGVyYWN0aW9uKTtcbiAgaWYgKCFwYXRjaCkgcmV0dXJuO1xuXG4gIC8vIERlZmVyIGZpcnN0OiBhIGdlbmVyYXRpb24gY2FuIGVhc2lseSBvdXRsYXN0IERpc2NvcmQncyAzLXNlY29uZCB3aW5kb3cuXG4gIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyVXBkYXRlKCk7XG5cbiAgY29uc3QgdXBkYXRlZCA9IHRvdWNoU2Vzc2lvbih0b2tlbiwgcGF0Y2gpO1xuICBpZiAoIXVwZGF0ZWQpIHJldHVybjtcblxuICB0cnkge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShhd2FpdCBidWlsZFJlcGx5KHVwZGF0ZWQsIHRva2VuKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShmYWlsdXJlUmVwbHkoZXJyLCB0b2tlbikpO1xuICB9XG59XG5cbnR5cGUgUGlja0tpbmQgPSBcIm1lbWJlclwiIHwgXCJtZVwiIHwgXCJzZXJ2ZXJcIjtcblxuLyoqXG4gKiBBIHRhcmdldCB3YXMgY2hvc2VuIG9uIHRoZSBvcGVuaW5nIHNjcmVlbi4gUmVzb2x2ZSBpdHMgaW1hZ2UsIHN0b3JlIGl0LCBhbmRcbiAqIGxhbmQgaW4gdGhlIHN0eWxlIGJyb3dzZXIgc28gdGhlIHVzZXIgaW1tZWRpYXRlbHkgc2VlcyB0aGVpciBvd24gaW1hZ2UgdW5kZXJcbiAqIGVhY2ggc3R5bGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVRhcmdldFBpY2soXG4gIGludGVyYWN0aW9uOiBVc2VyU2VsZWN0TWVudUludGVyYWN0aW9uIHwgQnV0dG9uSW50ZXJhY3Rpb24sXG4gIHRva2VuOiBzdHJpbmcsXG4gIGtpbmQ6IFBpY2tLaW5kLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCBzb3VyY2U6IFNvdXJjZSB8IG51bGw7XG5cbiAgaWYgKGtpbmQgPT09IFwibWVtYmVyXCIgJiYgaW50ZXJhY3Rpb24uaXNVc2VyU2VsZWN0TWVudSgpKSB7XG4gICAgY29uc3QgdXNlciA9IGludGVyYWN0aW9uLnVzZXJzLmZpcnN0KCk7XG4gICAgc291cmNlID0gdXNlclxuICAgICAgPyB7XG4gICAgICAgICAgdXJsOiB1c2VyLmRpc3BsYXlBdmF0YXJVUkwoeyBleHRlbnNpb246IFwicG5nXCIsIHNpemU6IEFWQVRBUl9TSVpFIH0pLFxuICAgICAgICAgIGxhYmVsOiBgJHt1c2VyLnVzZXJuYW1lfSdzIGF2YXRhcmAsXG4gICAgICAgIH1cbiAgICAgIDogbnVsbDtcbiAgfSBlbHNlIGlmIChraW5kID09PSBcInNlcnZlclwiKSB7XG4gICAgc291cmNlID0gc2VydmVySWNvblNvdXJjZShpbnRlcmFjdGlvbik7XG4gIH0gZWxzZSB7XG4gICAgc291cmNlID0ge1xuICAgICAgdXJsOiBpbnRlcmFjdGlvbi51c2VyLmRpc3BsYXlBdmF0YXJVUkwoeyBleHRlbnNpb246IFwicG5nXCIsIHNpemU6IEFWQVRBUl9TSVpFIH0pLFxuICAgICAgbGFiZWw6IFwieW91ciBhdmF0YXJcIixcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFzb3VyY2UpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5yZXBseSh7XG4gICAgICBjb250ZW50OiBcIlx1Mjc0QyBUaGlzIHNlcnZlciBkb2Vzbid0IGhhdmUgYW4gaWNvbiBzZXQuIFBpY2sgYSBtZW1iZXIgb3IgdXBsb2FkIGFuIGltYWdlIGluc3RlYWQuXCIsXG4gICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKTtcbiAgYXdhaXQgZW50ZXJTdHlsZUJyb3dzZXIoaW50ZXJhY3Rpb24sIHRva2VuLCBzb3VyY2UpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBzZXJ2ZXIgaWNvbiBcdTIwMTQgdGhlIGN1cnJlbnQgZ3VpbGQsIG9yIGEgcGFzdGVkIHNlcnZlciBJRCBcdTIwMTQgYW5kIGVudGVyXG4gKiB0aGUgc3R5bGUgYnJvd3NlciBvbiBpdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2VydmVyTW9kYWwoXG4gIGludGVyYWN0aW9uOiBNb2RhbFN1Ym1pdEludGVyYWN0aW9uLFxuICB0b2tlbjogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJhdyA9IGludGVyYWN0aW9uLmZpZWxkcy5nZXRUZXh0SW5wdXRWYWx1ZShcInNlcnZlcl9pZFwiKS50cmltKCk7XG5cbiAgbGV0IHNvdXJjZTogU291cmNlIHwgbnVsbDtcbiAgaWYgKCFyYXcpIHtcbiAgICBzb3VyY2UgPSBzZXJ2ZXJJY29uU291cmNlKGludGVyYWN0aW9uKTtcbiAgfSBlbHNlIGlmICghL15cXGR7NSwyNX0kLy50ZXN0KHJhdykpIHtcbiAgICBzb3VyY2UgPSBudWxsO1xuICAgIGF3YWl0IGludGVyYWN0aW9uLnJlcGx5KHtcbiAgICAgIGNvbnRlbnQ6IFwiXHUyNzRDIFRoYXQgZG9lc24ndCBsb29rIGxpa2UgYSBzZXJ2ZXIgSUQuIFJpZ2h0LWNsaWNrIGEgc2VydmVyIFx1MjE5MiBDb3B5IFNlcnZlciBJRCAobmVlZHMgRGV2ZWxvcGVyIE1vZGUpLlwiLFxuICAgICAgZmxhZ3M6IE1lc3NhZ2VGbGFncy5FcGhlbWVyYWwsXG4gICAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybjtcbiAgfSBlbHNlIHtcbiAgICAvLyBUaGUgYm90IGNhbiBvbmx5IHJlYWQgaWNvbnMgZm9yIHNlcnZlcnMgaXQgaXMgaW4uXG4gICAgY29uc3QgZ3VpbGQgPSBhd2FpdCBpbnRlcmFjdGlvbi5jbGllbnQuZ3VpbGRzLmZldGNoKHJhdykuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgY29uc3QgdXJsID0gZ3VpbGQ/Lmljb25VUkwoeyBleHRlbnNpb246IFwicG5nXCIsIHNpemU6IEFWQVRBUl9TSVpFIH0pID8/IG51bGw7XG4gICAgc291cmNlID0gdXJsICYmIGd1aWxkID8geyB1cmwsIGxhYmVsOiBgJHtndWlsZC5uYW1lfSdzIGljb25gIH0gOiBudWxsO1xuICAgIGlmICghc291cmNlKSB7XG4gICAgICBhd2FpdCBpbnRlcmFjdGlvbi5yZXBseSh7XG4gICAgICAgIGNvbnRlbnQ6IFwiXHUyNzRDIEkgY291bGRuJ3QgZ2V0IHRoYXQgc2VydmVyJ3MgaWNvbiBcdTIwMTQgSSBuZWVkIHRvIGJlIGEgbWVtYmVyIG9mIGl0LCBhbmQgaXQgbXVzdCBoYXZlIGFuIGljb24gc2V0LlwiLFxuICAgICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBpZiAoIXNvdXJjZSkge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLnJlcGx5KHtcbiAgICAgIGNvbnRlbnQ6IFwiXHUyNzRDIFRoaXMgc2VydmVyIGRvZXNuJ3QgaGF2ZSBhbiBpY29uIHNldC4gUGljayBhIG1lbWJlciBvciB1cGxvYWQgYW4gaW1hZ2UgaW5zdGVhZC5cIixcbiAgICAgIGZsYWdzOiBNZXNzYWdlRmxhZ3MuRXBoZW1lcmFsLFxuICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBhd2FpdCBpbnRlcmFjdGlvbi5kZWZlclVwZGF0ZSgpO1xuICBhd2FpdCBlbnRlclN0eWxlQnJvd3NlcihpbnRlcmFjdGlvbiwgdG9rZW4sIHNvdXJjZSk7XG59XG5cbi8qKlxuICogTG9hZCBgc291cmNlYCBpbnRvIHRoZSBzZXNzaW9uIGFuZCByZW5kZXIgdGhlIHN0eWxlIGJyb3dzZXIuXG4gKlxuICogU2hhcmVkIGJ5IGV2ZXJ5IHdheSBvZiBjaG9vc2luZyBvciBjaGFuZ2luZyBhIHRhcmdldC4gQW55IGNhY2hlZCByZXN1bHQgZnJvbSBhXG4gKiBwcmV2aW91cyBpbWFnZSBpcyBkcm9wcGVkIFx1MjAxNCBpdCBiZWxvbmdzIHRvIHRoZSBvbGQgc3ViamVjdCwgYW5kIGtlZXBpbmcgaXRcbiAqIHdvdWxkIGxldCBBcHBseSBvciBQb3N0IHVzZSB0aGUgd3Jvbmcgb25lLlxuICovXG5hc3luYyBmdW5jdGlvbiBlbnRlclN0eWxlQnJvd3NlcihcbiAgaW50ZXJhY3Rpb246IE1lc3NhZ2VDb21wb25lbnRJbnRlcmFjdGlvbiB8IE1vZGFsU3VibWl0SW50ZXJhY3Rpb24sXG4gIHRva2VuOiBzdHJpbmcsXG4gIHNvdXJjZTogU291cmNlLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgaW1hZ2UgPSBhd2FpdCBsb2FkU291cmNlKHNvdXJjZS51cmwpO1xuICAgIGNvbnN0IGN1cnJlbnQgPSBnZXRTZXNzaW9uKHRva2VuKTtcbiAgICBjb25zdCB1cGRhdGVkID0gdG91Y2hTZXNzaW9uKHRva2VuLCB7XG4gICAgICBpbWFnZSxcbiAgICAgIHNvdXJjZUxhYmVsOiBzb3VyY2UubGFiZWwsXG4gICAgICB2aWV3OiBcInN0eWxlc1wiLFxuICAgICAgc3R5bGVQYWdlOiAwLFxuICAgICAgc3R5bGVGb2N1czogY3VycmVudD8uYW5pbWF0aW9uID8/IG51bGwsXG4gICAgICBsYXN0UmVzdWx0OiB1bmRlZmluZWQsXG4gICAgfSk7XG4gICAgaWYgKCF1cGRhdGVkKSByZXR1cm47XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGF3YWl0IGJ1aWxkU3R5bGVzUGlja2VyKHVwZGF0ZWQsIHRva2VuKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShmYWlsdXJlUmVwbHkoZXJyLCB0b2tlbikpO1xuICB9XG59XG5cbi8qKiBTd2FwIHRoZSBpbWFnZSBiZWluZyBhbmltYXRlZCB0byB0aGUgc2VydmVyIGljb24gb3IgdGhlIGNhbGxlcidzIGF2YXRhci4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVRhcmdldEFjdGlvbihcbiAgaW50ZXJhY3Rpb246IEJ1dHRvbkludGVyYWN0aW9uLFxuICBzZXNzaW9uOiBFbW9qaVNlc3Npb24sXG4gIHRva2VuOiBzdHJpbmcsXG4gIGFjdGlvbjogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGFjdGlvbiA9PT0gXCJ0YXJnZXRfc2VydmVyXCJcbiAgICA/IHNlcnZlckljb25Tb3VyY2UoaW50ZXJhY3Rpb24pXG4gICAgOiB7XG4gICAgICAgIHVybDogaW50ZXJhY3Rpb24udXNlci5kaXNwbGF5QXZhdGFyVVJMKHsgZXh0ZW5zaW9uOiBcInBuZ1wiLCBzaXplOiBBVkFUQVJfU0laRSB9KSxcbiAgICAgICAgbGFiZWw6IFwieW91ciBhdmF0YXJcIixcbiAgICAgIH07XG5cbiAgaWYgKCFzb3VyY2UpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5yZXBseSh7XG4gICAgICBjb250ZW50OiBcIlx1Mjc0QyBUaGlzIHNlcnZlciBkb2Vzbid0IGhhdmUgYW4gaWNvbiBzZXQuXCIsXG4gICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGltYWdlID0gYXdhaXQgbG9hZFNvdXJjZShzb3VyY2UudXJsKTtcbiAgICAvLyBUaGUgY2FjaGVkIHJlc3VsdCBiZWxvbmdzIHRvIHRoZSBvbGQgaW1hZ2UsIHNvIGl0IG11c3Qgbm90IHN1cnZpdmUgYVxuICAgIC8vIHRhcmdldCBzd2l0Y2ggXHUyMDE0IG90aGVyd2lzZSBQb3N0IHdvdWxkIHNlbmQgdGhlIHByZXZpb3VzIHN1YmplY3QuXG4gICAgY29uc3QgdXBkYXRlZCA9IHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgaW1hZ2UsIHNvdXJjZUxhYmVsOiBzb3VyY2UubGFiZWwsIHZpZXc6IFwiY29udHJvbHNcIiwgbGFzdFJlc3VsdDogdW5kZWZpbmVkLFxuICAgIH0pO1xuICAgIGlmICghdXBkYXRlZCkgcmV0dXJuO1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShhd2FpdCBidWlsZFJlcGx5KHVwZGF0ZWQsIHRva2VuKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShmYWlsdXJlUmVwbHkoZXJyLCB0b2tlbikpO1xuICB9XG59XG5cbi8qKlxuICogRmlyZS1hbmQtZm9yZ2V0OiBsb2FkIHRoZSBjYWxsZXIncyBhdmF0YXIgYW5kIHdhcm0gaXRzIGxpa2VseSBib2FyZHMsIHNvIHRoZVxuICogZmlyc3QgdGFyZ2V0IHBpY2sgKG9yIHRoZSBGYXZvcml0ZXMgc2hvcnRjdXQpIGlzIGEgY2FjaGUgaGl0LiBOZXZlciBhd2FpdGVkIGFuZFxuICogbmV2ZXIgc3VyZmFjZXMgYW4gZXJyb3IgXHUyMDE0IGEgZmFpbGVkIHdhcm0ganVzdCBtZWFucyB0aGUgYm9hcmQgcmVuZGVycyBvbiBkZW1hbmQuXG4gKi9cbmZ1bmN0aW9uIHdhcm1PcGVuaW5nQXZhdGFyKFxuICBpbnRlcmFjdGlvbjogQ2hhdElucHV0Q29tbWFuZEludGVyYWN0aW9uLCBhbmltYXRpb246IHN0cmluZywgZm9ybWF0OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgdXJsID0gaW50ZXJhY3Rpb24udXNlci5kaXNwbGF5QXZhdGFyVVJMKHsgZXh0ZW5zaW9uOiBcInBuZ1wiLCBzaXplOiBBVkFUQVJfU0laRSB9KTtcbiAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGltYWdlID0gYXdhaXQgbG9hZFNvdXJjZSh1cmwpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmIChpbWFnZSkgd2FybVRhcmdldEJvYXJkcyhpbWFnZSwgaW50ZXJhY3Rpb24udXNlci5pZCwgXCJ5b3VyIGF2YXRhclwiLCBhbmltYXRpb24sIGZvcm1hdCk7XG4gIH0pKCk7XG59XG5cbi8qKiBTZW5kIHRoZSBmaW5pc2hlZCBlbW9qaSB0byBhIGNoYW5uZWwgdGhlIHVzZXIgcGlja3MuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVQb3N0QWN0aW9uKFxuICBpbnRlcmFjdGlvbjogTWVzc2FnZUNvbXBvbmVudEludGVyYWN0aW9uLFxuICBzZXNzaW9uOiBFbW9qaVNlc3Npb24sXG4gIHRva2VuOiBzdHJpbmcsXG4gIGFjdGlvbjogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChhY3Rpb24gPT09IFwicG9zdFwiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBpZiAoIXNlc3Npb24ubGFzdFJlc3VsdCkge1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24ucmVwbHkoe1xuICAgICAgICBjb250ZW50OiBcIlx1Mjc0QyBOb3RoaW5nIHRvIHBvc3QgeWV0IFx1MjAxNCBnZW5lcmF0ZSBhbiBlbW9qaSBmaXJzdC5cIixcbiAgICAgICAgZmxhZ3M6IE1lc3NhZ2VGbGFncy5FcGhlbWVyYWwsXG4gICAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwgeyB2aWV3OiBcInBvc3RcIiB9KTtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi51cGRhdGUoYnVpbGRQb3N0UGlja2VyKHNlc3Npb24sIHRva2VuKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGFjdGlvbiA9PT0gXCJwb3N0X2JhY2tcIiAmJiBpbnRlcmFjdGlvbi5pc0J1dHRvbigpKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKTtcbiAgICBjb25zdCB1cGRhdGVkID0gdG91Y2hTZXNzaW9uKHRva2VuLCB7IHZpZXc6IFwiY29udHJvbHNcIiB9KTtcbiAgICBpZiAoIXVwZGF0ZWQpIHJldHVybjtcbiAgICAvLyBSZXVzZSB0aGUgc3RvcmVkIGJ5dGVzIHJhdGhlciB0aGFuIHJlZ2VuZXJhdGluZyBqdXN0IHRvIHJlZHJhdyB0aGUgcGFuZWwuXG4gICAgY29uc3QgcmVwbHkgPSBidWlsZENhY2hlZENvbnRyb2xzUmVwbHkodXBkYXRlZCwgdG9rZW4pO1xuICAgIGlmIChyZXBseSkgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KHJlcGx5KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoYWN0aW9uICE9PSBcInBvc3RfcGlja1wiIHx8ICFpbnRlcmFjdGlvbi5pc0NoYW5uZWxTZWxlY3RNZW51KCkpIHJldHVybjtcblxuICBjb25zdCByZXN1bHQgPSBzZXNzaW9uLmxhc3RSZXN1bHQ7XG4gIGNvbnN0IGNoYW5uZWxJZCA9IGludGVyYWN0aW9uLnZhbHVlc1swXTtcbiAgaWYgKCFyZXN1bHQgfHwgIWNoYW5uZWxJZCkgcmV0dXJuO1xuXG4gIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyVXBkYXRlKCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjaGFubmVsID0gYXdhaXQgaW50ZXJhY3Rpb24uY2xpZW50LmNoYW5uZWxzLmZldGNoKGNoYW5uZWxJZCk7XG4gICAgaWYgKCFjaGFubmVsPy5pc1RleHRCYXNlZCgpIHx8ICEoXCJzZW5kXCIgaW4gY2hhbm5lbCkpIHtcbiAgICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFwiaW50ZXJuYWxcIiwgXCJUaGF0IGNoYW5uZWwgY2FuJ3QgcmVjZWl2ZSBtZXNzYWdlcy5cIik7XG4gICAgfVxuXG4gICAgLy8gSnVzdCB0aGUgZmlsZSBcdTIwMTQgbm8gY29udGVudCwgbm8gYXV0aG9yIGZyYW1pbmcgXHUyMDE0IHNvIGl0IGxhbmRzIGluIHRoZVxuICAgIC8vIGNoYW5uZWwgbGlrZSBhIHBsYWluIGdpZiBzb21lb25lIGRyb3BwZWQsIG5vdCBhIGJvdCBhbm5vdW5jZW1lbnQuXG4gICAgYXdhaXQgY2hhbm5lbC5zZW5kKHtcbiAgICAgIGZpbGVzOiBbbmV3IEF0dGFjaG1lbnRCdWlsZGVyKHJlc3VsdC5idWZmZXIsIHtcbiAgICAgICAgbmFtZTogYGVtb2ppLiR7ZXh0ZW5zaW9uRm9yKHJlc3VsdC5mb3JtYXQpfWAsXG4gICAgICB9KV0sXG4gICAgfSk7XG5cbiAgICBjb25zdCB1cGRhdGVkID0gdG91Y2hTZXNzaW9uKHRva2VuLCB7IHZpZXc6IFwiY29udHJvbHNcIiB9KSA/PyBzZXNzaW9uO1xuICAgIGNvbnN0IHJlcGx5ID0gYnVpbGRDYWNoZWRDb250cm9sc1JlcGx5KHVwZGF0ZWQsIHRva2VuKTtcbiAgICBpZiAocmVwbHkpIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseShyZXBseSk7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZm9sbG93VXAoe1xuICAgICAgY29udGVudDogYFx1MjcwNSBQb3N0ZWQgdG8gPCMke2NoYW5uZWxJZH0+LmAsXG4gICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEEgbWlzc2luZy1wZXJtaXNzaW9ucyBmYWlsdXJlIGlzIHRoZSBjb21tb24gY2FzZSBhbmQgaXMgdGhlIHVzZXIncyB0byBmaXgsXG4gICAgLy8gc28gaXQgaXMgcmVwb3J0ZWQgcGxhaW5seSByYXRoZXIgdGhhbiBsb2dnZWQgYXMgYSBib3QgZmF1bHQuXG4gICAgbG9nZ2VyLndhcm4oXG4gICAgICB7IGVycjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLCBjaGFubmVsSWQgfSxcbiAgICAgIFwiY291bGQgbm90IHBvc3QgZW1vamkgdG8gY2hhbm5lbFwiLFxuICAgICk7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZm9sbG93VXAoe1xuICAgICAgY29udGVudDogXCJcdTI3NEMgQ291bGRuJ3QgcG9zdCB0aGVyZSBcdTIwMTQgSSBtYXkgbm90IGhhdmUgcGVybWlzc2lvbiB0byBzZW5kIG1lc3NhZ2VzIG9yIGF0dGFjaCBmaWxlcyBpbiB0aGF0IGNoYW5uZWwuXCIsXG4gICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cbn1cblxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVVcGxvYWRBY3Rpb24oXG4gIGludGVyYWN0aW9uOiBNZXNzYWdlQ29tcG9uZW50SW50ZXJhY3Rpb24gfCBNb2RhbFN1Ym1pdEludGVyYWN0aW9uLFxuICB0b2tlbjogc3RyaW5nLFxuICBhY3Rpb246IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoYWN0aW9uID09PSBcInVwbG9hZFwiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5zaG93TW9kYWwoYnVpbGRVcGxvYWRNb2RhbCh0b2tlbikpLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoYWN0aW9uICE9PSBcInVwbG9hZF9tb2RhbFwiIHx8ICFpbnRlcmFjdGlvbi5pc01vZGFsU3VibWl0KCkpIHJldHVybjtcblxuICBjb25zdCBmaWxlcyA9IGludGVyYWN0aW9uLmZpZWxkcy5nZXRVcGxvYWRlZEZpbGVzKFwiaW1hZ2VcIiwgZmFsc2UpO1xuICBjb25zdCBhdHRhY2htZW50ID0gZmlsZXM/LmZpcnN0KCk7XG4gIGlmICghYXR0YWNobWVudCkge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLnJlcGx5KHtcbiAgICAgIGNvbnRlbnQ6IFwiXHUyNzRDIE5vIGltYWdlIHdhcyBhdHRhY2hlZC4gVGFwICoqVXBsb2FkIGltYWdlKiogYWdhaW4gYW5kIHBpY2sgYSBmaWxlLlwiLFxuICAgICAgZmxhZ3M6IE1lc3NhZ2VGbGFncy5FcGhlbWVyYWwsXG4gICAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHR5cGUgPSBhdHRhY2htZW50LmNvbnRlbnRUeXBlPy50b0xvd2VyQ2FzZSgpID8/IFwiXCI7XG4gIGlmICh0eXBlICYmICF0eXBlLnN0YXJ0c1dpdGgoXCJpbWFnZS9cIikpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5yZXBseSh7XG4gICAgICBjb250ZW50OiBcIlx1Mjc0QyBUaGF0IGF0dGFjaG1lbnQgaXNuJ3QgYW4gaW1hZ2UuIFVwbG9hZCBhIFBORywgSlBHLCBHSUYsIG9yIFdlYlAuXCIsXG4gICAgICBmbGFnczogTWVzc2FnZUZsYWdzLkVwaGVtZXJhbCxcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKTtcblxuICB0cnkge1xuICAgIGF3YWl0IGVudGVyU3R5bGVCcm93c2VyKGludGVyYWN0aW9uLCB0b2tlbiwge1xuICAgICAgdXJsOiBhdHRhY2htZW50LnVybCxcbiAgICAgIGxhYmVsOiBhdHRhY2htZW50Lm5hbWUgPz8gXCJ5b3VyIHVwbG9hZFwiLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoZmFpbHVyZVJlcGx5KGVyciwgdG9rZW4pKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVTdHlsZXNBY3Rpb24oXG4gIGludGVyYWN0aW9uOiBNZXNzYWdlQ29tcG9uZW50SW50ZXJhY3Rpb24gfCBNb2RhbFN1Ym1pdEludGVyYWN0aW9uLFxuICBzZXNzaW9uOiBFbW9qaVNlc3Npb24sXG4gIHRva2VuOiBzdHJpbmcsXG4gIGFjdGlvbjogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFNlYXJjaCBidXR0b24gXHUyMTkyIHNlYXJjaC1vbmx5IG1vZGFsIChtdXN0IG5vdCBkZWZlciBmaXJzdCkuXG4gIGlmIChhY3Rpb24gPT09IFwic3R5bGVzX3NlYXJjaFwiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5zaG93TW9kYWwoXG4gICAgICBidWlsZFN0eWxlU2VhcmNoTW9kYWwodG9rZW4sIHNlc3Npb24uc3R5bGVRdWVyeSA/PyBcIlwiKSxcbiAgICApLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBHbyB0byBwYWdlIGJ1dHRvbiBcdTIxOTIgYSBwYWdlLW51bWJlci1vbmx5IG1vZGFsLlxuICBpZiAoYWN0aW9uID09PSBcInN0eWxlc19nb3RvXCIgJiYgaW50ZXJhY3Rpb24uaXNCdXR0b24oKSkge1xuICAgIGNvbnN0IHsgcGFnZSwgcGFnZXMgfSA9IHBhZ2VTdHlsZXMoc2Vzc2lvbiwgc2Vzc2lvbi5vd25lcklkKTtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5zaG93TW9kYWwoYnVpbGRHb3RvUGFnZU1vZGFsKHRva2VuLCBwYWdlcywgcGFnZSkpLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoYWN0aW9uID09PSBcInN0eWxlc19tb2RhbFwiICYmIGludGVyYWN0aW9uLmlzTW9kYWxTdWJtaXQoKSkge1xuICAgIGNvbnN0IHF1ZXJ5ID0gaW50ZXJhY3Rpb24uZmllbGRzLmdldFRleHRJbnB1dFZhbHVlKFwicXVlcnlcIikudHJpbSgpO1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyVXBkYXRlKCkuY2F0Y2goKCkgPT4ge30pO1xuXG4gICAgLy8gQSBjaGFuZ2VkIHNlYXJjaCBqdW1wcyB0byB0aGUgZmlyc3QgcGFnZSBvZiB0aGUgbmV3IHJlc3VsdHM7IGFuIHVuY2hhbmdlZFxuICAgIC8vIG9uZSBsZWF2ZXMgdGhlIHVzZXIgd2hlcmUgdGhleSB3ZXJlLlxuICAgIGNvbnN0IHF1ZXJ5Q2hhbmdlZCA9IHF1ZXJ5ICE9PSAoc2Vzc2lvbi5zdHlsZVF1ZXJ5ID8/IFwiXCIpO1xuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgdmlldzogXCJzdHlsZXNcIiwgc3R5bGVRdWVyeTogcXVlcnksIHN0eWxlRm9jdXM6IG51bGwsXG4gICAgICAuLi4ocXVlcnlDaGFuZ2VkID8geyBzdHlsZVBhZ2U6IDAgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBjb25zdCB1cGRhdGVkID0gZ2V0U2Vzc2lvbih0b2tlbik7XG4gICAgaWYgKCF1cGRhdGVkKSByZXR1cm47XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGF3YWl0IGJ1aWxkU3R5bGVzUGlja2VyKHVwZGF0ZWQsIHRva2VuKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNfZ290b19tb2RhbFwiICYmIGludGVyYWN0aW9uLmlzTW9kYWxTdWJtaXQoKSkge1xuICAgIGNvbnN0IHBhZ2VSYXcgPSBpbnRlcmFjdGlvbi5maWVsZHMuZ2V0VGV4dElucHV0VmFsdWUoXCJwYWdlXCIpLnRyaW0oKTtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5kZWZlclVwZGF0ZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBjb25zdCByZXF1ZXN0ZWQgPSBOdW1iZXIucGFyc2VJbnQocGFnZVJhdywgMTApO1xuICAgIGlmIChwYWdlUmF3ICYmIE51bWJlci5pc0Zpbml0ZShyZXF1ZXN0ZWQpKSB7XG4gICAgICAvLyAxLWJhc2VkIGluIHRoZSBVSSwgMC1iYXNlZCBpbnRlcm5hbGx5LCBjbGFtcGVkIHRvIHRoZSByZWFsIHJhbmdlLlxuICAgICAgY29uc3QgbWF4UGFnZSA9IHRvdGFsU3R5bGVQYWdlcyhzZXNzaW9uLCBzZXNzaW9uLm93bmVySWQpIC0gMTtcbiAgICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgICBzdHlsZVBhZ2U6IE1hdGgubWluKE1hdGgubWF4KDAsIHJlcXVlc3RlZCAtIDEpLCBtYXhQYWdlKSxcbiAgICAgICAgc3R5bGVGb2N1czogbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCB1cGRhdGVkID0gZ2V0U2Vzc2lvbih0b2tlbik7XG4gICAgaWYgKCF1cGRhdGVkKSByZXR1cm47XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGF3YWl0IGJ1aWxkU3R5bGVzUGlja2VyKHVwZGF0ZWQsIHRva2VuKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCFpbnRlcmFjdGlvbi5pc01lc3NhZ2VDb21wb25lbnQoKSkgcmV0dXJuO1xuXG4gIC8vIEFwcGx5IHNlbGVjdGVkIChvciBmb2N1c2VkKSBzdHlsZSBcdTIxOTIgcmVnZW5lcmF0ZSB3aXRoIHRoZSB1c2VyJ3MgaW1hZ2UuXG4gIGlmIChhY3Rpb24gPT09IFwic3R5bGVzX2FwcGx5XCIgJiYgaW50ZXJhY3Rpb24uaXNCdXR0b24oKSkge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyVXBkYXRlKCk7XG4gICAgY29uc3QgZm9jdXMgPSBlbnN1cmVTdHlsZUZvY3VzKHNlc3Npb24sIHNlc3Npb24ub3duZXJJZCk7XG4gICAgaWYgKCFmaW5kU3R5bGUoZm9jdXMpKSB7XG4gICAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoYXdhaXQgYnVpbGRTdHlsZXNQaWNrZXIoc2Vzc2lvbiwgdG9rZW4pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgdXBkYXRlZCA9IHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgYW5pbWF0aW9uOiBmb2N1cyxcbiAgICAgIHN0eWxlRm9jdXM6IGZvY3VzLFxuICAgICAgdmlldzogXCJjb250cm9sc1wiLFxuICAgIH0pO1xuICAgIGlmICghdXBkYXRlZCkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoYXdhaXQgYnVpbGRSZXBseSh1cGRhdGVkLCB0b2tlbikpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGZhaWx1cmVSZXBseShlcnIsIHRva2VuKSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENoYW5nZSB0YXJnZXQgZnJvbSBpbnNpZGUgdGhlIGJvYXJkIFx1MjAxNCByZXR1cm4gdG8gdGhlIG9wZW5pbmcgY2hvb3Nlciwga2VlcGluZ1xuICAvLyB0aGUgc2Vzc2lvbiBzbyB0aGUgcGlja2VkIHN0eWxlIHN1cnZpdmVzIHRoZSByb3VuZC10cmlwLlxuICBpZiAoYWN0aW9uID09PSBcInN0eWxlc190YXJnZXRcIiAmJiBpbnRlcmFjdGlvbi5pc0J1dHRvbigpKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJVcGRhdGUoKTtcbiAgICB0b3VjaFNlc3Npb24odG9rZW4sIHsgdmlldzogXCJ0YXJnZXRcIiB9KTtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoYnVpbGRUYXJnZXRDaG9vc2VyKHRva2VuKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQmFjayB0byB0aGUgY29udHJvbCBwYW5lbCB3aXRob3V0IHJlZ2VuZXJhdGluZyB3aGVuIHdlIHN0aWxsIGhhdmUgYSBjYWNoZS5cbiAgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNfYmFja1wiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICBhd2FpdCBpbnRlcmFjdGlvbi5kZWZlclVwZGF0ZSgpO1xuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwgeyB2aWV3OiBcImNvbnRyb2xzXCIgfSk7XG4gICAgY29uc3QgdXBkYXRlZCA9IGdldFNlc3Npb24odG9rZW4pO1xuICAgIGlmICghdXBkYXRlZCkgcmV0dXJuO1xuICAgIGNvbnN0IGNhY2hlZCA9IGJ1aWxkQ2FjaGVkQ29udHJvbHNSZXBseSh1cGRhdGVkLCB0b2tlbik7XG4gICAgaWYgKGNhY2hlZCkge1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGNhY2hlZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoYXdhaXQgYnVpbGRSZXBseSh1cGRhdGVkLCB0b2tlbikpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KGZhaWx1cmVSZXBseShlcnIsIHRva2VuKSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyVXBkYXRlKCk7XG5cbiAgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNcIikge1xuICAgIC8vIFJldHVybmluZyB0byB0aGUgYnJvd3NlciAoZS5nLiBcIkJyb3dzZSBzdHlsZXNcIiBmcm9tIHRoZSBwYW5lbCkga2VlcHMgdGhlXG4gICAgLy8gcGFnZSB0aGUgdXNlciBsYXN0IGxlZnQgb2ZmIG9uIFx1MjAxNCBub3QgYSBqYXJyaW5nIGp1bXAgYmFjayB0byBwYWdlIDEgXHUyMDE0IGFuZFxuICAgIC8vIGZvY3VzZXMgdGhlIHN0eWxlIGN1cnJlbnRseSBhcHBsaWVkLlxuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgdmlldzogXCJzdHlsZXNcIixcbiAgICAgIHN0eWxlRm9jdXM6IHNlc3Npb24uYW5pbWF0aW9uLFxuICAgIH0pO1xuICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNfcHJldlwiKSB7XG4gICAgdG91Y2hTZXNzaW9uKHRva2VuLCB7XG4gICAgICBzdHlsZVBhZ2U6IE1hdGgubWF4KDAsIChzZXNzaW9uLnN0eWxlUGFnZSA/PyAwKSAtIDEpLFxuICAgICAgc3R5bGVGb2N1czogbnVsbCxcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChhY3Rpb24gPT09IFwic3R5bGVzX25leHRcIikge1xuICAgIHRvdWNoU2Vzc2lvbih0b2tlbiwge1xuICAgICAgc3R5bGVQYWdlOiAoc2Vzc2lvbi5zdHlsZVBhZ2UgPz8gMCkgKyAxLFxuICAgICAgc3R5bGVGb2N1czogbnVsbCxcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChhY3Rpb24gPT09IFwic3R5bGVzX2ZpbHRlclwiICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICB0b3VjaFNlc3Npb24odG9rZW4sIHtcbiAgICAgIHN0eWxlRmlsdGVyOiBzZXNzaW9uLnN0eWxlRmlsdGVyID09PSBcImZhdm9yaXRlc1wiID8gXCJhbGxcIiA6IFwiZmF2b3JpdGVzXCIsXG4gICAgICBzdHlsZVBhZ2U6IDAsXG4gICAgICBzdHlsZUZvY3VzOiBudWxsLFxuICAgIH0pO1xuICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNfZmF2XCIgJiYgaW50ZXJhY3Rpb24uaXNCdXR0b24oKSkge1xuICAgIGNvbnN0IGZvY3VzID0gZW5zdXJlU3R5bGVGb2N1cyhzZXNzaW9uLCBzZXNzaW9uLm93bmVySWQpO1xuICAgIGlmIChmaW5kU3R5bGUoZm9jdXMpKSB0b2dnbGVGYXZvcml0ZShzZXNzaW9uLm93bmVySWQsIGZvY3VzKTtcbiAgfSBlbHNlIGlmIChhY3Rpb24uc3RhcnRzV2l0aChcInN0eWxlc19uXCIpICYmIGludGVyYWN0aW9uLmlzQnV0dG9uKCkpIHtcbiAgICAvLyBOdW1iZXIgcGlja2VyOiB0aGUgbGFiZWwgaXMgdGhlIDEtYmFzZWQgY2VsbCwgdGhlIGFjdGlvbiBjYXJyaWVzIHRoZVxuICAgIC8vIDAtYmFzZWQgaW5kZXggaW50byB0aGlzIHBhZ2UncyBzdHlsZXMuXG4gICAgY29uc3QgaW5kZXggPSBOdW1iZXIucGFyc2VJbnQoYWN0aW9uLnNsaWNlKFwic3R5bGVzX25cIi5sZW5ndGgpLCAxMCk7XG4gICAgY29uc3QgeyByb3dzIH0gPSBwYWdlU3R5bGVzKHNlc3Npb24sIHNlc3Npb24ub3duZXJJZCk7XG4gICAgY29uc3QgcGljayA9IE51bWJlci5pc0ludGVnZXIoaW5kZXgpID8gcm93c1tpbmRleF0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKHBpY2spIHRvdWNoU2Vzc2lvbih0b2tlbiwgeyBzdHlsZUZvY3VzOiBwaWNrLnZhbHVlIH0pO1xuICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gXCJzdHlsZXNfcGFnZVwiICYmIGludGVyYWN0aW9uLmlzU3RyaW5nU2VsZWN0TWVudSgpKSB7XG4gICAgLy8gUGFnZS1qdW1wIGRyb3Bkb3duOiB2YWx1ZSBpcyB0aGUgMC1iYXNlZCBwYWdlIGluZGV4LlxuICAgIGNvbnN0IHRhcmdldCA9IE51bWJlci5wYXJzZUludChpbnRlcmFjdGlvbi52YWx1ZXNbMF0gPz8gXCJcIiwgMTApO1xuICAgIGlmIChOdW1iZXIuaXNJbnRlZ2VyKHRhcmdldCkpIHtcbiAgICAgIGNvbnN0IG1heFBhZ2UgPSB0b3RhbFN0eWxlUGFnZXMoc2Vzc2lvbiwgc2Vzc2lvbi5vd25lcklkKSAtIDE7XG4gICAgICB0b3VjaFNlc3Npb24odG9rZW4sIHtcbiAgICAgICAgc3R5bGVQYWdlOiBNYXRoLm1pbihNYXRoLm1heCgwLCB0YXJnZXQpLCBtYXhQYWdlKSxcbiAgICAgICAgc3R5bGVGb2N1czogbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB1cGRhdGVkID0gZ2V0U2Vzc2lvbih0b2tlbik7XG4gIGlmICghdXBkYXRlZCkgcmV0dXJuO1xuICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoYXdhaXQgYnVpbGRTdHlsZXNQaWNrZXIodXBkYXRlZCwgdG9rZW4pKTtcbn1cblxuLyoqIFN1Z2dlc3Rpb25zIGZvciB0aGUgbWFuaWZlc3QtZHJpdmVuIG9wdGlvbnMuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlRW1vamlBdXRvY29tcGxldGUoaW50ZXJhY3Rpb246IEF1dG9jb21wbGV0ZUludGVyYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGZvY3VzZWQgPSBpbnRlcmFjdGlvbi5vcHRpb25zLmdldEZvY3VzZWQodHJ1ZSk7XG4gIGlmICghaXNNYW5pZmVzdE9wdGlvbihmb2N1c2VkLm5hbWUpKSB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24ucmVzcG9uZChbXSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IGludGVyYWN0aW9uLnJlc3BvbmQoc3VnZ2VzdEZvcihmb2N1c2VkLm5hbWUsIFN0cmluZyhmb2N1c2VkLnZhbHVlID8/IFwiXCIpKSk7XG59XG5cbi8qKiBUcmFuc2xhdGUgYSBjb250cm9sJ3MgY3VzdG9tSWQgYWN0aW9uIGludG8gYSBzZXNzaW9uIHBhdGNoLiAqL1xuZnVuY3Rpb24gcGF0Y2hGb3IoXG4gIGFjdGlvbjogc3RyaW5nLFxuICBpbnRlcmFjdGlvbjogTWVzc2FnZUNvbXBvbmVudEludGVyYWN0aW9uLFxuKTogUGFydGlhbDxFbW9qaVNlc3Npb24+IHwgbnVsbCB7XG4gIGlmIChpbnRlcmFjdGlvbi5pc1N0cmluZ1NlbGVjdE1lbnUoKSAmJiBhY3Rpb24uc3RhcnRzV2l0aChcInNldF9cIikpIHtcbiAgICBjb25zdCBrZXkgPSBhY3Rpb24uc2xpY2UoXCJzZXRfXCIubGVuZ3RoKTtcbiAgICBjb25zdCB2YWx1ZSA9IGludGVyYWN0aW9uLnZhbHVlc1swXTtcbiAgICBpZiAoIXZhbHVlIHx8ICFpc01hbmlmZXN0T3B0aW9uKGtleSkpIHJldHVybiBudWxsO1xuICAgIC8vIFZhbHVlcyBjb21lIHN0cmFpZ2h0IGZyb20gdGhlIG1hbmlmZXN0LWJ1aWx0IG1lbnUsIGFuZCB0aGUgcHJvdmlkZXJcbiAgICAvLyB2YWxpZGF0ZXMgdGhlbSBhZ2FpbiBiZWZvcmUgYW55dGhpbmcgaXMgc2VudCB1cHN0cmVhbS5cbiAgICByZXR1cm4geyBba2V5XTogdmFsdWUgfSBhcyBQYXJ0aWFsPEVtb2ppU2Vzc2lvbj47XG4gIH1cblxuICBpZiAoaW50ZXJhY3Rpb24uaXNCdXR0b24oKSAmJiBhY3Rpb24uc3RhcnRzV2l0aChcImZvcm1hdF9cIikpIHtcbiAgICByZXR1cm4geyBmb3JtYXQ6IHBhcnNlRm9ybWF0KGFjdGlvbi5zbGljZShcImZvcm1hdF9cIi5sZW5ndGgpKSB9O1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFjQTtBQUFBLEVBQ0U7QUFBQSxFQUFtQjtBQUFBLE9BS2Q7QUFDUCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxxQkFBcUIscUJBQXFCO0FBRW5ELFNBQVMsWUFBWSxhQUFhLG9CQUFvQjtBQUN0RCxTQUFTLGFBQWEsb0JBQW9CO0FBQzFDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsa0JBQWtCLGtCQUFrQixlQUFlLGtCQUFrQjtBQUM5RTtBQUFBLEVBQ0U7QUFBQSxFQUFtQjtBQUFBLEVBQXVCO0FBQUEsRUFBb0I7QUFBQSxFQUM5RDtBQUFBLEVBQVc7QUFBQSxFQUFZO0FBQUEsRUFBaUI7QUFBQSxPQUNuQztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQTBCO0FBQUEsRUFBZTtBQUFBLEVBQW1CO0FBQUEsRUFDNUQ7QUFBQSxFQUFrQjtBQUFBLEVBQW9CO0FBQUEsRUFBa0I7QUFBQSxFQUFVO0FBQUEsRUFDbEU7QUFBQSxFQUFnQjtBQUFBLE9BQ1g7QUFDUCxTQUFTLGVBQWUsWUFBWSxZQUFZLG9CQUF1QztBQUN2RixTQUFTLHdCQUF3QjtBQUdqQyxNQUFNLGNBQWM7QUFXcEIsU0FBUyxpQkFBaUIsYUFBMEM7QUFDbEUsUUFBTSxRQUFRLFlBQVk7QUFDMUIsUUFBTSxNQUFNLE9BQU8sUUFBUSxFQUFFLFdBQVcsT0FBTyxNQUFNLFlBQVksQ0FBQztBQUNsRSxTQUFPLE1BQU0sRUFBRSxLQUFLLE9BQU8sR0FBRyxNQUFPLElBQUksVUFBVSxJQUFJO0FBQ3pEO0FBT0EsU0FBUyxjQUFjLGFBQWtEO0FBQ3ZFLFFBQU0sYUFBYSxZQUFZLFFBQVEsY0FBYyxPQUFPO0FBQzVELE1BQUksWUFBWTtBQUNkLFVBQU0s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QVEsT0FBTztBQUNwRCxVQUFNLE9BQU8sT0FBTyxVQUFVLEtBQUssSUFBSSxLQUFLLEtBQUssSUFBSTtBQUNyRCxRQUFJLEtBQU0sY0FBYSxPQUFPLEVBQUUsWUFBWSxLQUFLLE1BQU0sQ0FBQztBQUFBLEVBQzFELFdBQVcsV0FBVyxpQkFBaUIsWUFBWSxtQkFBbUIsR0FBRztBQUV2RSxVQUFNLFNBQVMsT0FBTyxTQUFTLFlBQVksT0FBTyxDQUFDLEtBQUssSUFBSSxFQUFFO0FBQzlELFFBQUksT0FBTyxVQUFVLE1BQU0sR0FBRztBQUM1QixZQUFNLFVBQVUsZ0JBQWdCLFNBQVMsUUFBUSxPQUFPLElBQUk7QUFDNUQsbUJBQWEsT0FBTztBQUFBLFFBQ2xCLFdBQVcsS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLE1BQU0sR0FBRyxPQUFPO0FBQUEsUUFDaEQsWUFBWTtBQUFBLE1BQ2QsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGLE9BQU87QUFDTDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFVBQVUsV0FBVyxLQUFLO0FBQ2hDLE1BQUksQ0FBQyxRQUFTO0FBQ2QsUUFBTSxZQUFZLFVBQVUsTUFBTSxrQkFBa0IsU0FBUyxLQUFLLENBQUM7QUFDckU7QUFHQSxlQUFzQix3QkFBd0IsYUFBcUQ7QUFDakcsUUFBTSxVQUFVLFlBQVksUUFBUSxXQUFXLElBQUk7QUFDbkQsTUFBSSxDQUFDLGlCQUFpQixRQUFRLElBQUksR0FBRztBQUNuQyxVQUFNLFlBQVksUUFBUSxDQUFDLENBQUM7QUFDNUI7QUFBQSxFQUNGO0FBQ0EsUUFBTSxZQUFZLFFBQVEsV0FBVyxRQUFRLE1BQU0sT0FBTyxRQUFRLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDakY7QUFHQSxTQUFTLFNBQ1AsUUFDQSxhQUM4QjtBQUM5QixNQUFJLFlBQVksbUJBQW1CLEtBQUssT0FBTyxXQUFXLE1BQU0sR0FBRztBQUNqRSxVQUFNLE1BQU0sT0FBTyxNQUFNLE9BQU8sTUFBTTtBQUN0QyxVQUFNLFFBQVEsWUFBWSxPQUFPLENBQUM7QUFDbEMsUUFBSSxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsR0FBRyxFQUFHLFFBQU87QUFHN0MsV0FBTyxFQUFFLENBQUMsR0FBRyxHQUFHLE1BQU07QUFBQSxFQUN4QjtBQUVBLE1BQUksWUFBWSxTQUFTLEtBQUssT0FBTyxXQUFXLFNBQVMsR0FBRztBQUMxRCxXQUFPLEVBQUUsUUFBUSxZQUFZLE9BQU8sTUFBTSxVQUFVLE1BQU0sQ0FBQyxFQUFFO0FBQUEsRUFDL0Q7QUFFQSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbImNyZWF0ZWQiLCAidXBkYXRlZCJdCn0K
