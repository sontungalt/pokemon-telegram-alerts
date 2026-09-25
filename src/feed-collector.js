import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseFeedMessage } from './restock-feed.js';

// Public channels expose a read-only preview at t.me/s/<handle> that needs no
// account, no bot token, and no API credentials. It is the same content any
// visitor sees in a browser.
const PREVIEW_ORIGIN = 'https://t.me/s/';

const MESSAGE_BLOCK = /<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"([\s\S]*?)(?=<div class="tgme_widget_message\b|$)/g;
const MESSAGE_TEXT = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const MESSAGE_TIME = /<time[^>]+datetime="([^"]+)"/;
const HREF = /href="([^"]+)"/g;

function decodeEntities(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // Telegram escapes accented characters as numeric references, so "Pokémon"
    // arrives as "Pok&#233;mon" and would otherwise be stored that way.
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Pulls posts out of the channel preview markup.
 *
 * This reads a known widget layout with regexes rather than a DOM parser, which
 * keeps the project dependency-free but means a Telegram markup change will
 * show up as zero parsed messages rather than as wrong ones.
 */
export function parsePreviewPage(html) {
  const messages = [];

  for (const [, id, block] of String(html ?? '').matchAll(MESSAGE_BLOCK)) {
    const rawText = MESSAGE_TEXT.exec(block)?.[1];
    if (!rawText) continue;

    const isoTime = MESSAGE_TIME.exec(block)?.[1];
    const postedAt = isoTime ? new Date(isoTime) : null;

    const links = [...block.matchAll(HREF)]
      .map(([, href]) => decodeEntities(href))
      .filter((href) => href.startsWith('http'));

    messages.push({
      id,
      text: decodeEntities(rawText),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      links,
    });
  }

  return messages;
}

async function loadSeenIds(datasetPath) {
  try {
    const existing = await readFile(datasetPath, 'utf8');
    const seen = new Set();
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { id } = JSON.parse(line);
        if (id) seen.add(id);
      } catch {
        // A truncated final line from an interrupted write is skipped, not fatal.
      }
    }
    return seen;
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

/**
 * Fetches the channel preview once and appends any posts not already recorded.
 * Returns the rows added, so a caller can decide whether the run was worth it.
 */
export async function collectOnce({
  handle,
  datasetPath,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const response = await fetchImpl(`${PREVIEW_ORIGIN}${encodeURIComponent(handle)}`, {
    headers: { 'accept-language': 'en-SG,en;q=0.9' },
  });

  if (!response.ok) {
    throw new Error(`Channel preview for ${handle} returned HTTP ${response.status}.`);
  }

  const messages = parsePreviewPage(await response.text());
  if (messages.length === 0) {
    logger.warn?.(
      `No posts parsed from ${handle}; the channel may be private or Telegram's markup changed.`,
    );
    return [];
  }

  const seen = await loadSeenIds(datasetPath);
  const fresh = messages
    .filter((message) => !seen.has(message.id))
    .map((message) => parseFeedMessage(message))
    // A post with no detection timestamp is chatter, not a restock.
    .filter((row) => row.foundAt !== null);

  if (fresh.length > 0) {
    await mkdir(dirname(datasetPath), { recursive: true });
    await appendFile(datasetPath, fresh.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }

  return fresh;
}
