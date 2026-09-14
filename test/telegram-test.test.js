import assert from 'node:assert/strict';
import test from 'node:test';

import { connectionTestMessage } from '../src/send-telegram-check.js';

test('creates a clear Telegram connection-test message', () => {
  assert.equal(
    connectionTestMessage(),
    '<b>Pokémon alert bot connected</b>\nTelegram notifications are ready.',
  );
});
