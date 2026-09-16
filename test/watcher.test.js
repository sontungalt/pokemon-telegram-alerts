import assert from 'node:assert/strict';
import test from 'node:test';

import { AlertGate } from '../src/alert-gate.js';
import { createInterruptibleSleep, runWatcher, scanRound } from '../src/watcher.js';

const products = [
  { name: 'First item', url: 'https://s.lazada.sg/s.first' },
  { name: 'Second item', url: 'https://s.lazada.sg/s.second' },
];

const quietLogger = { error() {}, info() {}, warn() {} };

test('observes every listing and notifies only for an alertable item', async () => {
  const observed = [];
  const notices = [];

  const summary = await scanRound({
    products,
    observe: async (product) => {
      observed.push(product.name);
      return {
        productUrl: product.url,
        productName: product.name,
        available: product.name === 'First item',
        priceCents: 8990,
      };
    },
    alertGate: new AlertGate(),
    notify: async (observation, reason) => notices.push({ observation, reason }),
    logger: quietLogger,
  });

  assert.deepEqual(observed, ['First item', 'Second item']);
  assert.deepEqual(summary, { observed: 2, failures: 0, alerts: 1, blocked: 0 });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'available');
});

test('continues a round after one listing check fails', async () => {
  const observed = [];
  const errors = [];

  const summary = await scanRound({
    products,
    observe: async (product) => {
      observed.push(product.name);
      if (product.name === 'First item') throw new Error('temporary navigation failure');
      return { productUrl: product.url, available: false, priceCents: null };
    },
    alertGate: new AlertGate(),
    notify: async () => assert.fail('unavailable listing should not notify'),
    logger: { ...quietLogger, error(...args) { errors.push(args); } },
  });

  assert.deepEqual(observed, ['First item', 'Second item']);
  assert.deepEqual(summary, { observed: 1, failures: 1, alerts: 0, blocked: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /First item/);
});

test('does not repeat an alert for an unchanged available listing', async () => {
  const gate = new AlertGate();
  let sends = 0;
  const input = {
    products: [products[0]],
    observe: async (product) => ({ productUrl: product.url, available: true, priceCents: 8990 }),
    alertGate: gate,
    notify: async () => { sends += 1; },
    logger: quietLogger,
  };

  await scanRound(input);
  await scanRound(input);

  assert.equal(sends, 1);
});

test('retries an alert on the next round if Telegram delivery fails', async () => {
  const gate = new AlertGate();
  let attempts = 0;
  const input = {
    products: [products[0]],
    observe: async (product) => ({ productUrl: product.url, available: true, priceCents: 8990 }),
    alertGate: gate,
    notify: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Telegram temporarily unavailable');
    },
    logger: quietLogger,
  };

  const failed = await scanRound(input);
  const recovered = await scanRound(input);

  assert.equal(attempts, 2);
  assert.equal(failed.alerts, 0);
  assert.equal(failed.failures, 1);
  assert.equal(recovered.alerts, 1);
});

test('retries a failed price-change alert as a price change, not a first sighting', async () => {
  const gate = new AlertGate();
  const reasons = [];
  let failNext = false;
  let priceCents = 8990;

  const input = {
    products: [products[0]],
    observe: async (product) => ({ productUrl: product.url, available: true, priceCents }),
    alertGate: gate,
    notify: async (_observation, reason) => {
      reasons.push(reason);
      if (failNext) throw new Error('Telegram temporarily unavailable');
    },
    logger: quietLogger,
  };

  await scanRound(input);
  priceCents = 9990;
  failNext = true;
  await scanRound(input);
  failNext = false;
  await scanRound(input);

  assert.deepEqual(reasons, ['available', 'price-changed', 'price-changed']);
});

test('stops checking the remaining listings once shutdown begins', async () => {
  const observed = [];

  const summary = await scanRound({
    products,
    observe: async (product) => {
      observed.push(product.name);
      return { productUrl: product.url, available: false, priceCents: null };
    },
    alertGate: new AlertGate(),
    notify: async () => assert.fail('nothing is available'),
    logger: quietLogger,
    shouldContinue: () => observed.length === 0,
  });

  assert.deepEqual(observed, ['First item']);
  assert.equal(summary.observed, 1);
});

test('waits for the configured interval plus jitter before the next round', async () => {
  const waits = [];
  let checks = 0;

  await runWatcher({
    config: { products: [], pollIntervalMs: 30_000, jitterMs: 5_000 },
    observe: async () => assert.fail('there are no products'),
    notify: async () => assert.fail('there are no products'),
    sleep: async (milliseconds) => waits.push(milliseconds),
    random: () => 0.5,
    shouldContinue: () => {
      checks += 1;
      return checks < 3;
    },
    logger: quietLogger,
  });

  assert.deepEqual(waits, [32_500]);
});

test('reports one concise summary line per round', async () => {
  const lines = [];

  await runWatcher({
    config: { products, pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async (product) => ({ productUrl: product.url, available: false, priceCents: null }),
    notify: async () => {},
    sleep: async () => {},
    shouldContinue: () => lines.length < 1,
    logger: { ...quietLogger, info(line) { lines.push(line); } },
  });

  assert.deepEqual(lines, ['Round complete: 2 checked, 0 alert(s), 0 failure(s).']);
});

test('an interrupted sleep resolves immediately instead of waiting out the interval', async () => {
  const waiter = createInterruptibleSleep();
  const startedAt = Date.now();

  const pending = waiter.sleep(60_000);
  waiter.interrupt();
  await pending;

  assert.ok(Date.now() - startedAt < 1_000);
});

test('sleeping after an interrupt returns without waiting', async () => {
  const waiter = createInterruptibleSleep();
  waiter.interrupt();
  const startedAt = Date.now();

  await waiter.sleep(60_000);

  assert.ok(Date.now() - startedAt < 1_000);
});

const blockedError = () => Object.assign(new Error('anti-bot challenge'), { code: 'ANTI_BOT_CHALLENGE' });

test('counts blocked listings separately from real failures', async () => {
  const summary = await scanRound({
    products,
    observe: async (product) => {
      if (product.name === 'First item') throw blockedError();
      throw new Error('navigation timeout');
    },
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: quietLogger,
  });

  assert.equal(summary.blocked, 1);
  assert.equal(summary.failures, 2);
});

test('does not log a line per listing when they are all blocked', async () => {
  const errors = [];

  await scanRound({
    products,
    observe: async () => { throw blockedError(); },
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: { ...quietLogger, error(...a) { errors.push(a); } },
  });

  assert.deepEqual(errors, []);
});

test('still logs ordinary failures individually', async () => {
  const errors = [];

  await scanRound({
    products: [products[0]],
    observe: async () => { throw new Error('navigation timeout'); },
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: { ...quietLogger, error(...a) { errors.push(a); } },
  });

  assert.equal(errors.length, 1);
});

test('names the blocked count in the round summary', async () => {
  const lines = [];

  await runWatcher({
    config: { products, pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async () => { throw blockedError(); },
    notify: async () => {},
    sleep: async () => {},
    shouldContinue: () => lines.length < 1,
    logger: { ...quietLogger, info(line) { lines.push(line); } },
  });

  assert.match(lines[0], /2 blocked/);
});

test('announces once when Lazada becomes readable after being blocked', async () => {
  const announcements = [];
  let rounds = 0;

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async (product) => {
      rounds += 1;
      if (rounds <= 2) throw blockedError();
      return { productUrl: product.url, available: false, priceCents: null };
    },
    notify: async () => {},
    onBlockLifted: async () => { announcements.push(rounds); },
    sleep: async () => {},
    shouldContinue: () => rounds < 4,
    logger: quietLogger,
  });

  assert.deepEqual(announcements, [3]);
});

test('does not announce a block lift when nothing was ever blocked', async () => {
  const announcements = [];
  let rounds = 0;

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async (product) => {
      rounds += 1;
      return { productUrl: product.url, available: false, priceCents: null };
    },
    notify: async () => {},
    onBlockLifted: async () => { announcements.push(rounds); },
    sleep: async () => {},
    shouldContinue: () => rounds < 3,
    logger: quietLogger,
  });

  assert.deepEqual(announcements, []);
});

test('backs off when every listing is blocked', async () => {
  const waits = [];

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async () => { throw blockedError(); },
    notify: async () => {},
    sleep: async (ms) => { waits.push(ms); },
    shouldContinue: () => waits.length < 3,
    logger: quietLogger,
  });

  // 30s base, doubling for each consecutive fully-blocked round.
  assert.deepEqual(waits, [60_000, 120_000, 240_000]);
});

test('caps the blocked backoff so it keeps checking', async () => {
  const waits = [];

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async () => { throw blockedError(); },
    notify: async () => {},
    sleep: async (ms) => { waits.push(ms); },
    shouldContinue: () => waits.length < 6,
    logger: quietLogger,
  });

  assert.ok(Math.max(...waits) <= 600_000, `backoff exceeded cap: ${Math.max(...waits)}`);
  assert.equal(waits.at(-1), 600_000);
});

test('returns to the normal interval as soon as a listing is readable', async () => {
  const waits = [];
  let rounds = 0;

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 30_000, jitterMs: 0 },
    observe: async (product) => {
      rounds += 1;
      if (rounds <= 2) throw blockedError();
      return { productUrl: product.url, available: false, priceCents: null };
    },
    notify: async () => {},
    sleep: async (ms) => { waits.push(ms); },
    shouldContinue: () => rounds < 4,
    logger: quietLogger,
  });

  assert.deepEqual(waits, [60_000, 120_000, 30_000]);
});

test('logs only the first line of a multi-line failure', async () => {
  const errors = [];

  await scanRound({
    products: [products[0]],
    observe: async () => { throw new Error('page.goto timeout\nCall log:\n  - navigating\n  - waiting'); },
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: { ...quietLogger, error(line) { errors.push(line); } },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes('\n'), false);
  assert.match(errors[0], /page\.goto timeout/);
});

test('spaces out the listings within a round instead of bursting', async () => {
  const waits = [];

  await scanRound({
    products,
    observe: async (p) => ({ productUrl: p.url, available: false, priceCents: null }),
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: quietLogger,
    betweenProductsMs: 50_000,
    sleep: async (ms) => { waits.push(ms); },
  });

  // Two products: one gap between them, none before the first.
  assert.deepEqual(waits, [50_000]);
});

test('does not pause between listings when spacing is off', async () => {
  const waits = [];

  await scanRound({
    products,
    observe: async (p) => ({ productUrl: p.url, available: false, priceCents: null }),
    alertGate: new AlertGate(),
    notify: async () => {},
    logger: quietLogger,
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.deepEqual(waits, []);
});

test('subtracts time already spent in the round from the wait', async () => {
  const waits = [];
  let clock = 0;

  await runWatcher({
    config: { products: [products[0]], pollIntervalMs: 300_000, jitterMs: 0 },
    observe: async (p) => { clock += 120_000; return { productUrl: p.url, available: false, priceCents: null }; },
    notify: async () => {},
    sleep: async (ms) => { waits.push(ms); },
    now: () => clock,
    shouldContinue: () => waits.length < 1,
    logger: quietLogger,
  });

  // The round consumed 120s of the 300s cycle, so only 180s remain.
  assert.deepEqual(waits, [180_000]);
});
