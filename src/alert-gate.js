/**
 * Decides whether an observation deserves a Telegram alert.
 *
 * `evaluate` is deliberately pure: the caller commits the observation only once
 * delivery has actually succeeded, so a failed send is retried on the next round
 * with its original reason rather than being recorded as already alerted.
 */
export class AlertGate {
  #states = new Map();

  evaluate(observation) {
    const previous = this.#states.get(observation.productUrl);

    if (!observation.available) return { send: false, reason: 'unavailable' };
    if (!previous) return { send: true, reason: 'available' };
    if (!previous.available) return { send: true, reason: 'restocked' };
    if (previous.priceCents !== observation.priceCents) {
      return { send: true, reason: 'price-changed' };
    }
    return { send: false, reason: 'unchanged' };
  }

  commit(observation) {
    this.#states.set(observation.productUrl, {
      available: observation.available,
      priceCents: observation.priceCents,
    });
  }

  forget(productUrl) {
    this.#states.delete(productUrl);
  }
}
