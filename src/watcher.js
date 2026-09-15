const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// While every listing is blocked nothing can be detected, so waiting longer costs
// no coverage and gives an IP-reputation block a chance to lapse.
const BLOCKED_BACKOFF_CAP_MS = 600_000;

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
  const summary = { observed: 0, failures: 0, alerts: 0, blocked: 0 };

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
      // A site-wide block would otherwise print one near-identical line per
      // listing; it is counted here and summarised once for the whole round.
      if (error.code === 'ANTI_BOT_CHALLENGE') {
        summary.blocked += 1;
      } else {
        // Driver errors carry a multi-line call log; keep the summary to one line.
        logger.error(`Check failed for ${product.name}: ${error.message.split('\n')[0]}`);
      }
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
  onBlockLifted = null,
  logger = console,
}) {
  const { AlertGate } = await import('./alert-gate.js');
  const alertGate = new AlertGate();
  let wasFullyBlocked = false;
  let blockedStreak = 0;

  while (shouldContinue()) {
    const summary = await scanRound({
      products: config.products,
      observe,
      alertGate,
      notify,
      logger,
      shouldContinue,
    });
    const blockedNote = summary.blocked > 0
      ? ` — ${summary.blocked} blocked by Lazada's anti-bot page, not checked.`
      : '';
    logger.info(
      `Round complete: ${summary.observed} checked, ${summary.alerts} alert(s), ${summary.failures} failure(s).${blockedNote}`,
    );

    // Tell the user the moment monitoring actually becomes possible again.
    const fullyBlocked = summary.blocked > 0 && summary.observed === 0;
    if (wasFullyBlocked && !fullyBlocked && summary.observed > 0 && onBlockLifted) {
      try {
        await onBlockLifted(summary);
      } catch (error) {
        logger.error(`Could not send the block-lifted notice: ${error.message}`);
      }
    }
    wasFullyBlocked = fullyBlocked;
    blockedStreak = fullyBlocked ? blockedStreak + 1 : 0;

    if (!shouldContinue()) break;

    const interval = blockedStreak > 0
      ? Math.min(config.pollIntervalMs * 2 ** blockedStreak, BLOCKED_BACKOFF_CAP_MS)
      : config.pollIntervalMs;
    if (blockedStreak > 0) {
      logger.info(`Everything is blocked; waiting ${Math.round(interval / 1_000)}s before retrying.`);
    }

    const jitter = config.jitterMs > 0 ? Math.floor(random() * config.jitterMs) : 0;
    await sleep(interval + jitter);
  }
}
