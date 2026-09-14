export function chatIdsFromUpdates(payload) {
  const ids = new Set();
  for (const update of payload?.result ?? []) {
    const chatId = update.message?.chat?.id ?? update.channel_post?.chat?.id;
    if (chatId != null) ids.add(String(chatId));
  }
  return [...ids];
}

export async function getChatIds(token, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram getUpdates failed (HTTP ${response.status ?? 'unknown'}).`);
  }
  return chatIdsFromUpdates(payload);
}

async function main() {
  await import('dotenv/config');
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required. Add it to .env first.');

  const ids = await getChatIds(token);
  if (ids.length === 0) {
    console.log('No messages found. Send /start to your bot, then run this command again.');
    return;
  }
  console.log(`Telegram chat ID(s): ${ids.join(', ')}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
