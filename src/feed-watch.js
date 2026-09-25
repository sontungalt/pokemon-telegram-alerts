import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import 'dotenv/config';

import { collectOnce } from './feed-collector.js';
import { summarizeFeed } from './restock-feed.js';
import { createTimestampedLogger } from './logger.js';

const DATASET_PATH = process.env.FEED_DATASET_PATH?.trim() || 'feed/restocks.jsonl';
const HANDLE = process.env.FEED_CHANNEL_HANDLE?.trim();

// The preview page is a public web page, so this stays at a browsing cadence.
// Nothing here races anyone: the dataset is for learning when drops happen.
const POLL_MS = Math.max(Number(process.env.FEED_POLL_SECONDS ?? 60), 30) * 1_000;

async function readDataset(path) {
  try {
    const contents = await readFile(path, 'utf8');
    return contents
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function describe(summary) {
  const hours = Object.entries(summary.dropsBySingaporeHour)
    .map(([hour, count]) => `${hour.padStart(2, '0')}:00×${count}`)
    .join(' ');

  const median =
    summary.medianPublishDelayMs === null
      ? 'unknown'
      : `${(summary.medianPublishDelayMs / 1000).toFixed(1)}s`;

  return `${summary.rows} drops recorded; median publish delay ${median}${hours ? `; by hour ${hours}` : ''}`;
}

async function main() {
  const logger = createTimestampedLogger();

  if (!HANDLE) {
    logger.error('FEED_CHANNEL_HANDLE is required (the @name of a public channel, without the @).');
    process.exitCode = 1;
    return;
  }

  logger.info(`Recording public restock posts from t.me/s/${HANDLE} every ${POLL_MS / 1000}s.`);

  let running = true;
  process.on('SIGINT', () => {
    running = false;
    logger.info('Received SIGINT; stopping after the current fetch.');
  });

  while (running) {
    try {
      const fresh = await collectOnce({ handle: HANDLE, datasetPath: DATASET_PATH, logger });

      for (const row of fresh) {
        const delay =
          row.publishDelayMs === null ? 'unknown' : `${(row.publishDelayMs / 1000).toFixed(1)}s`;
        logger.info(`Recorded ${row.productName ?? 'unnamed drop'} — published ${delay} after detection.`);
      }

      if (fresh.length > 0) {
        logger.info(describe(summarizeFeed(await readDataset(DATASET_PATH))));
      }
    } catch (error) {
      logger.error(`Collection failed: ${error.message}`);
    }

    if (!running) break;
    await sleep(POLL_MS);
  }

  logger.info('Feed watcher stopped.');
}

await main();
