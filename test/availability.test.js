import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeObservation, parsePriceCents } from '../src/availability.js';

const product = { name: 'Example ETB', url: 'https://s.lazada.sg/s.example' };

test('parses Singapore-dollar prices into cents', () => {
  assert.equal(parsePriceCents('S$ 89.90'), 8990);
  assert.equal(parsePriceCents('S$89.90'), 8990);
  assert.equal(parsePriceCents('SGD 1,234.50'), 123450);
  assert.equal(parsePriceCents('S$120'), 12000);
});

test('returns no price rather than guessing when none is present', () => {
  assert.equal(parsePriceCents('Price unavailable'), null);
  assert.equal(parsePriceCents(''), null);
  assert.equal(parsePriceCents(null), null);
  assert.equal(parsePriceCents(undefined), null);
});

test('ignores a bare number with no Singapore-dollar marker', () => {
  assert.equal(parsePriceCents('89.90'), null);
});

test('marks a listing available for a visible enabled purchase control', () => {
  const observation = normalizeObservation(product, 'https://www.lazada.sg/products/example.html', {
    title: 'Pokémon Example ETB',
    seller: 'Pokémon Official Store',
    priceText: 'S$ 89.90',
    control: { visible: true, enabled: true, text: 'Add to Cart' },
  });

  assert.deepEqual(observation, {
    productName: 'Example ETB',
    productUrl: 'https://s.lazada.sg/s.example',
    observedUrl: 'https://www.lazada.sg/products/example.html',
    title: 'Pokémon Example ETB',
    seller: 'Pokémon Official Store',
    priceCents: 8990,
    available: true,
    reason: 'purchase-control-ready',
  });
});

test('treats a disabled control as unavailable', () => {
  const observation = normalizeObservation(product, product.url, {
    control: { visible: true, enabled: false, text: 'Add to Cart' },
  });

  assert.equal(observation.available, false);
  assert.equal(observation.reason, 'purchase-control-unavailable');
});

test('treats an invisible control as unavailable', () => {
  const observation = normalizeObservation(product, product.url, {
    control: { visible: false, enabled: true, text: 'Buy Now' },
  });

  assert.equal(observation.available, false);
});

test('treats out-of-stock wording as unavailable even when the control is enabled', () => {
  for (const text of ['Out of Stock', 'Sold Out', 'Notify Me', 'Coming Soon']) {
    const observation = normalizeObservation(product, product.url, {
      control: { visible: true, enabled: true, text },
    });

    assert.equal(observation.available, false, `${text} must not count as available`);
  }
});

test('treats a page with no purchase control as unavailable', () => {
  assert.equal(normalizeObservation(product, product.url, {}).available, false);
});

test('falls back to the configured name when the page has no title', () => {
  const observation = normalizeObservation(product, product.url, { title: '   ' });

  assert.equal(observation.title, 'Example ETB');
  assert.equal(observation.seller, null);
});

test('survives a missing snapshot instead of throwing mid-round', () => {
  for (const snapshot of [null, undefined]) {
    const observation = normalizeObservation(product, product.url, snapshot);

    assert.equal(observation.available, false);
    assert.equal(observation.priceCents, null);
  }
});

test('parses Lazada Singapore prices written with a bare dollar sign', () => {
  assert.equal(parsePriceCents('$18.90'), 1890);
  assert.equal(parsePriceCents('$90.90'), 9090);
  assert.equal(parsePriceCents('$1,234.50'), 123450);
});

test('still parses the S$ and SGD forms', () => {
  assert.equal(parsePriceCents('S$ 89.90'), 8990);
  assert.equal(parsePriceCents('SGD 1,234.50'), 123450);
});
