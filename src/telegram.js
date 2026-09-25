const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

// Singapore time is what the user acts on, regardless of where the worker runs.
// Parts are assembled by hand so the wording cannot drift with the host's ICU build.
const MONTHS = Object.freeze(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
);

const SINGAPORE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Singapore',
  day: '2-digit',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function displayPrice(priceCents) {
  if (!Number.isInteger(priceCents)) return 'Price not detected';
  return `S$${(priceCents / 100).toFixed(2)}`;
}

export function singaporeTimestamp(date) {
  const parts = Object.fromEntries(
    SINGAPORE_PARTS.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const month = MONTHS[Number(parts.month) - 1];
  // Milliseconds are identical in every zone, so they come straight off the
  // Date rather than through the formatter.
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');

  return (
    `${parts.day} ${month} ${parts.year}, ` +
    `${parts.hour}:${parts.minute}:${parts.second}.${milliseconds} SGT`
  );
}

export function formatAvailabilityMessage(observation, reason, detectedAt = new Date()) {
  const lines = [
    '<b>Pokémon restock detected</b>',
    '',
    escapeHtml(observation.productName),
  ];

  if (observation.title && observation.title !== observation.productName) {
    lines.push(`Listing: ${escapeHtml(observation.title)}`);
  }

  lines.push(`Price: <b>${escapeHtml(displayPrice(observation.priceCents))}</b>`);

  if (observation.seller) lines.push(`Seller: ${escapeHtml(observation.seller)}`);
  if (reason === 'price-changed') lines.push('The price changed since the last alert.');

  lines.push(
    `Detected: ${escapeHtml(singaporeTimestamp(detectedAt))}`,
    '',
    `<a href="${escapeHtml(observation.observedUrl)}">Open Lazada listing</a>`,
  );

  return lines.join('\n');
}

export async function sendTelegramMessage({ token, chatId, text, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    // Never interpolate the token or chat ID here; this message reaches the logs.
    const detail = typeof body?.description === 'string' ? `: ${body.description}` : '';
    throw new Error(`Telegram rejected the message (HTTP ${response.status ?? 'unknown'})${detail}`);
  }
}
