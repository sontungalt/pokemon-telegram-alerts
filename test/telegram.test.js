import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAvailabilityMessage, sendTelegramMessage } from '../src/telegram.js';

const detectedAt = new Date('2026-09-14T12:42:07Z');

const observation = (overrides = {}) => ({
  productName: 'Ascended Heroes Pokémon Center ETB',
  title: 'Ascended Heroes Pokémon Center ETB',
  seller: 'Pokémon Official Store',
  priceCents: 8990,
  observedUrl: 'https://www.lazada.sg/products/example-i123.html',
  ...overrides,
});

test('leads a restock alert with the Pokémon restock headline', () => {
  const message = formatAvailabilityMessage(observation(), 'restocked', detectedAt);

  assert.match(message, /<b>Pokémon restock detected<\/b>/);
});

test('includes the product name, price and clickable listing link', () => {
  const message = formatAvailabilityMessage(observation(), 'available', detectedAt);

  assert.match(message, /Ascended Heroes Pokémon Center ETB/);
  assert.match(message, /S\$89\.90/);
  assert.match(message, /href="https:\/\/www\.lazada\.sg\/products\/example-i123\.html"/);
});

test('stamps the detection time in Singapore time', () => {
  const message = formatAvailabilityMessage(observation(), 'available', detectedAt);

  assert.match(message, /14 Sep 2026/);
  assert.match(message, /20:42/);
  assert.match(message, /SGT/);
});

test('says the price is unknown rather than inventing one', () => {
  const message = formatAvailabilityMessage(observation({ priceCents: null }), 'available', detectedAt);

  assert.match(message, /Price not detected/);
  assert.doesNotMatch(message, /S\$/);
});

test('notes when an already available listing changed price', () => {
  const message = formatAvailabilityMessage(observation(), 'price-changed', detectedAt);

  assert.match(message, /<b>Pokémon restock detected<\/b>/);
  assert.match(message, /price changed/i);
});

test('escapes HTML in listing text so Telegram cannot mis-parse it', () => {
  const message = formatAvailabilityMessage(
    observation({ productName: 'Example <ETB> & "friends"' }),
    'available',
    detectedAt,
  );

  assert.match(message, /Example &lt;ETB&gt; &amp; &quot;friends&quot;/);
});

test('posts an HTML message to the configured Telegram chat', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  await sendTelegramMessage({
    token: '123456:telegram-token',
    chatId: '123456789',
    text: '<b>Pokémon restock detected</b>',
    fetchImpl,
  });

  assert.deepEqual(requests, [{
    url: 'https://api.telegram.org/bot123456:telegram-token/sendMessage',
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: '123456789',
        text: '<b>Pokémon restock detected</b>',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
  }]);
});

test('throws without leaking the bot token when Telegram rejects the message', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async json() { return { ok: false, description: 'Unauthorized' }; },
  });

  await assert.rejects(
    () => sendTelegramMessage({
      token: '123456:super-secret-token',
      chatId: '123456789',
      text: 'hello',
      fetchImpl,
    }),
    (error) => {
      assert.doesNotMatch(error.message, /super-secret-token/);
      assert.doesNotMatch(error.message, /123456789/);
      assert.match(error.message, /401/);
      return true;
    },
  );
});
