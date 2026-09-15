import assert from 'node:assert/strict';
import test from 'node:test';

import { createTimestampedLogger } from '../src/logger.js';

function capture() {
  const lines = { info: [], error: [], warn: [] };
  const sink = {
    info: (l) => lines.info.push(l),
    error: (l) => lines.error.push(l),
    warn: (l) => lines.warn.push(l),
  };
  return { lines, sink };
}

test('prefixes each line with a Singapore-time stamp', () => {
  const { lines, sink } = capture();
  const logger = createTimestampedLogger(sink, () => new Date('2026-09-16T02:00:09Z'));

  logger.info('Round complete');

  assert.deepEqual(lines.info, ['[10:00:09] Round complete']);
});

test('stamps warnings and errors too', () => {
  const { lines, sink } = capture();
  const logger = createTimestampedLogger(sink, () => new Date('2026-09-16T02:00:09Z'));

  logger.warn('careful');
  logger.error('broken');

  assert.deepEqual(lines.warn, ['[10:00:09] careful']);
  assert.deepEqual(lines.error, ['[10:00:09] broken']);
});

test('keeps a multi-line message to a single log line', () => {
  const { lines, sink } = capture();
  const logger = createTimestampedLogger(sink, () => new Date('2026-09-16T02:00:09Z'));

  logger.error('page.goto failed\nCall log:\n  - navigating to "https://..."\n  - waiting');

  assert.equal(lines.error.length, 1);
  assert.equal(lines.error[0].includes('\n'), false);
  assert.match(lines.error[0], /page\.goto failed/);
});
