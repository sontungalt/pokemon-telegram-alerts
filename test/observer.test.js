import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';

import { observeListing, resetShareLinkCache } from '../src/lazada-observer.js';

const quietLogger = { warn() {}, error() {}, info() {} };
const TIMEOUT = 10_000;

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

/** A minimal stand-in for a Playwright page that records navigation. */
function fakePage({ originHref = null, snapshot = {}, finalUrl }) {
  const calls = [];
  return {
    calls,
    async goto(url, options) { calls.push({ type: 'goto', url, options }); },
    async evaluate() {
      // A 'commit' navigation means we are still on the share bridge.
      const last = calls.at(-1);
      return last?.options?.waitUntil === 'commit' ? originHref : snapshot;
    },
    url: () => finalUrl,
  };
}

const purchasable = {
  title: 'Pokémon Example ETB',
  priceText: 'S$ 89.90',
  control: { visible: true, enabled: true, text: 'Buy Now' },
};

test('resolves a share link through its origin link before observing the product', async () => {
  resetShareLinkCache();
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-a' };
  const direct = 'https://www.lazada.sg/products/example-i123-s456.html';
  const page = fakePage({ originHref: direct, snapshot: purchasable, finalUrl: direct });

  const observation = await observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger });

  assert.equal(observation.available, true);
  assert.deepEqual(page.calls, [
    { type: 'goto', url: product.url, options: { waitUntil: 'commit', timeout: TIMEOUT } },
    { type: 'goto', url: direct, options: { waitUntil: 'domcontentloaded', timeout: TIMEOUT } },
  ]);
});

test('strips tracking parameters from the resolved product URL', async () => {
  resetShareLinkCache();
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-b' };
  const page = fakePage({
    originHref: 'https://www.lazada.sg/products/example-i123.html?spm=a2o42.tracking&scm=1003.4&clickTrackInfo=xyz',
    snapshot: purchasable,
    finalUrl: 'https://www.lazada.sg/products/example-i123.html',
  });

  await observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger });

  assert.equal(page.calls[1].url, 'https://www.lazada.sg/products/example-i123.html');
});

test('reuses the cached direct URL instead of re-resolving the share link', async () => {
  resetShareLinkCache();
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-c' };
  const direct = 'https://www.lazada.sg/products/example-i999.html';
  const options = { timeoutMs: TIMEOUT, logger: quietLogger };

  await observeListing(fakePage({ originHref: direct, snapshot: purchasable, finalUrl: direct }), product, options);
  const second = fakePage({ originHref: direct, snapshot: purchasable, finalUrl: direct });
  await observeListing(second, product, options);

  assert.deepEqual(second.calls, [
    { type: 'goto', url: direct, options: { waitUntil: 'domcontentloaded', timeout: TIMEOUT } },
  ]);
});

test('falls back to the original URL and logs when the origin link is not Lazada', async () => {
  resetShareLinkCache();
  const warnings = [];
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-d' };
  const page = fakePage({
    originHref: 'https://example.com/phishing',
    snapshot: purchasable,
    finalUrl: 'https://s.lazada.sg/s.share-d',
  });

  await assert.rejects(
    () => observeListing(page, product, {
      timeoutMs: TIMEOUT,
      logger: { ...quietLogger, warn(line) { warnings.push(line); } },
    }),
    /could not resolve|not checked/i,
  );

  // It still falls back to the original URL, but never scores the share
  // bridge itself as a readable listing.
  assert.equal(page.calls[1].url, product.url);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Shared item/);
});

test('never reports the share bridge page as an out-of-stock listing', async () => {
  resetShareLinkCache();
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-f' };
  const page = fakePage({
    originHref: null,
    // A share page has a real title but never a purchase control.
    snapshot: { title: 'Pokémon Example ETB', priceText: null, control: null },
    finalUrl: product.url,
  });

  await assert.rejects(
    () => observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger }),
    (error) => {
      assert.equal(error.code, 'UNRESOLVED_SHARE_LINK');
      return true;
    },
  );
});

test('does not cache a failed share-link resolution', async () => {
  resetShareLinkCache();
  const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.share-e' };
  const options = { timeoutMs: TIMEOUT, logger: quietLogger };

  await observeListing(
    fakePage({ originHref: null, snapshot: purchasable, finalUrl: product.url }),
    product,
    options,
  ).catch(() => {});
  const retry = fakePage({ originHref: null, snapshot: purchasable, finalUrl: product.url });
  await observeListing(retry, product, options).catch(() => {});

  assert.equal(retry.calls[0].options.waitUntil, 'commit');
});

test('navigates a direct product URL without the share-resolution step', async () => {
  resetShareLinkCache();
  const product = { name: 'Direct item', url: 'https://www.lazada.sg/products/example-i1.html' };
  const page = fakePage({ snapshot: purchasable, finalUrl: product.url });

  await observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger });

  assert.deepEqual(page.calls, [
    { type: 'goto', url: product.url, options: { waitUntil: 'domcontentloaded', timeout: TIMEOUT } },
  ]);
});

/** Renders HTML in real Chromium and runs the in-page snapshot against it. */
async function observeHtml(html, finalUrl) {
  resetShareLinkCache();
  const realPage = await browser.newPage();
  try {
    const product = { name: 'Example ETB', url: 'https://www.lazada.sg/products/example-i1.html' };
    const page = {
      async goto() { await realPage.setContent(html); },
      evaluate: (...args) => realPage.evaluate(...args),
      url: () => finalUrl ?? product.url,
    };
    return await observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger });
  } finally {
    await realPage.close();
  }
}

test('detects a visible enabled pdp-button offering Buy Now', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <span class="pdp-price">S$ 89.90</span>
    <div class="pdp-button">Buy Now</div>
  `);

  assert.equal(observation.available, true);
  assert.equal(observation.priceCents, 8990);
});

test('detects an add-to-cart button and reads the seller', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <span class="seller-name">Pokémon Official Store</span>
    <span class="pdp-price">S$ 89.90</span>
    <button>Add to Cart</button>
  `);

  assert.equal(observation.available, true);
  assert.equal(observation.seller, 'Pokémon Official Store');
});

test('prefers an enabled purchase control over a disabled one earlier in the page', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <span class="pdp-price">S$ 89.90</span>
    <button disabled>Add to Cart</button>
    <div class="pdp-button">Buy Now</div>
  `);

  assert.equal(observation.available, true);
});

test('ignores prose mentioning add to cart when the real control is sold out', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <span class="pdp-price">S$ 89.90</span>
    <a href="#">Guide: how to add to cart on Lazada quickly when stock drops</a>
    <div class="pdp-button pdp-button-disabled">Out of Stock</div>
  `);

  assert.equal(observation.available, false);
});

test('treats a disabled out-of-stock button as unavailable', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <button disabled>Out of Stock</button>
  `);

  assert.equal(observation.available, false);
});

test('treats an aria-disabled purchase control as unavailable', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <div class="pdp-button" role="button" aria-disabled="true">Buy Now</div>
  `);

  assert.equal(observation.available, false);
});

test('treats a hidden purchase control as unavailable', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <div class="pdp-button" style="display:none">Buy Now</div>
  `);

  assert.equal(observation.available, false);
});

test('treats a Notify Me listing as unavailable', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <button>Notify Me When Available</button>
  `);

  assert.equal(observation.available, false);
});

test('reads the share page origin link from real DOM', async () => {
  resetShareLinkCache();
  const direct = 'https://www.lazada.sg/products/example-i123.html';
  const realPage = await browser.newPage();
  try {
    const product = { name: 'Shared item', url: 'https://s.lazada.sg/s.real-share' };
    const pages = [
      `<link rel="origin" href="${direct}?spm=tracking">`,
      '<title>Pokémon Example ETB</title><span class="pdp-price">S$ 89.90</span><div class="pdp-button">Buy Now</div>',
    ];
    const visited = [];
    const page = {
      async goto(url) { visited.push(url); await realPage.setContent(pages[visited.length - 1]); },
      evaluate: (...args) => realPage.evaluate(...args),
      url: () => direct,
    };

    const observation = await observeListing(page, product, { timeoutMs: TIMEOUT, logger: quietLogger });

    assert.deepEqual(visited, [product.url, direct]);
    assert.equal(observation.available, true);
  } finally {
    await realPage.close();
  }
});

test('treats an anti-bot challenge page as a failure, not as out of stock', async () => {
  await assert.rejects(
    () => observeHtml(`
      <html><head></head><body>
        <div id="baxia-dialog-content">Click to feedback &gt;</div>
      </body></html>
    `, 'https://www.lazada.sg//products/example-i1.html/_____tmd_____/punish?x5secdata=abc&x5step=1'),
    /anti-bot|challenge|blocked/i,
  );
});

test('treats an empty shell page as a failure rather than silently unavailable', async () => {
  await assert.rejects(
    () => observeHtml('<html><head></head><body></body></html>'),
    /could not read/i,
  );
});

test('still reports a readable sold-out listing as unavailable rather than failing', async () => {
  const observation = await observeHtml(`
    <title>Pokémon Example ETB</title>
    <span class="pdp-price">S$ 89.90</span>
    <button disabled>Out of Stock</button>
  `);

  assert.equal(observation.available, false);
});

test('marks an anti-bot failure with a code the watcher can count', async () => {
  await observeHtml(`<div id="baxia-dialog-content">Click to feedback</div>`)
    .then(() => assert.fail('expected a challenge error'))
    .catch((error) => assert.equal(error.code, 'ANTI_BOT_CHALLENGE'));
});

test('does not mark an ordinary unreadable page as an anti-bot failure', async () => {
  await observeHtml('<html><body></body></html>')
    .then(() => assert.fail('expected an unreadable error'))
    .catch((error) => assert.notEqual(error.code, 'ANTI_BOT_CHALLENGE'));
});
