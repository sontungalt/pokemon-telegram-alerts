const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A sleep that can be cut short, so Ctrl+C does not have to wait out a full
 * polling interval before the watcher shuts down.
 */
export function createInterruptibleSleep() {
  let interrupted = false;
  let wake = null;

  return {
    sleep(milliseconds) {
      if (interrupted) return Promise.resolve();

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, milliseconds);

        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    },
    interrupt() {
      interrupted = true;
      wake?.();
    },
  };
}

export async function scanRound({
  products,
  observe,
  alertGate,
  notify,
  logger = console,
  shouldContinue = () => true,
}) {
  const summary = { observed: 0, failures: 0, alerts: 0 };

  for (const product of products) {
    if (!shouldContinue()) break;

    try {
      const observation = await observe(product);
      summary.observed += 1;

      const decision = alertGate.evaluate(observation);
      if (!decision.send) {
        alertGate.commit(observation);
        continue;
      }

      // Commit only once Telegram has accepted the message: a delivery failure
      // leaves the previous state in place so the next round retries this alert.
      await notify(observation, decision.reason);
      alertGate.commit(observation);
      summary.alerts += 1;
    } catch (error) {
      summary.failures += 1;
      logger.error(`Check failed for ${product.name}: ${error.message}`);
    }
  }

  return summary;
}

export async function runWatcher({
  config,
  observe,
  notify,
  sleep = defaultSleep,
  random = Math.random,
  shouldContinue = () => true,
  logger = console,
}) {
  const { AlertGate } = await import('./alert-gate.js');
  const alertGate = new AlertGate();

  while (shouldContinue()) {
    const summary = await scanRound({
      products: config.products,
      observe,
      alertGate,
      notify,
      logger,
      shouldContinue,
    });
    logger.info(
      `Round complete: ${summary.observed} checked, ${summary.alerts} alert(s), ${summary.failures} failure(s).`,
    );

    if (!shouldContinue()) break;
    const jitter = config.jitterMs > 0 ? Math.floor(random() * config.jitterMs) : 0;
    await sleep(config.pollIntervalMs + jitter);
  }
}
