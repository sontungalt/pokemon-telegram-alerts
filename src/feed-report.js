import { readFile } from 'node:fs/promises';

import 'dotenv/config';

import { summarizeFeed, TIMESTAMP_RESOLUTION_MS } from './restock-feed.js';

const DATASET_PATH = process.env.FEED_DATASET_PATH?.trim() || 'feed/restocks.jsonl';

function bar(count, peak) {
  return '█'.repeat(Math.max(1, Math.round((count / peak) * 40)));
}

async function main() {
  let rows;
  try {
    const contents = await readFile(DATASET_PATH, 'utf8');
    rows = contents
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`No dataset at ${DATASET_PATH}. Run \`npm run feed:watch\` first.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const summary = summarizeFeed(rows);
  const hours = Object.entries(summary.dropsBySingaporeHour);

  console.log(`${summary.rows} drops recorded in ${DATASET_PATH}\n`);

  if (hours.length > 0) {
    const peak = Math.max(...hours.map(([, count]) => count));
    console.log('Drops by hour (Singapore time):');
    for (const [hour, count] of hours) {
      console.log(`  ${hour.padStart(2, '0')}:00  ${bar(count, peak)} ${count}`);
    }
    console.log('');
  }

  if (summary.medianPublishDelayMs === null) {
    console.log(
      `Publish delay: no measurable gaps — all ${summary.withinTimestampResolution} rows fell ` +
        `within the ${TIMESTAMP_RESOLUTION_MS}ms timestamp resolution of the source.`,
    );
  } else {
    console.log(
      `Publish delay: median ${(summary.medianPublishDelayMs / 1000).toFixed(1)}s ` +
        `(min ${(summary.minPublishDelayMs / 1000).toFixed(1)}s, ` +
        `max ${(summary.maxPublishDelayMs / 1000).toFixed(1)}s); ` +
        `${summary.withinTimestampResolution} rows below resolution.`,
    );
  }
}

await main();
