import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectOnce, parsePreviewPage } from '../src/feed-collector.js';

// A trimmed copy of the public t.me/s/<handle> widget markup.
const PREVIEW = `
<main>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="snipertcg/1234" data-view="eyJ4IjoxfQ">
    <div class="tgme_widget_message_text js-message_text" dir="auto">🚨 STOCK FOUND 🚨<br/>⏱ Found at 13:25:11.135<br/>📦 Pok&#233;mon TCG: 30th Celebration 2-Pack Blister [Limit 1 per person]<br/><a href="https://www.lazada.sg/products/blister-i900.html">=====Open PDP=====</a></div>
    <div class="tgme_widget_message_footer">
      <time datetime="2026-09-23T05:25:30+00:00" class="time">13:25</time>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="snipertcg/1235">
    <div class="tgme_widget_message_text js-message_text" dir="auto">This is a FREE public restock channel.</div>
    <div class="tgme_widget_message_footer">
      <time datetime="2026-09-23T05:30:00+00:00" class="time">13:30</time>
    </div>
  </div>
</div>
</main>`;

function stubFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, text: async () => body });
}

test('separates posts and decodes their text', () => {
  const messages = parsePreviewPage(PREVIEW);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 'snipertcg/1234');
  assert.match(messages[0].text, /Found at 13:25:11\.135/);
  assert.match(messages[0].text, /Pokémon TCG/);
  assert.equal(messages[0].postedAt.toISOString(), '2026-09-23T05:25:30.000Z');
  assert.deepEqual(messages[0].links, ['https://www.lazada.sg/products/blister-i900.html']);
});

test('parses nothing rather than guessing when the markup is unrecognized', () => {
  assert.deepEqual(parsePreviewPage('<html><body>login required</body></html>'), []);
  assert.deepEqual(parsePreviewPage(''), []);
});

test('records only posts carrying a detection timestamp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  const datasetPath = join(directory, 'nested', 'restocks.jsonl');

  const rows = await collectOnce({
    handle: 'snipertcg',
    datasetPath,
    fetchImpl: stubFetch(PREVIEW),
  });

  // The channel-description post has no found-at line and is not a restock.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'snipertcg/1234');
  assert.equal(rows[0].publishDelayMs, 18_865);

  const written = await readFile(datasetPath, 'utf8');
  assert.equal(written.trim().split('\n').length, 1);
});

test('does not record a post twice across runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));
  const datasetPath = join(directory, 'restocks.jsonl');
  const options = { handle: 'snipertcg', datasetPath, fetchImpl: stubFetch(PREVIEW) };

  await collectOnce(options);
  const second = await collectOnce(options);

  assert.deepEqual(second, []);
  const written = await readFile(datasetPath, 'utf8');
  assert.equal(written.trim().split('\n').length, 1);
});

test('reports an unreachable channel rather than recording an empty run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feed-'));

  await assert.rejects(
    collectOnce({
      handle: 'snipertcg',
      datasetPath: join(directory, 'restocks.jsonl'),
      fetchImpl: stubFetch('', { ok: false, status: 404 }),
    }),
    /returned HTTP 404/,
  );
});
