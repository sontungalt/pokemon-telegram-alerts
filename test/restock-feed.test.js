import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseFeedMessage,
  parseFoundAtTime,
  parseProductName,
  resolveFoundAt,
  summarizeFeed,
} from '../src/restock-feed.js';

// The format public restock channels post in, kept verbatim so a change to the
// channel shows up here first.
const POST = [
  '🚨 STOCK FOUND 🚨',
  '⏱ Found at 13:25:11.135',
  '📦 Pokémon Trading Card Game: 30th Celebration 2-Pack Blister [Limit 1 per person]',
  '👉 =====Open PDP=====',
].join('\n');

test('reads a detection timestamp down to the millisecond', () => {
  assert.deepEqual(parseFoundAtTime(POST), {
    hours: 13,
    minutes: 25,
    seconds: 11,
    milliseconds: 135,
  });
});

test('treats a single fractional digit as tenths of a second', () => {
  assert.equal(parseFoundAtTime('Found at 09:01:02.5').milliseconds, 500);
  assert.equal(parseFoundAtTime('Found at 09:01:02').milliseconds, 0);
});

test('returns no timestamp rather than guessing when the line is absent', () => {
  assert.equal(parseFoundAtTime('STOCK FOUND'), null);
  assert.equal(parseFoundAtTime(''), null);
  assert.equal(parseFoundAtTime(null), null);
});

test('rejects an out-of-range clock reading', () => {
  assert.equal(parseFoundAtTime('Found at 25:00:00.000'), null);
  assert.equal(parseFoundAtTime('Found at 12:61:00.000'), null);
});

test('takes the product name from the line that is not a header or a link', () => {
  assert.equal(
    parseProductName(POST),
    'Pokémon Trading Card Game: 30th Celebration 2-Pack Blister [Limit 1 per person]',
  );
});

test('pins a wall-clock detection time to the Singapore day it was posted on', () => {
  const postedAt = new Date('2026-09-23T05:25:30Z'); // 13:25:30 in Singapore
  const foundAt = resolveFoundAt(
    { hours: 13, minutes: 25, seconds: 11, milliseconds: 135 },
    postedAt,
  );

  assert.equal(foundAt.toISOString(), '2026-09-23T05:25:11.135Z');
});

test('rolls a detection back a day when it is published after midnight', () => {
  const postedAt = new Date('2026-09-23T16:00:05Z'); // 00:00:05 on the 24th in Singapore
  const foundAt = resolveFoundAt(
    { hours: 23, minutes: 59, seconds: 58, milliseconds: 0 },
    postedAt,
  );

  assert.equal(foundAt.toISOString(), '2026-09-23T15:59:58.000Z');
  assert.ok(postedAt.getTime() - foundAt.getTime() > 0);
});

test('measures the gap between detection and publication', () => {
  const row = parseFeedMessage({
    id: 'snipertcg/1234',
    text: POST,
    postedAt: new Date('2026-09-23T05:25:30Z'),
    links: ['https://t.me/other', 'https://www.lazada.sg/products/example-i123.html'],
  });

  assert.equal(row.id, 'snipertcg/1234');
  assert.equal(row.pdpUrl, 'https://www.lazada.sg/products/example-i123.html');
  assert.equal(row.foundAt, '2026-09-23T05:25:11.135Z');
  assert.equal(row.publishDelayMs, 18_865);
});

test('reports no delay rather than a negative one when the post has no timestamp', () => {
  const row = parseFeedMessage({
    id: 'snipertcg/9',
    text: 'Channel maintenance notice',
    postedAt: new Date('2026-09-23T05:25:30Z'),
  });

  assert.equal(row.foundAt, null);
  assert.equal(row.publishDelayMs, null);
});

test('summarizes delays and clusters drops by Singapore hour', () => {
  const summary = summarizeFeed([
    { foundAt: '2026-09-23T05:25:11.135Z', publishDelayMs: 18_865 }, // 13:25 SGT
    { foundAt: '2026-09-23T05:40:00.000Z', publishDelayMs: 30_000 }, // 13:40 SGT
    { foundAt: '2026-09-23T02:10:00.000Z', publishDelayMs: 12_000 }, // 10:10 SGT
    { foundAt: null, publishDelayMs: null },
  ]);

  assert.equal(summary.rows, 4);
  assert.equal(summary.medianPublishDelayMs, 18_865);
  assert.equal(summary.minPublishDelayMs, 12_000);
  assert.equal(summary.maxPublishDelayMs, 30_000);
  assert.deepEqual(summary.dropsBySingaporeHour, { 10: 1, 13: 2 });
});

test('excludes sub-second gaps from the delay stats instead of counting them as zero', () => {
  // A post timestamped to the second against a detection timestamped to the
  // millisecond produces gaps of a few hundred ms in either direction. Treating
  // those as real would put a fictitious median on the board.
  const summary = summarizeFeed([
    { foundAt: '2026-09-23T05:25:11.135Z', publishDelayMs: -400 },
    { foundAt: '2026-09-23T05:26:11.000Z', publishDelayMs: 76 },
    { foundAt: '2026-09-23T05:27:11.000Z', publishDelayMs: 689 },
    { foundAt: '2026-09-23T05:28:11.000Z', publishDelayMs: 45_000 },
  ]);

  assert.equal(summary.rows, 4);
  assert.equal(summary.withinTimestampResolution, 3);
  assert.equal(summary.medianPublishDelayMs, 45_000);
  assert.equal(summary.minPublishDelayMs, 45_000);
});

test('reports no delay statistics at all when every gap is below resolution', () => {
  const summary = summarizeFeed([
    { foundAt: '2026-09-23T05:25:11.135Z', publishDelayMs: -100 },
    { foundAt: '2026-09-23T05:26:11.000Z', publishDelayMs: 300 },
  ]);

  assert.equal(summary.medianPublishDelayMs, null);
  assert.equal(summary.withinTimestampResolution, 2);
});
