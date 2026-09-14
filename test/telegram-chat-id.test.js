import assert from 'node:assert/strict';
import test from 'node:test';

import { chatIdsFromUpdates, getChatIds } from '../src/telegram-chat-id.js';

test('returns each chat ID that sent the bot a message', () => {
  const ids = chatIdsFromUpdates({
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 111 } } },
      { update_id: 2, message: { chat: { id: 222 } } },
      { update_id: 3, message: { chat: { id: 111 } } },
    ],
  });

  assert.deepEqual(ids, ['111', '222']);
});

test('reads channel posts as well as direct messages', () => {
  const ids = chatIdsFromUpdates({ ok: true, result: [{ channel_post: { chat: { id: -100 } } }] });

  assert.deepEqual(ids, ['-100']);
});

test('returns nothing when the bot has no messages yet', () => {
  assert.deepEqual(chatIdsFromUpdates({ ok: true, result: [] }), []);
  assert.deepEqual(chatIdsFromUpdates(null), []);
});

test('calls the getUpdates endpoint for the supplied bot', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, async json() { return { ok: true, result: [] }; } };
  };

  await getChatIds('123456:telegram-token', fetchImpl);

  assert.deepEqual(urls, ['https://api.telegram.org/bot123456:telegram-token/getUpdates']);
});

test('reports a rejected getUpdates call without leaking the bot token', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async json() { return { ok: false, description: 'Unauthorized' }; },
  });

  await assert.rejects(
    () => getChatIds('123456:super-secret-token', fetchImpl),
    (error) => {
      assert.doesNotMatch(error.message, /super-secret-token/);
      assert.match(error.message, /401/);
      return true;
    },
  );
});
