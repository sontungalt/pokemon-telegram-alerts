import { chromium } from 'playwright';

import { loadConfig } from './config.js';
import { observeListing } from './lazada-observer.js';
import { formatAvailabilityMessage, sendTelegramMessage, singaporeTimestamp } from './telegram.js';
import { createTimestampedLogger } from './logger.js';
import { createInterruptibleSleep, runWatcher } from './watcher.js';

// Skipped resources never affect availability detection and make each check faster.
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);

async function main() {
  await import('dotenv/config');
  const config = loadConfig();
  const logger = createTimestampedLogger(console);
  const waiter = createInterruptibleSleep();

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`Received ${signal}; finishing the current check, then shutting down.`);
    waiter.interrupt();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  logger.info(
    `Watching ${config.products.length} Lazada listings every ${config.pollIntervalMs / 1_000}s. Alerts only; nothing is ever purchased.`,
  );

  // A dedicated, empty browser profile: no saved cookies, no Lazada account, no login.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
  });
  await context.route('**/*', (route) => (
    SKIPPED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue()
  ));
  const page = await context.newPage();

  try {
    await runWatcher({
      config,
      shouldContinue: () => !stopping,
      sleep: (milliseconds) => waiter.sleep(milliseconds),
      logger,
      observe: (product) => observeListing(page, product, {
        timeoutMs: config.navigationTimeoutMs,
        logger,
      }),
      onBlockLifted: async () => {
        await sendTelegramMessage({
          token: config.telegramBotToken,
          chatId: config.telegramChatId,
          text: [
            '<b>Lazada is readable again</b>',
            '',
            'The anti-bot block has cleared and restock monitoring is live.',
            `Resumed: ${singaporeTimestamp(new Date())}`,
          ].join('\n'),
        });
        logger.info('Lazada is readable again; monitoring resumed.');
      },
      notify: async (observation, reason) => {
        await sendTelegramMessage({
          token: config.telegramBotToken,
          chatId: config.telegramChatId,
          text: formatAvailabilityMessage(observation, reason, new Date()),
        });
        logger.info(`Sent ${reason} alert for ${observation.productName}.`);
      },
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    logger.info('Browser closed. Watcher stopped.');
  }
}

main().catch((error) => {
  // Never interpolate config values here; this line reaches the deployment logs.
  console.error(`Watcher stopped: ${error.message}`);
  process.exitCode = 1;
});
