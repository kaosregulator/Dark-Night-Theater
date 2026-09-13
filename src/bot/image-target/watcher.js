import { log } from '../../logger.js';
import { applyDetectionAction } from './actions.js';
import { matchAgainstTargets } from './detector.js';
import {
  downloadBytes,
  extractCustomEmojis,
  extractImageUrls,
  loadMediaAsImage,
  looksLikeImage,
  looksLikeVideo,
} from './download.js';
import { isChannelWatched, listTargets } from './store.js';

/**
 * Message watcher for image targets.
 * Scans attachments, embeds, direct image URLs, custom emoji, and stickers
 * in configured channels. Async / fire-and-forget so the gateway stays free.
 *
 * Per candidate: download → loadMediaAsImage → matchAgainstTargets → action
 */

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

function collectCandidates(message) {
  const out = [];

  for (const att of message.attachments.values()) {
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

  for (const emb of message.embeds) {
    const url =
      emb.image?.proxyURL ||
      emb.image?.url ||
      emb.thumbnail?.proxyURL ||
      emb.thumbnail?.url;
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
        filename: `${em.name}.png`,
        url: em.url,
      },
      source: 'emoji',
    });
  }

  for (const st of message.stickers?.values?.() || []) {
    // 1=PNG, 2=APNG, 4=GIF (skip Lottie=3)
    if (st.format === 1 || st.format === 2 || st.format === 4) {
      const url = `https://media.discordapp.net/stickers/${st.id}.png?size=160`;
      out.push({
        url,
        meta: { contentType: 'image/png', filename: `${st.name}.png`, url },
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

async function loadCandidate(candidate) {
  const downloaded = await downloadBytes(candidate.url);
  const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded.buffer;
  const contentType = downloaded.contentType || candidate.meta.contentType || '';
  const loaded = await loadMediaAsImage(buffer, {
    ...candidate.meta,
    contentType,
  });
  return Buffer.isBuffer(loaded) ? loaded : loaded.buffer;
}

export async function handleImageTargetMessage(message) {
  try {
    if (!message.guild || message.author?.bot) return;
    if (!(await isChannelWatched(message.guild.id, message.channel.id))) return;

    const targets = await listTargets(message.guild.id, { includeDisabled: false });
    if (!targets.length) return;

    if (inflight.has(message.id)) return;
    inflight.add(message.id);

    const candidates = collectCandidates(message);
    if (!candidates.length) {
      inflight.delete(message.id);
      return;
    }

    const limited = candidates.slice(0, 4);

    for (const candidate of limited) {
      try {
        const imageBuffer = await loadCandidate(candidate);
        const match = await matchAgainstTargets(message.guild.id, imageBuffer);
        if (!match) continue;

        const key = `${message.guild.id}:${match.target.targetId}:${message.author.id}:${match.method}:${Math.round((match.score || 0) * 100)}`;
        if (seenRecently(key)) continue;
        remember(key);

        log.info(
          `[image-target] match guild=${message.guild.id} user=${message.author.id} ` +
            `target=${match.target.name} score=${match.score.toFixed(3)} method=${match.method}`,
        );

        await applyDetectionAction(message, match);
        break;
      } catch (err) {
        const msg = String(err.message || err);
        if (
          !['ssrf_blocked', 'too_large', 'timeout', 'not_an_image', 'video_frame_failed'].some((k) =>
            msg.includes(k),
          )
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

  client.on('messageUpdate', (_old, message) => {
    if (!message.embeds?.length && !message.attachments?.size) return;
    void handleImageTargetMessage(message);
  });

  log.info('[image-target] watcher attached (MessageCreate + MessageUpdate)');
  return client;
}
