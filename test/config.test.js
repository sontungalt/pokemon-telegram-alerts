import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, PRODUCTS } from '../src/config.js';

const validEnvironment = {
  TELEGRAM_BOT_TOKEN: '123456:telegram-token',
  TELEGRAM_CHAT_ID: '123456789',
};

test('loads the supplied product listings', () => {
  const config = loadConfig(validEnvironment);

  assert.equal(PRODUCTS.length, 19);
  assert.equal(config.products[0].name, '30th Anniversary Pokémon Center ETB');
  assert.equal(config.products.at(-1).url, 'https://s.lazada.sg/s.f5Z2U?c=b');
});

test('defaults to a thirty-second poll with no jitter when unset', () => {
  const config = loadConfig(validEnvironment);

  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.jitterMs, 0);
});

test('defaults the navigation timeout to twenty-five seconds', () => {
  assert.equal(loadConfig(validEnvironment).navigationTimeoutMs, 25_000);
});

test('reads NAVIGATION_TIMEOUT_MS in milliseconds', () => {
  const config = loadConfig({ ...validEnvironment, NAVIGATION_TIMEOUT_MS: '40000' });

  assert.equal(config.navigationTimeoutMs, 40_000);
});

test('rejects a navigation timeout too short to load a product page', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, NAVIGATION_TIMEOUT_MS: '900' }),
    /NAVIGATION_TIMEOUT_MS/,
  );
});

test('rejects a missing Telegram bot token', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_CHAT_ID: '123456789' }),
    /TELEGRAM_BOT_TOKEN/,
  );
});

test('rejects a missing Telegram chat ID', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: '123456:telegram-token' }),
    /TELEGRAM_CHAT_ID/,
  );
});

test('rejects a poll interval below thirty seconds', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, POLL_INTERVAL_SECONDS: '29' }),
    /at least 30 seconds/,
  );
});

test('rejects a non-numeric poll interval instead of silently defaulting', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, POLL_INTERVAL_SECONDS: 'soon' }),
    /POLL_INTERVAL_SECONDS/,
  );
});

test('never exposes the token or chat ID through string conversion', () => {
  const config = loadConfig(validEnvironment);

  assert.doesNotMatch(JSON.stringify(config.products), /telegram-token/);
  assert.equal(Object.isFrozen(config), true);
});

test('accepts a listing spacing and reports none when it is unset', () => {
  assert.equal(loadConfig(validEnvironment).listingSpacingMs, null);
  assert.equal(
    loadConfig({ ...validEnvironment, LISTING_SPACING_MS: '200' }).listingSpacingMs,
    200,
  );
  assert.equal(loadConfig({ ...validEnvironment, LISTING_SPACING_MS: '0' }).listingSpacingMs, 0);
});

test('rejects a listing spacing that is negative, fractional, or absurdly long', () => {
  for (const value of ['-1', '2.5', '90000', 'soon']) {
    assert.throws(
      () => loadConfig({ ...validEnvironment, LISTING_SPACING_MS: value }),
      /LISTING_SPACING_MS must be an integer between 0 and 60000 milliseconds\./,
    );
  }
});

test('defaults to one check at a time and accepts a larger pool', () => {
  assert.equal(loadConfig(validEnvironment).checkConcurrency, 1);
  assert.equal(
    loadConfig({ ...validEnvironment, CHECK_CONCURRENCY: '5' }).checkConcurrency,
    5,
  );
});

test('rejects a concurrency below one', () => {
  for (const value of ['0', '-2', '1.5']) {
    assert.throws(
      () => loadConfig({ ...validEnvironment, CHECK_CONCURRENCY: value }),
      /CHECK_CONCURRENCY must be an integer of at least 1 checks\./,
    );
  }
});
