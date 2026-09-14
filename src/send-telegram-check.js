import { loadConfig } from './config.js';
import { sendTelegramMessage } from './telegram.js';

export function connectionTestMessage() {
  return '<b>Pokémon alert bot connected</b>\nTelegram notifications are ready.';
}

async function main() {
  await import('dotenv/config');
  const config = loadConfig();
  await sendTelegramMessage({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    text: connectionTestMessage(),
  });
  console.log('Telegram test message sent.');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
