import { chromium } from 'playwright';

import { loadConfig } from './config.js';
import { observeListing } from './lazada-observer.js';
import { formatAvailabilityMessage, sendTelegramMessage } from './telegram.js';
import { createInterruptibleSleep, runWatcher } from './watcher.js';

// Skipped resources never affect availability detection and make each check faster.
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);

async function main() {
  await import('dotenv/config');
  const config = loadConfig();
  const waiter = createInterruptibleSleep();

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; finishing the current check, then shutting down.`);
    waiter.interrupt();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  console.log(
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
      observe: (product) => observeListing(page, product, {
        timeoutMs: config.navigationTimeoutMs,
        logger: console,
      }),
      notify: async (observation, reason) => {
        await sendTelegramMessage({
          token: config.telegramBotToken,
          chatId: config.telegramChatId,
          text: formatAvailabilityMessage(observation, reason, new Date()),
        });
        console.log(`Sent ${reason} alert for ${observation.productName}.`);
      },
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log('Browser closed. Watcher stopped.');
  }
}

main().catch((error) => {
  // Never interpolate config values here; this line reaches the deployment logs.
  console.error(`Watcher stopped: ${error.message}`);
  process.exitCode = 1;
});
