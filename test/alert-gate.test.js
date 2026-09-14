import assert from 'node:assert/strict';
import test from 'node:test';

import { AlertGate } from '../src/alert-gate.js';

const URL = 'https://s.lazada.sg/s.example';

const available = (priceCents = 8990) => ({ productUrl: URL, available: true, priceCents });
const unavailable = () => ({ productUrl: URL, available: false, priceCents: null });

const settle = (gate, observation) => {
  const decision = gate.evaluate(observation);
  gate.commit(observation);
  return decision;
};

test('alerts when an item is available on the first check', () => {
  assert.deepEqual(new AlertGate().evaluate(available()), { send: true, reason: 'available' });
});

test('suppresses a repeated in-stock result at the same price', () => {
  const gate = new AlertGate();
  settle(gate, available());

  assert.deepEqual(gate.evaluate(available()), { send: false, reason: 'unchanged' });
});

test('alerts when an item returns after being unavailable', () => {
  const gate = new AlertGate();
  settle(gate, available());
  settle(gate, unavailable());

  assert.deepEqual(gate.evaluate(available()), { send: true, reason: 'restocked' });
});

test('alerts when an available item changes price', () => {
  const gate = new AlertGate();
  settle(gate, available(8990));

  assert.deepEqual(gate.evaluate(available(9990)), { send: true, reason: 'price-changed' });
});

test('stays quiet while an item remains out of stock', () => {
  const gate = new AlertGate();
  settle(gate, unavailable());

  assert.deepEqual(gate.evaluate(unavailable()), { send: false, reason: 'unavailable' });
});

test('evaluating does not record the observation on its own', () => {
  const gate = new AlertGate();

  gate.evaluate(available());

  assert.deepEqual(gate.evaluate(available()), { send: true, reason: 'available' });
});

test('repeats an uncommitted price-change alert as a price change, not a first sighting', () => {
  const gate = new AlertGate();
  settle(gate, available(8990));

  const first = gate.evaluate(available(9990));
  const retry = gate.evaluate(available(9990));

  assert.deepEqual(first, { send: true, reason: 'price-changed' });
  assert.deepEqual(retry, { send: true, reason: 'price-changed' });
});

test('tracks each listing independently', () => {
  const gate = new AlertGate();
  settle(gate, available());

  assert.deepEqual(
    gate.evaluate({ productUrl: 'https://s.lazada.sg/s.other', available: true, priceCents: 100 }),
    { send: true, reason: 'available' },
  );
});
