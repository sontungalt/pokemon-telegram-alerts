export const PRODUCTS = Object.freeze([
  {
    name: 'Ascended Heroes Pokémon Center ETB',
    url: 'https://s.lazada.sg/s.31pGa',
  },
  {
    name: 'Ascended Heroes Mini Tin (5 designs)',
    url: 'https://s.lazada.sg/s.31puN',
  },
  {
    name: 'Destined Rivals ETB',
    url: 'https://s.lazada.sg/s.TVggS?c=s',
  },
  {
    name: 'Mega Ascended Heroes EX Box — Emboar',
    url: 'https://s.lazada.sg/s.483S8',
  },
  {
    name: 'Mega Ascended Heroes EX Box — Meganium',
    url: 'https://s.lazada.sg/s.483SZ',
  },
  {
    name: 'Mega Ascended Heroes EX Box — Feraligatr',
    url: 'https://s.lazada.sg/s.483hq',
  },
  {
    name: 'Ascended Heroes Booster Bundle',
    url: 'https://s.lazada.sg/s.483hh',
  },
  {
    name: 'Ascended Heroes Poster Collection — Lucario',
    url: 'https://s.lazada.sg/s.36m58',
  },
  {
    name: 'Ascended Heroes Poster Collection — Gardevoir',
    url: 'https://s.lazada.sg/s.36mYY',
  },
  {
    name: 'Ascended Heroes Pin Collection',
    url: 'https://s.lazada.sg/s.f5Z2U?c=b',
  },
]);

function requiredString(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(env, name, { fallback, minimum, unit }) {
  const raw = env[name]?.trim?.() ?? env[name];
  const value = Number(raw === undefined || raw === '' ? fallback : raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum} ${unit}.`);
  }
  return value;
}

function validateProductUrls(products) {
  for (const product of products) {
    const url = new URL(product.url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('lazada.sg')) {
      throw new Error(`Product URL for ${product.name} must be an HTTPS Lazada Singapore link.`);
    }
  }
}

export function loadConfig(env = process.env) {
  validateProductUrls(PRODUCTS);

  // Polling below 30s is refused outright so the watcher stays a polite observer.
  const pollIntervalSeconds = boundedInteger(env, 'POLL_INTERVAL_SECONDS', {
    fallback: 30,
    minimum: 30,
    unit: 'seconds',
  });
  const jitterSeconds = boundedInteger(env, 'POLL_JITTER_SECONDS', {
    fallback: 0,
    minimum: 0,
    unit: 'seconds',
  });
  const navigationTimeoutMs = boundedInteger(env, 'NAVIGATION_TIMEOUT_MS', {
    fallback: 25_000,
    minimum: 5_000,
    unit: 'milliseconds',
  });

  return Object.freeze({
    telegramBotToken: requiredString(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: requiredString(env, 'TELEGRAM_CHAT_ID'),
    pollIntervalMs: pollIntervalSeconds * 1_000,
    jitterMs: jitterSeconds * 1_000,
    navigationTimeoutMs,
    products: PRODUCTS,
  });
}
