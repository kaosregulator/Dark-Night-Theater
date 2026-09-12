import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { fuzzyRank } from "../../search/fuse-service.js";
import { getManifest } from "../providers/makeemoji/manifest.js";
import { isFavorite, listFavorites } from "./favorites.js";
import { resolveStylePreviewUrl } from "./previews.js";
import { renderStylePreview } from "../preview/index.js";
import { renderBoard, BOARD_PAGE_SIZE } from "./board.js";
import { sceneStyleEntries } from "../providers/offline/scene-pack.js";
import { cid } from "./ui.js";
const PREVIEW_FILENAME = "style-preview.gif";
const STYLES_PAGE_SIZE = BOARD_PAGE_SIZE;
const MAX_STYLE_QUERY = 40;
const HIDDEN_STYLES = /* @__PURE__ */ new Set([
  "gen_btn_none",
  "gen_btn_3d-flip",
  "gen_btn_2x-wide-1",
  "gen_btn_2x-wide-2",
  "gen_btn_3x-wide-1",
  "gen_btn_3x-wide-2",
  "gen_btn_3x-wide-3",
  "gen_btn_4x-wide-1",
  "gen_btn_4x-wide-2",
  "gen_btn_4x-wide-3",
  "gen_btn_4x-wide-4"
]);
let _allStylesCache = null;
function allStyles() {
  if (_allStylesCache) return _allStylesCache;
  const scenes = sceneStyleEntries();
  const values = getManifest().manifest?.controls.animation?.values ?? [];
  const rows = values.map((v) => ({ value: v.value, label: v.label && v.label.trim() || v.value })).filter((r) => !HIDDEN_STYLES.has(r.value));
  rows.sort((a, b) => a.label.localeCompare(b.label));
  _allStylesCache = [...scenes, ...rows];
  return _allStylesCache;
}
function clearStylesCache() {
  _allStylesCache = null;
}
function findStyle(value) {
  return allStyles().find((s) => s.value === value);
}
function filteredStyles(session, userId) {
  let rows = allStyles();
  if (session.styleFilter === "favorites") {
    const favs = new Set(listFavorites(userId));
    rows = rows.filter((s) => favs.has(s.value));
    const order = listFavorites(userId);
    rows.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  }
  const query = session.styleQuery?.trim() ?? "";
  if (query) {
    rows = fuzzyRank(rows, query, (s) => s.label);
  }
  return rows;
}
function pageStyles(session, userId) {
  const rows = filteredStyles(session, userId);
  const pages = Math.max(1, Math.ceil(rows.length / STYLES_PAGE_SIZE));
  const page = Math.min(Math.max(0, session.stylePage ?? 0), pages - 1);
  const slice = rows.slice(page * STYLES_PAGE_SIZE, (page + 1) * STYLES_PAGE_SIZE);
  return { rows: slice, page, pages, total: rows.length };
}
function totalStylePages(session, userId) {
  return Math.max(1, Math.ceil(filteredStyles(session, userId).length / STYLES_PAGE_SIZE));
}
function ensureStyleFocus(session, userId) {
  const { rows } = pageStyles(session, userId);
  const focus = session.styleFocus;
  if (focus && rows.some((r) => r.value === focus)) return focus;
  if (focus && findStyle(focus)) return focus;
  if (rows.some((r) => r.value === session.animation)) return session.animation;
  return rows[0]?.value ?? session.animation;
}
function focusForSlice(slice, animation) {
  if (slice.some((r) => r.value === animation)) return animation;
  return slice[0]?.value ?? animation;
}
function prefetchNeighborBoards(session, userId, page, pages) {
  if (!session.image) return;
  const all = filteredStyles(session, userId);
  const image = session.image;
  const warm = (p) => {
    if (p < 0 || p >= pages) return;
    const start = p * STYLES_PAGE_SIZE;
    const slice = all.slice(start, start + STYLES_PAGE_SIZE);
    if (slice.length === 0) return;
    void renderBoard({
      image,
      targetLabel: session.sourceLabel ?? "your image",
      styles: slice,
      focusValue: focusForSlice(slice, session.animation),
      userId,
      page: p,
      pages,
      total: all.length,
      format: session.format,
      background: true
    }).catch(() => {
    });
  };
  warm(page + 1);
  warm(page - 1);
}
function warmTargetBoards(image, userId, sourceLabel, animation, format) {
  const all = allStyles();
  const warm = (styles, total, pageCount) => {
    if (styles.length === 0) return;
    void renderBoard({
      image,
      targetLabel: sourceLabel,
      styles,
      focusValue: focusForSlice(styles, animation),
      userId,
      page: 0,
      pages: pageCount,
      total,
      format,
      background: true
    }).catch(() => {
    });
  };
  const page1 = all.slice(0, STYLES_PAGE_SIZE);
  warm(page1, all.length, Math.max(1, Math.ceil(all.length / STYLES_PAGE_SIZE)));
  const favVals = new Set(listFavorites(userId));
  if (favVals.size > 0) {
    const favs = all.filter((s) => favVals.has(s.value));
    warm(favs.slice(0, STYLES_PAGE_SIZE), favs.length, Math.max(1, Math.ceil(favs.length / STYLES_PAGE_SIZE)));
  }
  void renderStylePreview(image, focusForSlice(page1, animation)).catch(() => {
  });
}
function buildStyleSearchModal(token, currentQuery) {
  return new ModalBuilder().setCustomId(cid("styles_modal", token)).setTitle("Search styles by name").addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("query").setLabel("Style name (leave empty to clear)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(MAX_STYLE_QUERY).setPlaceholder("e.g. rainbow, spin, portal \u2014 close spellings work").setValue(currentQuery.slice(0, MAX_STYLE_QUERY))
    )
  );
}
function buildGotoPageModal(token, pages, currentPage) {
  return new ModalBuilder().setCustomId(cid("styles_goto_modal", token)).setTitle("Go to page").addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("page").setLabel(`Page number (1\u2013${pages})`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`Currently on page ${currentPage + 1}`).setMaxLength(5)
    )
  );
}
function pageJumpTargets(current, pages) {
  const set = /* @__PURE__ */ new Set();
  set.add(0);
  set.add(pages - 1);
  for (let d = -2; d <= 2; d++) {
    const p = current + d;
    if (p >= 0 && p < pages) set.add(p);
  }
  const step = Math.max(1, Math.floor(pages / 12));
  for (let p = 0; p < pages; p += step) set.add(p);
  return [...set].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b).slice(0, 25);
}
async function buildStylesPicker(session, token) {
  const userId = session.ownerId;
  const focusValue = ensureStyleFocus(session, userId);
  session.styleFocus = focusValue;
  const focused = findStyle(focusValue);
  const label = focused?.label ?? focusValue;
  const { rows, page, pages, total } = pageStyles(session, userId);
  const favorited = isFavorite(userId, focusValue);
  const targetLabel = session.sourceLabel ?? "your image";
  const focusIndex = rows.findIndex((r) => r.value === focusValue);
  const [board, livePreview] = session.image ? await Promise.all([
    renderBoard({
      image: session.image,
      targetLabel,
      styles: rows,
      focusValue,
      userId,
      page,
      pages,
      total,
      format: session.format
    }),
    renderStylePreview(session.image, focusValue)
  ]) : [null, null];
  const previewUrl = livePreview ? null : focused ? await resolveStylePreviewUrl(focused.label) : null;
  prefetchNeighborBoards(session, userId, page, pages);
  const filters = [];
  if (session.styleFilter === "favorites") filters.push("\u2605 favorites");
  if (session.styleQuery?.trim()) filters.push(`search \u201C${session.styleQuery.trim()}\u201D`);
  const favView = session.styleFilter === "favorites";
  const emptyFavs = favView && total === 0;
  const numbered = focusIndex >= 0 ? `#${focusIndex + 1} \xB7 ` : "";
  const description = emptyFavs ? [
    "You haven't starred any styles yet.",
    "",
    "Tap **Show all**, open any style, and hit **\u2B50 Favorite** \u2014 it lands here for one-tap access next time."
  ].join("\n") : [
    `Selected: **${numbered}${label}** ${favorited ? "\u2605" : ""}`.trim(),
    `\`${focusValue}\` \xB7 type \`${session.format.toUpperCase()}\``,
    "",
    "Tap a **number** to select \u2014 the board rings your pick.",
    favView ? "**Apply** renders it on your target \xB7 **Unfavorite** removes it from this list." : "**Apply** renders it at full quality on your target."
  ].join("\n");
  const embed = new EmbedBuilder().setColor(favView ? 15844367 : favorited ? 15844367 : 5793266).setAuthor({ name: `\u{1F3AF} ${targetLabel}` }).setTitle(favView ? "\u2B50 Your Favorites" : "\u{1F3A8} Style Board").setDescription(description).setFooter({
    text: [
      `${total} ${favView ? "favorite" : "style"}${total === 1 ? "" : "s"}`,
      favView ? "\u2605 your list" : "all styles",
      `page ${page + 1}/${pages}`
    ].join(" \xB7 ")
  });
  const files = [];
  if (board) {
    files.push(new AttachmentBuilder(board.buffer, { name: board.name }));
    embed.setImage(`attachment://${board.name}`);
  }
  if (livePreview) {
    files.push(new AttachmentBuilder(livePreview, { name: PREVIEW_FILENAME }));
    embed.setThumbnail(`attachment://${PREVIEW_FILENAME}`);
  } else if (previewUrl) {
    embed.setThumbnail(previewUrl);
  }
  if (!board && !livePreview && !previewUrl) {
    embed.addFields({
      name: "Preview",
      value: "_No preview for this style \u2014 Apply still works._"
    });
  }
  const components = [];
  if (pages > 1) {
    const menu = new StringSelectMenuBuilder().setCustomId(cid("styles_page", token)).setPlaceholder(`Page ${page + 1} / ${pages} \u2014 jump to a page`).addOptions(pageJumpTargets(page, pages).map(
      (p) => new StringSelectMenuOptionBuilder().setLabel(`Page ${p + 1}${p === 0 ? " \xB7 first" : p === pages - 1 ? " \xB7 last" : ""}`).setDescription(p === page ? "you are here" : `jump to page ${p + 1}`).setValue(String(p)).setDefault(p === page)
    ));
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  for (let start = 0; start < rows.length; start += 4) {
    const chunk = rows.slice(start, start + 4);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map((s, j) => {
        const index = start + j;
        return new ButtonBuilder().setCustomId(cid(`styles_n${index}`, token)).setLabel(String(index + 1)).setStyle(index === focusIndex ? ButtonStyle.Primary : ButtonStyle.Secondary);
      })
    );
    components.push(row);
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid("styles_prev", token)).setEmoji("\u25C0\uFE0F").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(cid("styles_next", token)).setEmoji("\u25B6\uFE0F").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      new ButtonBuilder().setCustomId(cid("styles_goto", token)).setLabel("Go to page").setEmoji("\u{1F522}").setStyle(ButtonStyle.Secondary).setDisabled(pages <= 1),
      new ButtonBuilder().setCustomId(cid("styles_search", token)).setLabel(session.styleQuery?.trim() ? `Search: ${session.styleQuery.trim()}`.slice(0, 60) : "Search").setEmoji("\u{1F50D}").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid("styles_filter", token)).setLabel(session.styleFilter === "favorites" ? "Show all" : "Favorites").setEmoji("\u2B50").setStyle(session.styleFilter === "favorites" ? ButtonStyle.Success : ButtonStyle.Secondary)
    )
  );
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid("styles_fav", token)).setLabel(favorited ? "Unfavorite" : "Favorite").setEmoji(favorited ? "\u2606" : "\u2B50").setStyle(favorited ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(!focused),
      new ButtonBuilder().setCustomId(cid("styles_apply", token)).setLabel("Apply style").setEmoji("\u2705").setStyle(ButtonStyle.Success).setDisabled(!focused),
      new ButtonBuilder().setCustomId(cid("styles_target", token)).setLabel("Target").setEmoji("\u{1F3AF}").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid("styles_back", token)).setLabel("Back").setEmoji("\u21A9\uFE0F").setStyle(ButtonStyle.Secondary)
    )
  );
  return {
    content: "",
    embeds: [embed],
    components,
    files
  };
}
export {
  MAX_STYLE_QUERY,
  STYLES_PAGE_SIZE,
  allStyles,
  buildGotoPageModal,
  buildStyleSearchModal,
  buildStylesPicker,
  clearStylesCache,
  ensureStyleFocus,
  filteredStyles,
  findStyle,
  pageJumpTargets,
  pageStyles,
  totalStylePages,
  warmTargetBoards
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3R5bGVzLXBpY2tlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBWaXN1YWwgc3R5bGUgYnJvd3NlciBmb3IgL2Vtb2ppLlxuLy9cbi8vIFJlcGxhY2VzIHRoZSB0cnVuY2F0ZWQgMjUtb3B0aW9uIGFuaW1hdGlvbiBkcm9wZG93biB3aXRoIGEgcGFnaW5hdGVkIHBpY2tlclxuLy8gdGhhdCBzaG93cyBNYWtlRW1vamkncyBwcmVyZW5kZXJlZCBjYXQgcHJldmlldyBmb3IgdGhlIGZvY3VzZWQgc3R5bGUsIGxldHNcbi8vIHVzZXJzIHNlYXJjaCBieSBuYW1lLCBhbmQgcmVtZW1iZXJzIHBlci11c2VyIGZhdm9yaXRlcy5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbXBvcnQge1xuICBBY3Rpb25Sb3dCdWlsZGVyLCBCdXR0b25CdWlsZGVyLCBCdXR0b25TdHlsZSwgRW1iZWRCdWlsZGVyLFxuICBNb2RhbEJ1aWxkZXIsIFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyLCBTdHJpbmdTZWxlY3RNZW51T3B0aW9uQnVpbGRlcixcbiAgQXR0YWNobWVudEJ1aWxkZXIsXG4gIFRleHRJbnB1dEJ1aWxkZXIsIFRleHRJbnB1dFN0eWxlLCB0eXBlIEFQSUVtYmVkLFxufSBmcm9tIFwiZGlzY29yZC5qc1wiO1xuaW1wb3J0IHsgZnV6enlSYW5rIH0gZnJvbSBcIi4uLy4uL3NlYXJjaC9mdXNlLXNlcnZpY2UuanNcIjtcbmltcG9ydCB7IGdldE1hbmlmZXN0IH0gZnJvbSBcIi4uL3Byb3ZpZGVycy9tYWtlZW1vamkvbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGlzRmF2b3JpdGUsIGxpc3RGYXZvcml0ZXMgfSBmcm9tIFwiLi9mYXZvcml0ZXMuanNcIjtcbmltcG9ydCB7IHJlc29sdmVTdHlsZVByZXZpZXdVcmwgfSBmcm9tIFwiLi9wcmV2aWV3cy5qc1wiO1xuaW1wb3J0IHsgcmVuZGVyU3R5bGVQcmV2aWV3IH0gZnJvbSBcIi4uL3ByZXZpZXcvaW5kZXguanNcIjtcbmltcG9ydCB7IHJlbmRlckJvYXJkLCBCT0FSRF9QQUdFX1NJWkUgfSBmcm9tIFwiLi9ib2FyZC5qc1wiO1xuaW1wb3J0IHsgc2NlbmVTdHlsZUVudHJpZXMgfSBmcm9tIFwiLi4vcHJvdmlkZXJzL29mZmxpbmUvc2NlbmUtcGFjay5qc1wiO1xuaW1wb3J0IHR5cGUgeyBFbW9qaVNlc3Npb24gfSBmcm9tIFwiLi9zZXNzaW9uLmpzXCI7XG5pbXBvcnQgeyBjaWQgfSBmcm9tIFwiLi91aS5qc1wiO1xuXG4vKiogQXR0YWNobWVudCBuYW1lIHRoZSBhbmltYXRlZCBmb2N1cyBwcmV2aWV3IHBvaW50cyBhdCB3aXRoIGBhdHRhY2htZW50Oi8vYC4gKi9cbmNvbnN0IFBSRVZJRVdfRklMRU5BTUUgPSBcInN0eWxlLXByZXZpZXcuZ2lmXCI7XG5cbi8qKlxuICogU3R5bGVzIHBlciBib2FyZCBwYWdlLiBPbmUgc291cmNlIG9mIHRydXRoIHNvIHRoZSBjYW52YXMgZ3JpZCwgdGhlIG51bWJlclxuICogcGlja2VyLCBhbmQgcGFnaW5hdGlvbiBhbGwgYWdyZWUuXG4gKi9cbmV4cG9ydCBjb25zdCBTVFlMRVNfUEFHRV9TSVpFID0gQk9BUkRfUEFHRV9TSVpFO1xuXG4vKiogTWF4IHNlYXJjaCBxdWVyeSBsZW5ndGggaW4gdGhlIG1vZGFsLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9TVFlMRV9RVUVSWSA9IDQwO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0eWxlRW50cnkge1xuICB2YWx1ZTogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xufVxuXG4vKiogUGF5bG9hZCBzaGFwZSBhY2NlcHRlZCBieSBpbnRlcmFjdGlvbi5lZGl0UmVwbHkgZm9yIHRoZSBzdHlsZSBicm93c2VyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdHlsZXNQaWNrZXJSZXBseSB7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgZW1iZWRzOiAoRW1iZWRCdWlsZGVyIHwgQVBJRW1iZWQpW107XG4gIGNvbXBvbmVudHM6IEFjdGlvblJvd0J1aWxkZXI8U3RyaW5nU2VsZWN0TWVudUJ1aWxkZXIgfCBCdXR0b25CdWlsZGVyPltdO1xuICBmaWxlczogQXR0YWNobWVudEJ1aWxkZXJbXTtcbn1cblxuLyoqXG4gKiBTdHlsZXMgdGhhdCBkbyBub3RoaW5nIHVzZWZ1bCBvbiB0aGUgYm9hcmQgKHBsYWluIHRpbGluZyAvIHBhc3N0aHJvdWdoKSwgaGlkZGVuXG4gKiBmcm9tIHRoZSBwaWNrZXIgYXQgdGhlIHVzZXIncyByZXF1ZXN0LiBUaGV5IHN0YXkgaW4gdGhlIG1hbmlmZXN0IFx1MjAxNCBqdXN0IG5vdFxuICogb2ZmZXJlZCBhcyBvcHRpb25zLlxuICovXG5jb25zdCBISURERU5fU1RZTEVTID0gbmV3IFNldChbXG4gIFwiZ2VuX2J0bl9ub25lXCIsXG4gIFwiZ2VuX2J0bl8zZC1mbGlwXCIsXG4gIFwiZ2VuX2J0bl8yeC13aWRlLTFcIiwgXCJnZW5fYnRuXzJ4LXdpZGUtMlwiLFxuICBcImdlbl9idG5fM3gtd2lkZS0xXCIsIFwiZ2VuX2J0bl8zeC13aWRlLTJcIiwgXCJnZW5fYnRuXzN4LXdpZGUtM1wiLFxuICBcImdlbl9idG5fNHgtd2lkZS0xXCIsIFwiZ2VuX2J0bl80eC13aWRlLTJcIiwgXCJnZW5fYnRuXzR4LXdpZGUtM1wiLCBcImdlbl9idG5fNHgtd2lkZS00XCIsXG5dKTtcblxuLyoqXG4gKiBFdmVyeSBzdHlsZSB0aGUgcGlja2VyIG9mZmVyczogdGhlIGZlYXR1cmVkIGdyZWVuL2JsdWUtc2NyZWVuIHNjZW5lIHBhY2tzXG4gKiBmaXJzdCAoaW4gdGhlaXIgY3VyYXRlZCBvcmRlciksIHRoZW4gdGhlIE1ha2VFbW9qaSBjYXRhbG9nIGFscGhhYmV0aWNhbGx5LFxuICogbWludXMgdGhlIGhpZGRlbiB0aWxpbmcgc3R5bGVzLlxuICovXG4vKiogQ2FjaGVkIGNhdGFsb2cgXHUyMDE0IHN0eWxlcy5qc29uIC8gbWFuaWZlc3QgYmFyZWx5IGNoYW5nZSBhdCBydW50aW1lLiAqL1xubGV0IF9hbGxTdHlsZXNDYWNoZTogU3R5bGVFbnRyeVtdIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBhbGxTdHlsZXMoKTogU3R5bGVFbnRyeVtdIHtcbiAgaWYgKF9hbGxTdHlsZXNDYWNoZSkgcmV0dXJuIF9hbGxTdHlsZXNDYWNoZTtcbiAgY29uc3Qgc2NlbmVzID0gc2NlbmVTdHlsZUVudHJpZXMoKTtcbiAgY29uc3QgdmFsdWVzID0gZ2V0TWFuaWZlc3QoKS5tYW5pZmVzdD8uY29udHJvbHMuYW5pbWF0aW9uPy52YWx1ZXMgPz8gW107XG4gIGNvbnN0IHJvd3MgPSB2YWx1ZXNcbiAgICAubWFwKHYgPT4gKHsgdmFsdWU6IHYudmFsdWUsIGxhYmVsOiAodi5sYWJlbCAmJiB2LmxhYmVsLnRyaW0oKSkgfHwgdi52YWx1ZSB9KSlcbiAgICAuZmlsdGVyKHIgPT4gIUhJRERFTl9TVFlMRVMuaGFzKHIudmFsdWUpKTtcbiAgcm93cy5zb3J0KChhLCBiKSA9PiBhLmxhYmVsLmxvY2FsZUNvbXBhcmUoYi5sYWJlbCkpO1xuICBfYWxsU3R5bGVzQ2FjaGUgPSBbLi4uc2NlbmVzLCAuLi5yb3dzXTtcbiAgcmV0dXJuIF9hbGxTdHlsZXNDYWNoZTtcbn1cblxuLyoqIERyb3AgdGhlIHN0eWxlIGNhdGFsb2cgY2FjaGUgKHRlc3RzIC8gaG90LXJlbG9hZCBhZnRlciBhIG5ldyBvZmZsaW5lIHBhY2spLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3R5bGVzQ2FjaGUoKTogdm9pZCB7XG4gIF9hbGxTdHlsZXNDYWNoZSA9IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kU3R5bGUodmFsdWU6IHN0cmluZyk6IFN0eWxlRW50cnkgfCB1bmRlZmluZWQge1xuICByZXR1cm4gYWxsU3R5bGVzKCkuZmluZChzID0+IHMudmFsdWUgPT09IHZhbHVlKTtcbn1cblxuLyoqIFRoZSBmdWxsIGNhdGFsb2cgYWZ0ZXIgdGhlIHNlc3Npb24ncyBmYXZvcml0ZXMgZmlsdGVyIGFuZCBuYW1lIHNlYXJjaC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJlZFN0eWxlcyhzZXNzaW9uOiBFbW9qaVNlc3Npb24sIHVzZXJJZDogc3RyaW5nKTogU3R5bGVFbnRyeVtdIHtcbiAgbGV0IHJvd3MgPSBhbGxTdHlsZXMoKTtcblxuICBpZiAoc2Vzc2lvbi5zdHlsZUZpbHRlciA9PT0gXCJmYXZvcml0ZXNcIikge1xuICAgIGNvbnN0IGZhdnMgPSBuZXcgU2V0KGxpc3RGYXZvcml0ZXModXNlcklkKSk7XG4gICAgcm93cyA9IHJvd3MuZmlsdGVyKHMgPT4gZmF2cy5oYXMocy52YWx1ZSkpO1xuICAgIC8vIEtlZXAgdGhlIHVzZXIncyBmYXZvcml0ZSBvcmRlciAobW9zdCByZWNlbnQgZmlyc3QpLlxuICAgIGNvbnN0IG9yZGVyID0gbGlzdEZhdm9yaXRlcyh1c2VySWQpO1xuICAgIHJvd3Muc29ydCgoYSwgYikgPT4gb3JkZXIuaW5kZXhPZihhLnZhbHVlKSAtIG9yZGVyLmluZGV4T2YoYi52YWx1ZSkpO1xuICB9XG5cbiAgY29uc3QgcXVlcnkgPSBzZXNzaW9uLnN0eWxlUXVlcnk/LnRyaW0oKSA/PyBcIlwiO1xuICBpZiAocXVlcnkpIHtcbiAgICByb3dzID0gZnV6enlSYW5rKHJvd3MsIHF1ZXJ5LCBzID0+IHMubGFiZWwpO1xuICB9XG4gIHJldHVybiByb3dzO1xufVxuXG4vKiogRmlsdGVyICsgcGFnZSB0aGUgY2F0YWxvZyBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbiBwaWNrZXIgc3RhdGUuICovXG5leHBvcnQgZnVuY3Rpb24gcGFnZVN0eWxlcyhzZXNzaW9uOiBFbW9qaVNlc3Npb24sIHVzZXJJZDogc3RyaW5nKToge1xuICByb3dzOiBTdHlsZUVudHJ5W107XG4gIHBhZ2U6IG51bWJlcjtcbiAgcGFnZXM6IG51bWJlcjtcbiAgdG90YWw6IG51bWJlcjtcbn0ge1xuICBjb25zdCByb3dzID0gZmlsdGVyZWRTdHlsZXMoc2Vzc2lvbiwgdXNlcklkKTtcbiAgY29uc3QgcGFnZXMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwocm93cy5sZW5ndGggLyBTVFlMRVNfUEFHRV9TSVpFKSk7XG4gIGNvbnN0IHBhZ2UgPSBNYXRoLm1pbihNYXRoLm1heCgwLCBzZXNzaW9uLnN0eWxlUGFnZSA/PyAwKSwgcGFnZXMgLSAxKTtcbiAgY29uc3Qgc2xpY2UgPSByb3dzLnNsaWNlKHBhZ2UgKiBTVFlMRVNfUEFHRV9TSVpFLCAocGFnZSArIDEpICogU1RZTEVTX1BBR0VfU0laRSk7XG4gIHJldHVybiB7IHJvd3M6IHNsaWNlLCBwYWdlLCBwYWdlcywgdG90YWw6IHJvd3MubGVuZ3RoIH07XG59XG5cbi8qKiBUb3RhbCBwYWdlcyBmb3IgdGhlIHNlc3Npb24ncyBjdXJyZW50IGZpbHRlci9zZWFyY2ggXHUyMDE0IGZvciBjbGFtcGluZyBqdW1wcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b3RhbFN0eWxlUGFnZXMoc2Vzc2lvbjogRW1vamlTZXNzaW9uLCB1c2VySWQ6IHN0cmluZyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLmNlaWwoZmlsdGVyZWRTdHlsZXMoc2Vzc2lvbiwgdXNlcklkKS5sZW5ndGggLyBTVFlMRVNfUEFHRV9TSVpFKSk7XG59XG5cbi8qKiBFbnN1cmUgdGhlIHNlc3Npb24gaGFzIGEgc2Vuc2libGUgZm9jdXNlZCBzdHlsZSBmb3IgdGhlIGN1cnJlbnQgcGFnZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVTdHlsZUZvY3VzKHNlc3Npb246IEVtb2ppU2Vzc2lvbiwgdXNlcklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB7IHJvd3MgfSA9IHBhZ2VTdHlsZXMoc2Vzc2lvbiwgdXNlcklkKTtcbiAgY29uc3QgZm9jdXMgPSBzZXNzaW9uLnN0eWxlRm9jdXM7XG4gIGlmIChmb2N1cyAmJiByb3dzLnNvbWUociA9PiByLnZhbHVlID09PSBmb2N1cykpIHJldHVybiBmb2N1cztcbiAgaWYgKGZvY3VzICYmIGZpbmRTdHlsZShmb2N1cykpIHJldHVybiBmb2N1cztcbiAgLy8gUHJlZmVyIHRoZSBjdXJyZW50bHkgYXBwbGllZCBhbmltYXRpb24gd2hlbiBpdCdzIG9uIHRoaXMgcGFnZSAvIGNhdGFsb2cuXG4gIGlmIChyb3dzLnNvbWUociA9PiByLnZhbHVlID09PSBzZXNzaW9uLmFuaW1hdGlvbikpIHJldHVybiBzZXNzaW9uLmFuaW1hdGlvbjtcbiAgcmV0dXJuIHJvd3NbMF0/LnZhbHVlID8/IHNlc3Npb24uYW5pbWF0aW9uO1xufVxuXG4vKiogVGhlIGZvY3VzIGEgcGFnZSdzIHNsaWNlIHJlc29sdmVzIHRvIGFmdGVyIG5hdmlnYXRpb24gKGFwcGxpZWQgc3R5bGUgaWYgb24gaXQpLiAqL1xuZnVuY3Rpb24gZm9jdXNGb3JTbGljZShzbGljZTogU3R5bGVFbnRyeVtdLCBhbmltYXRpb246IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChzbGljZS5zb21lKHIgPT4gci52YWx1ZSA9PT0gYW5pbWF0aW9uKSkgcmV0dXJuIGFuaW1hdGlvbjtcbiAgcmV0dXJuIHNsaWNlWzBdPy52YWx1ZSA/PyBhbmltYXRpb247XG59XG5cbi8qKlxuICogV2FybSB0aGUgbmVpZ2hib3VyaW5nIHBhZ2VzJyBib2FyZHMgaW4gdGhlIGJhY2tncm91bmQuXG4gKlxuICogUGFnaW5nIGZlbHQgc2xvdyBiZWNhdXNlIGVhY2ggcGFnZSBjb21wb3NlZCBlaWdodCBmcmVzaCBzdHlsZSBHSUZzIG9uIGFycml2YWwuXG4gKiBXaGlsZSB0aGUgdXNlciBsb29rcyBhdCBwYWdlIE4gd2UgcmVuZGVyIE4rMSAqYW5kKiBOXHUyMjEyMSBpbnRvIHRoZSAoYm91bmRlZCxcbiAqIGNhY2hlZCkgYm9hcmQgc3RvcmUsIHNvIE5leHQgYW5kIFByZXYgdXN1YWxseSBoaXQgdGhlIGNhY2hlIGluc3RlYWQgb2YgYSBjb2xkXG4gKiBjb21wb3NlLiBUaGUgZm9jdXMgaXMgY2hvc2VuIHRoZSBzYW1lIHdheSBuYXZpZ2F0aW9uIHdvdWxkLCBzbyB0aGUgd2FybWVkIGtleVxuICogbWF0Y2hlcy4gV2FybXMgYXJlIGJlc3QtZWZmb3J0IGFuZCB5aWVsZCB0byBvbi1kZW1hbmQgcmVuZGVycyBpbiB0aGUgcXVldWUuXG4gKi9cbmZ1bmN0aW9uIHByZWZldGNoTmVpZ2hib3JCb2FyZHMoXG4gIHNlc3Npb246IEVtb2ppU2Vzc2lvbiwgdXNlcklkOiBzdHJpbmcsIHBhZ2U6IG51bWJlciwgcGFnZXM6IG51bWJlcixcbik6IHZvaWQge1xuICBpZiAoIXNlc3Npb24uaW1hZ2UpIHJldHVybjtcbiAgY29uc3QgYWxsID0gZmlsdGVyZWRTdHlsZXMoc2Vzc2lvbiwgdXNlcklkKTtcbiAgY29uc3QgaW1hZ2UgPSBzZXNzaW9uLmltYWdlO1xuICBjb25zdCB3YXJtID0gKHA6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgIGlmIChwIDwgMCB8fCBwID49IHBhZ2VzKSByZXR1cm47XG4gICAgY29uc3Qgc3RhcnQgPSBwICogU1RZTEVTX1BBR0VfU0laRTtcbiAgICBjb25zdCBzbGljZSA9IGFsbC5zbGljZShzdGFydCwgc3RhcnQgKyBTVFlMRVNfUEFHRV9TSVpFKTtcbiAgICBpZiAoc2xpY2UubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgdm9pZCByZW5kZXJCb2FyZCh7XG4gICAgICBpbWFnZSxcbiAgICAgIHRhcmdldExhYmVsOiBzZXNzaW9uLnNvdXJjZUxhYmVsID8/IFwieW91ciBpbWFnZVwiLFxuICAgICAgc3R5bGVzOiBzbGljZSxcbiAgICAgIGZvY3VzVmFsdWU6IGZvY3VzRm9yU2xpY2Uoc2xpY2UsIHNlc3Npb24uYW5pbWF0aW9uKSxcbiAgICAgIHVzZXJJZCxcbiAgICAgIHBhZ2U6IHAsXG4gICAgICBwYWdlcyxcbiAgICAgIHRvdGFsOiBhbGwubGVuZ3RoLFxuICAgICAgZm9ybWF0OiBzZXNzaW9uLmZvcm1hdCxcbiAgICAgIGJhY2tncm91bmQ6IHRydWUsXG4gICAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICB9O1xuICB3YXJtKHBhZ2UgKyAxKTtcbiAgd2FybShwYWdlIC0gMSk7XG59XG5cbi8qKlxuICogUHJlLXdhcm0gdGhlIGJvYXJkcyBhIHVzZXIgaXMgbW9zdCBsaWtlbHkgdG8gb3BlbiBuZXh0LCBvbiBgaW1hZ2VgLlxuICpcbiAqIENhbGxlZCBpbiB0aGUgYmFja2dyb3VuZCB0aGUgbW9tZW50IHRoZSBvcGVuaW5nIGNob29zZXIgaXMgc2hvd24gKG9uIHRoZVxuICogY2FsbGVyJ3MgYXZhdGFyKSBzbyB0YXBwaW5nICoqTXkgYXZhdGFyKiogb3IgKipcdTJCNTAgRmF2b3JpdGVzKiogcGFpbnRzIGZyb20gY2FjaGVcbiAqIGluc3RlYWQgb2YgYSBjb2xkIGVpZ2h0LWNlbGwgY29tcG9zZS4gV2FybXMgcGFnZSAxIG9mIGFsbCBzdHlsZXMsIHBhZ2UgMSBvZlxuICogZmF2b3JpdGVzICh3aGVuIGFueSksIGFuZCB0aGUgZm9jdXNlZCBsaXZlIHByZXZpZXcuIEVudGlyZWx5IGJlc3QtZWZmb3J0IFx1MjAxNCBpdFxuICogcnVucyBhdCBwcmV2aWV3IHByaW9yaXR5IGFuZCB5aWVsZHMgdG8gb24tZGVtYW5kIHJlbmRlcnMsIGFuZCBldmVyeSBwYXRoXG4gKiBzd2FsbG93cyBpdHMgb3duIGVycm9ycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdhcm1UYXJnZXRCb2FyZHMoXG4gIGltYWdlOiBCdWZmZXIsIHVzZXJJZDogc3RyaW5nLCBzb3VyY2VMYWJlbDogc3RyaW5nLCBhbmltYXRpb246IHN0cmluZywgZm9ybWF0OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgYWxsID0gYWxsU3R5bGVzKCk7XG4gIGNvbnN0IHdhcm0gPSAoc3R5bGVzOiBTdHlsZUVudHJ5W10sIHRvdGFsOiBudW1iZXIsIHBhZ2VDb3VudDogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgaWYgKHN0eWxlcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICB2b2lkIHJlbmRlckJvYXJkKHtcbiAgICAgIGltYWdlLCB0YXJnZXRMYWJlbDogc291cmNlTGFiZWwsIHN0eWxlcyxcbiAgICAgIGZvY3VzVmFsdWU6IGZvY3VzRm9yU2xpY2Uoc3R5bGVzLCBhbmltYXRpb24pLFxuICAgICAgdXNlcklkLCBwYWdlOiAwLCBwYWdlczogcGFnZUNvdW50LCB0b3RhbCwgZm9ybWF0LCBiYWNrZ3JvdW5kOiB0cnVlLFxuICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgfTtcblxuICBjb25zdCBwYWdlMSA9IGFsbC5zbGljZSgwLCBTVFlMRVNfUEFHRV9TSVpFKTtcbiAgd2FybShwYWdlMSwgYWxsLmxlbmd0aCwgTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGFsbC5sZW5ndGggLyBTVFlMRVNfUEFHRV9TSVpFKSkpO1xuXG4gIGNvbnN0IGZhdlZhbHMgPSBuZXcgU2V0KGxpc3RGYXZvcml0ZXModXNlcklkKSk7XG4gIGlmIChmYXZWYWxzLnNpemUgPiAwKSB7XG4gICAgY29uc3QgZmF2cyA9IGFsbC5maWx0ZXIocyA9PiBmYXZWYWxzLmhhcyhzLnZhbHVlKSk7XG4gICAgd2FybShmYXZzLnNsaWNlKDAsIFNUWUxFU19QQUdFX1NJWkUpLCBmYXZzLmxlbmd0aCwgTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGZhdnMubGVuZ3RoIC8gU1RZTEVTX1BBR0VfU0laRSkpKTtcbiAgfVxuXG4gIHZvaWQgcmVuZGVyU3R5bGVQcmV2aWV3KGltYWdlLCBmb2N1c0ZvclNsaWNlKHBhZ2UxLCBhbmltYXRpb24pKS5jYXRjaCgoKSA9PiB7fSk7XG59XG5cbi8qKlxuICogTW9kYWwgdG8gc2VhcmNoIHN0eWxlcyBieSBuYW1lLlxuICpcbiAqIFNlYXJjaCBpcyBpdHMgb3duIHRoaW5nIG5vdyBcdTIwMTQgcGFnZSBqdW1wcyBsaXZlIG9uIHRoZSBwYWdlIGRyb3Bkb3duIGFuZCB0aGVcbiAqIFwiR28gdG8gcGFnZVwiIGJ1dHRvbiBcdTIwMTQgc28gdGhpcyBpcyBhIHNpbmdsZSBuYW1lIGZpZWxkLiBUaGUgcmFua2luZyBiZWhpbmQgaXQgaXNcbiAqIHR5cG8tdG9sZXJhbnQgKGV4YWN0IFx1MjE5MiBzdWJzdHJpbmcgXHUyMTkyIGFjcm9ueW0gXHUyMTkyIGZ1enp5KSwgc28gYSByb3VnaCBndWVzcyBzdGlsbFxuICogc3VyZmFjZXMgdGhlIGNsb3Nlc3Qgc3R5bGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZVNlYXJjaE1vZGFsKHRva2VuOiBzdHJpbmcsIGN1cnJlbnRRdWVyeTogc3RyaW5nKTogTW9kYWxCdWlsZGVyIHtcbiAgcmV0dXJuIG5ldyBNb2RhbEJ1aWxkZXIoKVxuICAgIC5zZXRDdXN0b21JZChjaWQoXCJzdHlsZXNfbW9kYWxcIiwgdG9rZW4pKVxuICAgIC5zZXRUaXRsZShcIlNlYXJjaCBzdHlsZXMgYnkgbmFtZVwiKVxuICAgIC5hZGRDb21wb25lbnRzKFxuICAgICAgbmV3IEFjdGlvblJvd0J1aWxkZXI8VGV4dElucHV0QnVpbGRlcj4oKS5hZGRDb21wb25lbnRzKFxuICAgICAgICBuZXcgVGV4dElucHV0QnVpbGRlcigpXG4gICAgICAgICAgLnNldEN1c3RvbUlkKFwicXVlcnlcIilcbiAgICAgICAgICAuc2V0TGFiZWwoXCJTdHlsZSBuYW1lIChsZWF2ZSBlbXB0eSB0byBjbGVhcilcIilcbiAgICAgICAgICAuc2V0U3R5bGUoVGV4dElucHV0U3R5bGUuU2hvcnQpXG4gICAgICAgICAgLnNldFJlcXVpcmVkKGZhbHNlKVxuICAgICAgICAgIC5zZXRNYXhMZW5ndGgoTUFYX1NUWUxFX1FVRVJZKVxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcihcImUuZy4gcmFpbmJvdywgc3BpbiwgcG9ydGFsIFx1MjAxNCBjbG9zZSBzcGVsbGluZ3Mgd29ya1wiKVxuICAgICAgICAgIC5zZXRWYWx1ZShjdXJyZW50UXVlcnkuc2xpY2UoMCwgTUFYX1NUWUxFX1FVRVJZKSksXG4gICAgICApLFxuICAgICk7XG59XG5cbi8qKiBNb2RhbCB0byBqdW1wIHN0cmFpZ2h0IHRvIGEgcGFnZSBudW1iZXIgKHBhaXJlZCB3aXRoIHRoZSBwYWdlIGRyb3Bkb3duKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEdvdG9QYWdlTW9kYWwodG9rZW46IHN0cmluZywgcGFnZXM6IG51bWJlciwgY3VycmVudFBhZ2U6IG51bWJlcik6IE1vZGFsQnVpbGRlciB7XG4gIHJldHVybiBuZXcgTW9kYWxCdWlsZGVyKClcbiAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX2dvdG9fbW9kYWxcIiwgdG9rZW4pKVxuICAgIC5zZXRUaXRsZShcIkdvIHRvIHBhZ2VcIilcbiAgICAuYWRkQ29tcG9uZW50cyhcbiAgICAgIG5ldyBBY3Rpb25Sb3dCdWlsZGVyPFRleHRJbnB1dEJ1aWxkZXI+KCkuYWRkQ29tcG9uZW50cyhcbiAgICAgICAgbmV3IFRleHRJbnB1dEJ1aWxkZXIoKVxuICAgICAgICAgIC5zZXRDdXN0b21JZChcInBhZ2VcIilcbiAgICAgICAgICAuc2V0TGFiZWwoYFBhZ2UgbnVtYmVyICgxXHUyMDEzJHtwYWdlc30pYClcbiAgICAgICAgICAuc2V0U3R5bGUoVGV4dElucHV0U3R5bGUuU2hvcnQpXG4gICAgICAgICAgLnNldFJlcXVpcmVkKHRydWUpXG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKGBDdXJyZW50bHkgb24gcGFnZSAke2N1cnJlbnRQYWdlICsgMX1gKVxuICAgICAgICAgIC5zZXRNYXhMZW5ndGgoNSksXG4gICAgICApLFxuICAgICk7XG59XG5cbi8qKlxuICogVXAgdG8gMjUgcGFnZSBudW1iZXJzICgwLWJhc2VkKSB0byBvZmZlciBpbiB0aGUganVtcCBkcm9wZG93bjogdGhlIGZpcnN0IGFuZFxuICogbGFzdCBwYWdlLCBhIHdpbmRvdyBhcm91bmQgdGhlIGN1cnJlbnQgb25lLCBhbmQgZXZlbmx5LXNwYWNlZCBtYXJrZXJzIGJldHdlZW4sXG4gKiBzbyBhbnkgb2YgbWFueSBwYWdlcyBpcyBhIGNvdXBsZSBvZiB0YXBzIGF3YXkgd2l0aG91dCBleGNlZWRpbmcgRGlzY29yZCdzXG4gKiAyNS1vcHRpb24gc2VsZWN0IGNhcC4gRXhhY3QganVtcHMgdG8gYW55dGhpbmcgaW4gYmV0d2VlbiB1c2UgdGhlIEdvIHRvIHBhZ2VcbiAqIGJ1dHRvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhZ2VKdW1wVGFyZ2V0cyhjdXJyZW50OiBudW1iZXIsIHBhZ2VzOiBudW1iZXIpOiBudW1iZXJbXSB7XG4gIGNvbnN0IHNldCA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICBzZXQuYWRkKDApO1xuICBzZXQuYWRkKHBhZ2VzIC0gMSk7XG4gIGZvciAobGV0IGQgPSAtMjsgZCA8PSAyOyBkKyspIHtcbiAgICBjb25zdCBwID0gY3VycmVudCArIGQ7XG4gICAgaWYgKHAgPj0gMCAmJiBwIDwgcGFnZXMpIHNldC5hZGQocCk7XG4gIH1cbiAgY29uc3Qgc3RlcCA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IocGFnZXMgLyAxMikpO1xuICBmb3IgKGxldCBwID0gMDsgcCA8IHBhZ2VzOyBwICs9IHN0ZXApIHNldC5hZGQocCk7XG4gIHJldHVybiBbLi4uc2V0XS5maWx0ZXIocCA9PiBwID49IDAgJiYgcCA8IHBhZ2VzKS5zb3J0KChhLCBiKSA9PiBhIC0gYikuc2xpY2UoMCwgMjUpO1xufVxuXG4vKipcbiAqIFRoZSBTdHlsZSBCb2FyZCBkYXNoYm9hcmQuXG4gKlxuICogVGhlIGVtYmVkJ3MgbWFpbiBpbWFnZSBpcyBhIGNhbnZhcyBjb250YWN0IHNoZWV0IG9mIHRoaXMgcGFnZSdzIHN0eWxlcywgZWFjaFxuICogcmVuZGVyZWQgb24gdGhlIHVzZXIncyBvd24gaW1hZ2UgYW5kIG51bWJlcmVkLiBUaGUgZm9jdXNlZCBzdHlsZSBhbHNvIHJpZGVzXG4gKiBhbG9uZyBhcyBhbiBhbmltYXRlZCB0aHVtYm5haWwsIHNvIHRoZSBib2FyZCBzaG93cyBcImFsbCBvZiB0aGVtIGF0IG9uY2VcIiBhbmRcbiAqIFwidGhpcyBvbmUsIG1vdmluZ1wiIHRvZ2V0aGVyLiBBIG51bWJlcmVkIGRyb3Bkb3duIGFuZCBhIGhpZ2hsaWdodGluZyBudW1iZXJcbiAqIHBpY2tlciBjaG9vc2UgYSBzdHlsZTsgbm90aGluZyByZWdlbmVyYXRlcyB1bnRpbCAqKkFwcGx5KiosIHNvIGJyb3dzaW5nIGlzXG4gKiBpbnN0YW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRTdHlsZXNQaWNrZXIoXG4gIHNlc3Npb246IEVtb2ppU2Vzc2lvbixcbiAgdG9rZW46IHN0cmluZyxcbik6IFByb21pc2U8U3R5bGVzUGlja2VyUmVwbHk+IHtcbiAgY29uc3QgdXNlcklkID0gc2Vzc2lvbi5vd25lcklkO1xuICBjb25zdCBmb2N1c1ZhbHVlID0gZW5zdXJlU3R5bGVGb2N1cyhzZXNzaW9uLCB1c2VySWQpO1xuICBzZXNzaW9uLnN0eWxlRm9jdXMgPSBmb2N1c1ZhbHVlO1xuXG4gIGNvbnN0IGZvY3VzZWQgPSBmaW5kU3R5bGUoZm9jdXNWYWx1ZSk7XG4gIGNvbnN0IGxhYmVsID0gZm9jdXNlZD8ubGFiZWwgPz8gZm9jdXNWYWx1ZTtcbiAgY29uc3QgeyByb3dzLCBwYWdlLCBwYWdlcywgdG90YWwgfSA9IHBhZ2VTdHlsZXMoc2Vzc2lvbiwgdXNlcklkKTtcbiAgY29uc3QgZmF2b3JpdGVkID0gaXNGYXZvcml0ZSh1c2VySWQsIGZvY3VzVmFsdWUpO1xuICBjb25zdCB0YXJnZXRMYWJlbCA9IHNlc3Npb24uc291cmNlTGFiZWwgPz8gXCJ5b3VyIGltYWdlXCI7XG4gIGNvbnN0IGZvY3VzSW5kZXggPSByb3dzLmZpbmRJbmRleChyID0+IHIudmFsdWUgPT09IGZvY3VzVmFsdWUpO1xuXG4gIC8vIFRoZSBib2FyZCAobWFpbiBpbWFnZSkgYW5kIHRoZSBmb2N1c2VkIGFuaW1hdGVkIHByZXZpZXcgKHRodW1ibmFpbCkgYXJlIHRoZVxuICAvLyB0d28gcGljdHVyZXMuIFJlbmRlciB0aGVtIGluIHBhcmFsbGVsIHJhdGhlciB0aGFuIG9uZSBhZnRlciB0aGUgb3RoZXIgXHUyMDE0IHRoZVxuICAvLyBzbWFsbCBwcmV2aWV3IHRoZW4gb3ZlcmxhcHMgdGhlIGJvYXJkIGNvbXBvc2UgaW5zdGVhZCBvZiBhZGRpbmcgdG8gaXQuIEJvdGhcbiAgLy8gYXJlIG9uIHRoZSB1c2VyJ3MgT1dOIGltYWdlOyB0aGUgQ0ROIGNhdCBpcyBvbmx5IGEgbGFzdC1yZXNvcnQgdGh1bWJuYWlsLlxuICBjb25zdCBbYm9hcmQsIGxpdmVQcmV2aWV3XSA9IHNlc3Npb24uaW1hZ2VcbiAgICA/IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgcmVuZGVyQm9hcmQoe1xuICAgICAgICAgIGltYWdlOiBzZXNzaW9uLmltYWdlLFxuICAgICAgICAgIHRhcmdldExhYmVsLFxuICAgICAgICAgIHN0eWxlczogcm93cyxcbiAgICAgICAgICBmb2N1c1ZhbHVlLFxuICAgICAgICAgIHVzZXJJZCxcbiAgICAgICAgICBwYWdlLFxuICAgICAgICAgIHBhZ2VzLFxuICAgICAgICAgIHRvdGFsLFxuICAgICAgICAgIGZvcm1hdDogc2Vzc2lvbi5mb3JtYXQsXG4gICAgICAgIH0pLFxuICAgICAgICByZW5kZXJTdHlsZVByZXZpZXcoc2Vzc2lvbi5pbWFnZSwgZm9jdXNWYWx1ZSksXG4gICAgICBdKVxuICAgIDogW251bGwsIG51bGxdO1xuICBjb25zdCBwcmV2aWV3VXJsID0gbGl2ZVByZXZpZXdcbiAgICA/IG51bGxcbiAgICA6IGZvY3VzZWQgPyBhd2FpdCByZXNvbHZlU3R5bGVQcmV2aWV3VXJsKGZvY3VzZWQubGFiZWwpIDogbnVsbDtcblxuICAvLyBXYXJtIHRoZSBuZWlnaGJvdXJpbmcgcGFnZXMgc28gTmV4dC9QcmV2IHVzdWFsbHkgaGl0IHRoZSBib2FyZCBjYWNoZS5cbiAgcHJlZmV0Y2hOZWlnaGJvckJvYXJkcyhzZXNzaW9uLCB1c2VySWQsIHBhZ2UsIHBhZ2VzKTtcblxuICBjb25zdCBmaWx0ZXJzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoc2Vzc2lvbi5zdHlsZUZpbHRlciA9PT0gXCJmYXZvcml0ZXNcIikgZmlsdGVycy5wdXNoKFwiXHUyNjA1IGZhdm9yaXRlc1wiKTtcbiAgaWYgKHNlc3Npb24uc3R5bGVRdWVyeT8udHJpbSgpKSBmaWx0ZXJzLnB1c2goYHNlYXJjaCBcdTIwMUMke3Nlc3Npb24uc3R5bGVRdWVyeS50cmltKCl9XHUyMDFEYCk7XG5cbiAgY29uc3QgZmF2VmlldyA9IHNlc3Npb24uc3R5bGVGaWx0ZXIgPT09IFwiZmF2b3JpdGVzXCI7XG4gIGNvbnN0IGVtcHR5RmF2cyA9IGZhdlZpZXcgJiYgdG90YWwgPT09IDA7XG5cbiAgY29uc3QgbnVtYmVyZWQgPSBmb2N1c0luZGV4ID49IDAgPyBgIyR7Zm9jdXNJbmRleCArIDF9IFx1MDBCNyBgIDogXCJcIjtcbiAgY29uc3QgZGVzY3JpcHRpb24gPSBlbXB0eUZhdnNcbiAgICA/IFtcbiAgICAgICAgXCJZb3UgaGF2ZW4ndCBzdGFycmVkIGFueSBzdHlsZXMgeWV0LlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIlRhcCAqKlNob3cgYWxsKiosIG9wZW4gYW55IHN0eWxlLCBhbmQgaGl0ICoqXHUyQjUwIEZhdm9yaXRlKiogXHUyMDE0IGl0IGxhbmRzIGhlcmUgZm9yIG9uZS10YXAgYWNjZXNzIG5leHQgdGltZS5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKVxuICAgIDogW1xuICAgICAgICBgU2VsZWN0ZWQ6ICoqJHtudW1iZXJlZH0ke2xhYmVsfSoqICR7ZmF2b3JpdGVkID8gXCJcdTI2MDVcIiA6IFwiXCJ9YC50cmltKCksXG4gICAgICAgIGBcXGAke2ZvY3VzVmFsdWV9XFxgIFx1MDBCNyB0eXBlIFxcYCR7c2Vzc2lvbi5mb3JtYXQudG9VcHBlckNhc2UoKX1cXGBgLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIlRhcCBhICoqbnVtYmVyKiogdG8gc2VsZWN0IFx1MjAxNCB0aGUgYm9hcmQgcmluZ3MgeW91ciBwaWNrLlwiLFxuICAgICAgICBmYXZWaWV3XG4gICAgICAgICAgPyBcIioqQXBwbHkqKiByZW5kZXJzIGl0IG9uIHlvdXIgdGFyZ2V0IFx1MDBCNyAqKlVuZmF2b3JpdGUqKiByZW1vdmVzIGl0IGZyb20gdGhpcyBsaXN0LlwiXG4gICAgICAgICAgOiBcIioqQXBwbHkqKiByZW5kZXJzIGl0IGF0IGZ1bGwgcXVhbGl0eSBvbiB5b3VyIHRhcmdldC5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKTtcblxuICBjb25zdCBlbWJlZCA9IG5ldyBFbWJlZEJ1aWxkZXIoKVxuICAgIC5zZXRDb2xvcihmYXZWaWV3ID8gMHhmMWM0MGYgOiBmYXZvcml0ZWQgPyAweGYxYzQwZiA6IDB4NTg2NWYyKVxuICAgIC5zZXRBdXRob3IoeyBuYW1lOiBgXHVEODNDXHVERkFGICR7dGFyZ2V0TGFiZWx9YCB9KVxuICAgIC5zZXRUaXRsZShmYXZWaWV3ID8gXCJcdTJCNTAgWW91ciBGYXZvcml0ZXNcIiA6IFwiXHVEODNDXHVERkE4IFN0eWxlIEJvYXJkXCIpXG4gICAgLnNldERlc2NyaXB0aW9uKGRlc2NyaXB0aW9uKVxuICAgIC5zZXRGb290ZXIoe1xuICAgICAgdGV4dDogW1xuICAgICAgICBgJHt0b3RhbH0gJHtmYXZWaWV3ID8gXCJmYXZvcml0ZVwiIDogXCJzdHlsZVwifSR7dG90YWwgPT09IDEgPyBcIlwiIDogXCJzXCJ9YCxcbiAgICAgICAgZmF2VmlldyA/IFwiXHUyNjA1IHlvdXIgbGlzdFwiIDogXCJhbGwgc3R5bGVzXCIsXG4gICAgICAgIGBwYWdlICR7cGFnZSArIDF9LyR7cGFnZXN9YCxcbiAgICAgIF0uam9pbihcIiBcdTAwQjcgXCIpLFxuICAgIH0pO1xuXG4gIGNvbnN0IGZpbGVzOiBBdHRhY2htZW50QnVpbGRlcltdID0gW107XG5cbiAgaWYgKGJvYXJkKSB7XG4gICAgZmlsZXMucHVzaChuZXcgQXR0YWNobWVudEJ1aWxkZXIoYm9hcmQuYnVmZmVyLCB7IG5hbWU6IGJvYXJkLm5hbWUgfSkpO1xuICAgIGVtYmVkLnNldEltYWdlKGBhdHRhY2htZW50Oi8vJHtib2FyZC5uYW1lfWApO1xuICB9XG5cbiAgaWYgKGxpdmVQcmV2aWV3KSB7XG4gICAgLy8gQXR0YWNoZWQgcmF0aGVyIHRoYW4gbGlua2VkOiB0aGUgYnl0ZXMgd2VyZSByZW5kZXJlZCBoZXJlIGFuZCBub3cuXG4gICAgZmlsZXMucHVzaChuZXcgQXR0YWNobWVudEJ1aWxkZXIobGl2ZVByZXZpZXcsIHsgbmFtZTogUFJFVklFV19GSUxFTkFNRSB9KSk7XG4gICAgZW1iZWQuc2V0VGh1bWJuYWlsKGBhdHRhY2htZW50Oi8vJHtQUkVWSUVXX0ZJTEVOQU1FfWApO1xuICB9IGVsc2UgaWYgKHByZXZpZXdVcmwpIHtcbiAgICBlbWJlZC5zZXRUaHVtYm5haWwocHJldmlld1VybCk7XG4gIH1cblxuICBpZiAoIWJvYXJkICYmICFsaXZlUHJldmlldyAmJiAhcHJldmlld1VybCkge1xuICAgIGVtYmVkLmFkZEZpZWxkcyh7XG4gICAgICBuYW1lOiBcIlByZXZpZXdcIixcbiAgICAgIHZhbHVlOiBcIl9ObyBwcmV2aWV3IGZvciB0aGlzIHN0eWxlIFx1MjAxNCBBcHBseSBzdGlsbCB3b3Jrcy5fXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBjb21wb25lbnRzOiBBY3Rpb25Sb3dCdWlsZGVyPFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyIHwgQnV0dG9uQnVpbGRlcj5bXSA9IFtdO1xuXG4gIC8vIFJvdzogcGFnZS1qdW1wIGRyb3Bkb3duLiBUaGUgbnVtYmVyIGJ1dHRvbnMgcGljayBhIHN0eWxlOyB0aGlzIGRyb3Bkb3duIG1vdmVzXG4gIC8vIGJldHdlZW4gcGFnZXMgKHdpdGggdGhlIEdvIHRvIHBhZ2UgYnV0dG9uIGZvciBhbiBleGFjdCBudW1iZXIpLiBPbmx5IHNob3duXG4gIC8vIHdoZW4gdGhlcmUncyBtb3JlIHRoYW4gb25lIHBhZ2UgdG8gbW92ZSBiZXR3ZWVuLlxuICBpZiAocGFnZXMgPiAxKSB7XG4gICAgY29uc3QgbWVudSA9IG5ldyBTdHJpbmdTZWxlY3RNZW51QnVpbGRlcigpXG4gICAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX3BhZ2VcIiwgdG9rZW4pKVxuICAgICAgLnNldFBsYWNlaG9sZGVyKGBQYWdlICR7cGFnZSArIDF9IC8gJHtwYWdlc30gXHUyMDE0IGp1bXAgdG8gYSBwYWdlYClcbiAgICAgIC5hZGRPcHRpb25zKHBhZ2VKdW1wVGFyZ2V0cyhwYWdlLCBwYWdlcykubWFwKHAgPT5cbiAgICAgICAgbmV3IFN0cmluZ1NlbGVjdE1lbnVPcHRpb25CdWlsZGVyKClcbiAgICAgICAgICAuc2V0TGFiZWwoYFBhZ2UgJHtwICsgMX0ke3AgPT09IDAgPyBcIiBcdTAwQjcgZmlyc3RcIiA6IHAgPT09IHBhZ2VzIC0gMSA/IFwiIFx1MDBCNyBsYXN0XCIgOiBcIlwifWApXG4gICAgICAgICAgLnNldERlc2NyaXB0aW9uKHAgPT09IHBhZ2UgPyBcInlvdSBhcmUgaGVyZVwiIDogYGp1bXAgdG8gcGFnZSAke3AgKyAxfWApXG4gICAgICAgICAgLnNldFZhbHVlKFN0cmluZyhwKSlcbiAgICAgICAgICAuc2V0RGVmYXVsdChwID09PSBwYWdlKSxcbiAgICAgICkpO1xuICAgIGNvbXBvbmVudHMucHVzaChuZXcgQWN0aW9uUm93QnVpbGRlcjxTdHJpbmdTZWxlY3RNZW51QnVpbGRlcj4oKS5hZGRDb21wb25lbnRzKG1lbnUpKTtcbiAgfVxuXG4gIC8vIFJvd3M6IHRoZSBudW1iZXIgcGlja2VyLiBEaXNjb3JkIGNhcHMgYSByb3cgYXQgZml2ZSBidXR0b25zLCBzbyAxLTQgc2l0IG9uXG4gIC8vIG9uZSByb3cgYW5kIDUtOCBvbiB0aGUgbmV4dC4gVGhlIHNlbGVjdGVkIG51bWJlciBpcyB0aGUgb25seSBQcmltYXJ5IGJ1dHRvbixcbiAgLy8gbWF0Y2hpbmcgdGhlIHJpbmcgdGhlIGJvYXJkIGRyYXdzIGFyb3VuZCB0aGF0IGNlbGwuXG4gIGZvciAobGV0IHN0YXJ0ID0gMDsgc3RhcnQgPCByb3dzLmxlbmd0aDsgc3RhcnQgKz0gNCkge1xuICAgIGNvbnN0IGNodW5rID0gcm93cy5zbGljZShzdGFydCwgc3RhcnQgKyA0KTtcbiAgICBjb25zdCByb3cgPSBuZXcgQWN0aW9uUm93QnVpbGRlcjxCdXR0b25CdWlsZGVyPigpLmFkZENvbXBvbmVudHMoXG4gICAgICAuLi5jaHVuay5tYXAoKHMsIGopID0+IHtcbiAgICAgICAgY29uc3QgaW5kZXggPSBzdGFydCArIGo7XG4gICAgICAgIHJldHVybiBuZXcgQnV0dG9uQnVpbGRlcigpXG4gICAgICAgICAgLnNldEN1c3RvbUlkKGNpZChgc3R5bGVzX24ke2luZGV4fWAsIHRva2VuKSlcbiAgICAgICAgICAuc2V0TGFiZWwoU3RyaW5nKGluZGV4ICsgMSkpXG4gICAgICAgICAgLnNldFN0eWxlKGluZGV4ID09PSBmb2N1c0luZGV4ID8gQnV0dG9uU3R5bGUuUHJpbWFyeSA6IEJ1dHRvblN0eWxlLlNlY29uZGFyeSk7XG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbXBvbmVudHMucHVzaChyb3cpO1xuICB9XG5cbiAgLy8gUm93OiBuYXZpZ2F0aW9uICsgc2VhcmNoICsgZmF2b3JpdGVzIGZpbHRlci4gUGFnZXMgYXJlIGRyaXZlbiBieSB0aGUgZHJvcGRvd25cbiAgLy8gYWJvdmUsIFByZXYvTmV4dCBmb3Igc3RlcHBpbmcsIGFuZCBHbyB0byBwYWdlIGZvciBhbiBleGFjdCBudW1iZXI7IFNlYXJjaCBpc1xuICAvLyBub3cgc2VhcmNoLW9ubHkuXG4gIGNvbXBvbmVudHMucHVzaChcbiAgICBuZXcgQWN0aW9uUm93QnVpbGRlcjxCdXR0b25CdWlsZGVyPigpLmFkZENvbXBvbmVudHMoXG4gICAgICBuZXcgQnV0dG9uQnVpbGRlcigpXG4gICAgICAgIC5zZXRDdXN0b21JZChjaWQoXCJzdHlsZXNfcHJldlwiLCB0b2tlbikpXG4gICAgICAgIC5zZXRFbW9qaShcIlx1MjVDMFx1RkUwRlwiKVxuICAgICAgICAuc2V0TGFiZWwoXCJQcmV2XCIpXG4gICAgICAgIC5zZXRTdHlsZShCdXR0b25TdHlsZS5TZWNvbmRhcnkpXG4gICAgICAgIC5zZXREaXNhYmxlZChwYWdlIDw9IDApLFxuICAgICAgbmV3IEJ1dHRvbkJ1aWxkZXIoKVxuICAgICAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX25leHRcIiwgdG9rZW4pKVxuICAgICAgICAuc2V0RW1vamkoXCJcdTI1QjZcdUZFMEZcIilcbiAgICAgICAgLnNldExhYmVsKFwiTmV4dFwiKVxuICAgICAgICAuc2V0U3R5bGUoQnV0dG9uU3R5bGUuU2Vjb25kYXJ5KVxuICAgICAgICAuc2V0RGlzYWJsZWQocGFnZSA+PSBwYWdlcyAtIDEpLFxuICAgICAgbmV3IEJ1dHRvbkJ1aWxkZXIoKVxuICAgICAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX2dvdG9cIiwgdG9rZW4pKVxuICAgICAgICAuc2V0TGFiZWwoXCJHbyB0byBwYWdlXCIpXG4gICAgICAgIC5zZXRFbW9qaShcIlx1RDgzRFx1REQyMlwiKVxuICAgICAgICAuc2V0U3R5bGUoQnV0dG9uU3R5bGUuU2Vjb25kYXJ5KVxuICAgICAgICAuc2V0RGlzYWJsZWQocGFnZXMgPD0gMSksXG4gICAgICBuZXcgQnV0dG9uQnVpbGRlcigpXG4gICAgICAgIC5zZXRDdXN0b21JZChjaWQoXCJzdHlsZXNfc2VhcmNoXCIsIHRva2VuKSlcbiAgICAgICAgLnNldExhYmVsKHNlc3Npb24uc3R5bGVRdWVyeT8udHJpbSgpID8gYFNlYXJjaDogJHtzZXNzaW9uLnN0eWxlUXVlcnkudHJpbSgpfWAuc2xpY2UoMCwgNjApIDogXCJTZWFyY2hcIilcbiAgICAgICAgLnNldEVtb2ppKFwiXHVEODNEXHVERDBEXCIpXG4gICAgICAgIC5zZXRTdHlsZShCdXR0b25TdHlsZS5QcmltYXJ5KSxcbiAgICAgIG5ldyBCdXR0b25CdWlsZGVyKClcbiAgICAgICAgLnNldEN1c3RvbUlkKGNpZChcInN0eWxlc19maWx0ZXJcIiwgdG9rZW4pKVxuICAgICAgICAuc2V0TGFiZWwoc2Vzc2lvbi5zdHlsZUZpbHRlciA9PT0gXCJmYXZvcml0ZXNcIiA/IFwiU2hvdyBhbGxcIiA6IFwiRmF2b3JpdGVzXCIpXG4gICAgICAgIC5zZXRFbW9qaShcIlx1MkI1MFwiKVxuICAgICAgICAuc2V0U3R5bGUoc2Vzc2lvbi5zdHlsZUZpbHRlciA9PT0gXCJmYXZvcml0ZXNcIiA/IEJ1dHRvblN0eWxlLlN1Y2Nlc3MgOiBCdXR0b25TdHlsZS5TZWNvbmRhcnkpLFxuICAgICksXG4gICk7XG5cbiAgLy8gUm93OiBhY3Qgb24gdGhlIGZvY3VzZWQgc3R5bGUgKyBjaGFuZ2UgdGFyZ2V0LlxuICBjb21wb25lbnRzLnB1c2goXG4gICAgbmV3IEFjdGlvblJvd0J1aWxkZXI8QnV0dG9uQnVpbGRlcj4oKS5hZGRDb21wb25lbnRzKFxuICAgICAgbmV3IEJ1dHRvbkJ1aWxkZXIoKVxuICAgICAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX2ZhdlwiLCB0b2tlbikpXG4gICAgICAgIC5zZXRMYWJlbChmYXZvcml0ZWQgPyBcIlVuZmF2b3JpdGVcIiA6IFwiRmF2b3JpdGVcIilcbiAgICAgICAgLnNldEVtb2ppKGZhdm9yaXRlZCA/IFwiXHUyNjA2XCIgOiBcIlx1MkI1MFwiKVxuICAgICAgICAuc2V0U3R5bGUoZmF2b3JpdGVkID8gQnV0dG9uU3R5bGUuU2Vjb25kYXJ5IDogQnV0dG9uU3R5bGUuUHJpbWFyeSlcbiAgICAgICAgLnNldERpc2FibGVkKCFmb2N1c2VkKSxcbiAgICAgIG5ldyBCdXR0b25CdWlsZGVyKClcbiAgICAgICAgLnNldEN1c3RvbUlkKGNpZChcInN0eWxlc19hcHBseVwiLCB0b2tlbikpXG4gICAgICAgIC5zZXRMYWJlbChcIkFwcGx5IHN0eWxlXCIpXG4gICAgICAgIC5zZXRFbW9qaShcIlx1MjcwNVwiKVxuICAgICAgICAuc2V0U3R5bGUoQnV0dG9uU3R5bGUuU3VjY2VzcylcbiAgICAgICAgLnNldERpc2FibGVkKCFmb2N1c2VkKSxcbiAgICAgIG5ldyBCdXR0b25CdWlsZGVyKClcbiAgICAgICAgLnNldEN1c3RvbUlkKGNpZChcInN0eWxlc190YXJnZXRcIiwgdG9rZW4pKVxuICAgICAgICAuc2V0TGFiZWwoXCJUYXJnZXRcIilcbiAgICAgICAgLnNldEVtb2ppKFwiXHVEODNDXHVERkFGXCIpXG4gICAgICAgIC5zZXRTdHlsZShCdXR0b25TdHlsZS5TZWNvbmRhcnkpLFxuICAgICAgbmV3IEJ1dHRvbkJ1aWxkZXIoKVxuICAgICAgICAuc2V0Q3VzdG9tSWQoY2lkKFwic3R5bGVzX2JhY2tcIiwgdG9rZW4pKVxuICAgICAgICAuc2V0TGFiZWwoXCJCYWNrXCIpXG4gICAgICAgIC5zZXRFbW9qaShcIlx1MjFBOVx1RkUwRlwiKVxuICAgICAgICAuc2V0U3R5bGUoQnV0dG9uU3R5bGUuU2Vjb25kYXJ5KSxcbiAgICApLFxuICApO1xuXG4gIHJldHVybiB7XG4gICAgY29udGVudDogXCJcIixcbiAgICBlbWJlZHM6IFtlbWJlZF0sXG4gICAgY29tcG9uZW50cyxcbiAgICBmaWxlcyxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBO0FBQUEsRUFDRTtBQUFBLEVBQWtCO0FBQUEsRUFBZTtBQUFBLEVBQWE7QUFBQSxFQUM5QztBQUFBLEVBQWM7QUFBQSxFQUF5QjtBQUFBLEVBQ3ZDO0FBQUEsRUFDQTtBQUFBLEVBQWtCO0FBQUEsT0FDYjtBQUNQLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsWUFBWSxxQkFBcUI7QUFDMUMsU0FBUyw4QkFBOEI7QUFDdkMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxhQUFhLHVCQUF1QjtBQUM3QyxTQUFTLHlCQUF5QjtBQUVsQyxTQUFTLFdBQVc7QUFHcEIsTUFBTSxtQkFBbUI7QUFNbEIsTUFBTSxtQkFBbUI7QUFHekIsTUFBTSxrQkFBa0I7QUFvQi9CLE1BQU0sZ0JBQWdCLG9CQUFJLElBQUk7QUFBQSxFQUM1QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFBcUI7QUFBQSxFQUNyQjtBQUFBLEVBQXFCO0FBQUEsRUFBcUI7QUFBQSxFQUMxQztBQUFBLEVBQXFCO0FBQUEsRUFBcUI7QUFBQSxFQUFxQjtBQUNqRSxDQUFDO0FBUUQsSUFBSSxrQkFBdUM7QUFFcEMsU0FBUyxZQUEwQjtBQUN4QyxNQUFJLGdCQUFpQixRQUFPO0FBQzVCLFFBQU0sU0FBUyxrQkFBa0I7QUFDakMsUUFBTSxTQUFTLFlBQVksRUFBRSxVQUFVLFNBQVMsV0FBVyxVQUFVLENBQUM7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
