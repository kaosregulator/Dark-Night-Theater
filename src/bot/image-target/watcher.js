import PQueue from 'p-queue';
import { log } from '../../logger.js';
import { applyDetectionAction } from './actions.js';
import {
  IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
  IMAGE_TARGET_CONCURRENCY,
  IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE,
} from './constants.js';
import { matchAgainstTargets } from './detector.js';
import {
  downloadBytes,
  extractCustomEmojis,
  extractImageUrls,
  looksLikeImage,
  looksLikeVideo,
} from './download.js';
import { isChannelWatched, listTargets } from './store.js';

/**
 * Message watcher for image targets (V2).
 * Scans attachments, embeds, direct image URLs, custom emoji, and stickers
 * in configured channels. Async / fire-and-forget so the gateway stays free.
 *
 * Uses a configurable media budget (not a silent slice(0,4) discard).
 */

const analysisQueue = new PQueue({ concurrency: IMAGE_TARGET_CONCURRENCY });
const inflight = new Set();
const recentKeys = new Map();
const DEDUPE_MS = 15_000;

function remember(key) {
  const now = Date.now();
  recentKeys.set(key, now);
  for (const [k, ts] of recentKeys) {
    if (now - ts > DEDUPE_MS) recentKeys.delete(k);
  }
}

function seenRecently(key) {
  const ts = recentKeys.get(key);
  return Boolean(ts && Date.now() - ts < DEDUPE_MS);
}

export function collectCandidates(message) {
  const out = [];

  for (const att of message.attachments?.values?.() || []) {
    const meta = {
      contentType: att.contentType || '',
      filename: att.name || '',
      url: att.url,
      size: att.size,
    };
    if (looksLikeImage(meta) || looksLikeVideo(meta)) {
      out.push({ url: att.proxyURL || att.url, meta, source: 'attachment' });
    }
  }

  for (const emb of message.embeds || []) {
    const url =
      emb.image?.proxyURL ||
      emb.image?.url ||
      emb.thumbnail?.proxyURL ||
      emb.thumbnail?.url ||
      emb.video?.proxyURL ||
      emb.video?.url;
    if (url) {
      out.push({
        url,
        meta: { contentType: '', filename: url, url },
        source: 'embed',
      });
    }
  }

  for (const url of extractImageUrls(message.content || '')) {
    out.push({
      url,
      meta: { contentType: '', filename: url, url },
      source: 'url',
    });
  }

  for (const em of extractCustomEmojis(message.content || '')) {
    out.push({
      url: em.url,
      meta: {
        contentType: em.animated ? 'image/gif' : 'image/png',
        filename: `${em.name}.${em.animated ? 'gif' : 'png'}`,
        url: em.url,
      },
      source: 'emoji',
    });
  }

  for (const st of message.stickers?.values?.() || []) {
    // 1=PNG, 2=APNG, 4=GIF (skip Lottie=3)
    if (st.format === 1 || st.format === 2 || st.format === 4) {
      const ext = st.format === 4 ? 'gif' : 'png';
      const url = `https://media.discordapp.net/stickers/${st.id}.${ext}?size=320`;
      out.push({
        url,
        meta: {
          contentType: ext === 'gif' ? 'image/gif' : 'image/png',
          filename: `${st.name}.${ext}`,
          url,
        },
        source: 'sticker',
      });
    }
  }

  const seen = new Set();
  return out.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

async function loadCandidateBuffer(candidate) {
  const downloaded = await downloadBytes(candidate.url);
  const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded.buffer;
  const contentType = downloaded.contentType || candidate.meta.contentType || '';
  return {
    buffer,
    meta: {
      ...candidate.meta,
      contentType,
    },
  };
}

function mediaBudget(candidates) {
  const max = IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE;
  if (candidates.length <= max) return candidates;
  // Prefer attachments, then embeds, then stickers/emoji, then bare URLs.
  const rank = { attachment: 0, embed: 1, sticker: 2, emoji: 3, url: 4 };
  const sorted = [...candidates].sort(
    (a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9),
  );
  log.info(
    `[image-target] media budget truncating ${candidates.length} → ${max} candidates`,
  );
  return sorted.slice(0, max);
}

export async function handleImageTargetMessage(message) {
  try {
    if (!message.guild || message.author?.bot) return;

    // Partial messageUpdate payloads may omit content/embeds until fetched.
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return;
      }
    }

    const targets = await listTargets(message.guild.id, { includeDisabled: false });
    if (!targets.length) return;

    // Watch exact channel OR parent channel (so threads inherit the parent watch).
    const channelId = message.channel.id;
    const parentId = message.channel.isThread?.()
      ? message.channel.parentId
      : message.channel.parentId || null;
    const watchedHere = await isChannelWatched(message.guild.id, channelId);
    const watchedParent = parentId
      ? await isChannelWatched(message.guild.id, parentId)
      : false;
    if (!watchedHere && !watchedParent) {
      if (Math.random() < 0.02) {
        log.info(
          `[image-target] skip unwatched channel=${channelId} guild=${message.guild.id} ` +
            `(have ${targets.length} target(s) — open /image-target hub → Watch this channel)`,
        );
      }
      return;
    }

    if (inflight.has(message.id)) return;
    inflight.add(message.id);

    const candidates = mediaBudget(collectCandidates(message));
    if (!candidates.length) {
      inflight.delete(message.id);
      return;
    }

    const started = Date.now();

    for (const candidate of candidates) {
      if (Date.now() - started > IMAGE_TARGET_ANALYSIS_TIMEOUT_MS) {
        log.warn(
          `[image-target] per-message analysis budget exhausted guild=${message.guild.id} message=${message.id}`,
        );
        break;
      }

      try {
        const match = await analysisQueue.add(async () => {
          const { buffer, meta } = await loadCandidateBuffer(candidate);
          return matchAgainstTargets(message.guild.id, buffer, { meta });
        });

        if (!match) continue;

        const score = match.finalScore ?? match.score ?? 0;
        const key = `${message.guild.id}:${match.target.targetId}:${message.author.id}:${match.method}:${Math.round(score * 100)}`;
        if (seenRecently(key)) continue;
        remember(key);

        const frameInfo =
          match.frameIndex != null
            ? ` frame=${match.frameIndex}` +
              (match.timestampSec != null
                ? ` t=${Number(match.timestampSec).toFixed(1)}s`
                : '')
            : '';
        const variantInfo = match.variantKey ? ` variant=${match.variantKey}` : '';

        log.info(
          `[image-target] match guild=${message.guild.id} user=${message.author.id} ` +
            `target=${match.target.name} score=${score.toFixed(3)} ` +
            `method=${match.methodLabel || match.method} ` +
            `media=${match.mediaKind || candidate.source}${frameInfo}${variantInfo}`,
        );

        // Normalize shape for actions (expects .score).
        await applyDetectionAction(message, {
          ...match,
          score,
        });
        break;
      } catch (err) {
        const msg = String(err.message || err);
        if (
          ![
            'ssrf_blocked',
            'too_large',
            'timeout',
            'not_an_image',
            'video_frame_failed',
            'analysis_timeout',
            'dns_failed',
            'empty',
          ].some((k) => msg.includes(k))
        ) {
          log.warn('[image-target] candidate failed:', msg);
        }
      }
    }
  } catch (err) {
    log.error('[image-target] watcher error:', err);
  } finally {
    inflight.delete(message.id);
  }
}

export function attachImageTargetWatcher(client) {
  client.on('messageCreate', (message) => {
    void handleImageTargetMessage(message);
  });

  client.on('messageUpdate', (oldMessage, message) => {
    // Re-scan on edits: users may swap embeds/attachments/links after posting.
    const oldHasMedia =
      (oldMessage?.attachments?.size || 0) > 0 ||
      (oldMessage?.embeds?.length || 0) > 0 ||
      Boolean(oldMessage?.content && /https?:\/\//i.test(oldMessage.content)) ||
      (oldMessage?.stickers?.size || 0) > 0;
    const newHasMedia =
      (message?.attachments?.size || 0) > 0 ||
      (message?.embeds?.length || 0) > 0 ||
      Boolean(message?.content && /https?:\/\//i.test(message.content)) ||
      (message?.stickers?.size || 0) > 0 ||
      message?.partial;

    if (!oldHasMedia && !newHasMedia) return;
    void handleImageTargetMessage(message);
  });

  log.info('[image-target] watcher attached (MessageCreate + MessageUpdate, V2)');
  return client;
}
