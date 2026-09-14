import { normalizeObservation } from './availability.js';

// Resolved share links are stable for the lifetime of the process.
const shareDestinationCache = new Map();

export function resetShareLinkCache() {
  shareDestinationCache.clear();
}

/** Reduces a Lazada URL to a clean product URL, dropping tracking parameters. */
function canonicalLazadaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const isLazada = url.hostname === 'lazada.sg' || url.hostname.endsWith('.lazada.sg');
    // s.lazada.sg is another share bridge, not a destination.
    if (!isLazada || url.hostname === 's.lazada.sg') return null;

    return `https://${url.hostname}${url.pathname}`;
  } catch {
    return null;
  }
}

// Alibaba serves its anti-bot interstitial from these paths instead of the listing.
const CHALLENGE_URL_MARKERS = ['_____tmd_____', 'x5secdata', '/punish'];

function isChallengeUrl(value) {
  return CHALLENGE_URL_MARKERS.some((marker) => String(value ?? '').includes(marker));
}

function isShareUrl(value) {
  try {
    return new URL(value).hostname === 's.lazada.sg';
  } catch {
    return false;
  }
}

/**
 * s.lazada.sg pages are JavaScript share bridges rather than HTTP redirects, so
 * we commit the navigation only far enough to read their <link rel="origin">.
 */
async function resolveShareLink(page, product, { timeoutMs, logger }) {
  const cached = shareDestinationCache.get(product.url);
  if (cached) return cached;

  await page.goto(product.url, { waitUntil: 'commit', timeout: timeoutMs });

  const originHref = await page.evaluate(
    () => document.querySelector('link[rel="origin"]')?.href ?? null,
  );
  const resolved = canonicalLazadaUrl(originHref) ?? canonicalLazadaUrl(page.url());

  if (!resolved) {
    logger.warn(
      `Could not resolve the Lazada share link for ${product.name}; using the original URL instead.`,
    );
    return null;
  }

  shareDestinationCache.set(product.url, resolved);
  return resolved;
}

/**
 * Runs entirely inside the browser: every helper it needs is declared here, so
 * nothing from the Node side is referenced during evaluation.
 */
function collectListingSnapshot() {
  const PURCHASE = /\b(add to (cart|bag)|buy now|pre[- ]?order)\b/i;
  const BLOCKED = /\b(out of stock|sold out|notify me|coming soon|unavailable)\b/i;
  // Real controls carry short labels; anything longer is prose or a wrapper.
  const MAX_LABEL_LENGTH = 40;

  function textFromFirstMatch(selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }
    return null;
  }

  function describe(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const className = typeof element.className === 'string' ? element.className : '';

    return {
      text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      visible: style.visibility !== 'hidden'
        && style.display !== 'none'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0,
      enabled: element.disabled !== true
        && element.getAttribute('aria-disabled') !== 'true'
        && !/\bdisabled\b/i.test(className),
    };
  }

  // Anti-bot interstitials render these containers in place of the product page.
  const challenged = Boolean(
    document.querySelector('#baxia-dialog-content, .nc_wrapper, #nocaptcha, .J_MIDDLEWARE_FRAME_WIDGET'),
  );

  const candidates = [...document.querySelectorAll(
    'button, a, [role="button"], .pdp-button, [class*="add-to-cart" i]',
  )]
    .map(describe)
    .filter((candidate) => candidate.text
      && candidate.text.length <= MAX_LABEL_LENGTH
      && PURCHASE.test(candidate.text)
      && !BLOCKED.test(candidate.text));

  // A page may render several matching controls; one that is actually usable wins.
  const control = candidates.find((candidate) => candidate.visible && candidate.enabled)
    ?? candidates[0]
    ?? null;

  const priceText = textFromFirstMatch(['.pdp-price', '[class*="price" i]'])
    || document.body?.innerText?.match(/(?:S\$|SGD)\s*[\d,]+(?:\.\d{1,2})?/i)?.[0]
    || null;

  return {
    title: document.title,
    seller: textFromFirstMatch(['.seller-name', '[class*="seller" i] a', '[class*="seller" i]']),
    priceText,
    control,
    challenged,
  };
}

export async function observeListing(page, product, { timeoutMs, logger = console }) {
  let targetUrl = product.url;

  if (isShareUrl(product.url)) {
    targetUrl = await resolveShareLink(page, product, { timeoutMs, logger }) ?? product.url;
  }

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const snapshot = await page.evaluate(collectListingSnapshot);
  const finalUrl = page.url();

  // A blocked read must never be reported as "out of stock": that would silence
  // the alert for a listing we simply could not see. Raise it as a failure.
  if (snapshot.challenged || isChallengeUrl(finalUrl)) {
    throw Object.assign(
      new Error(
        `Lazada served an anti-bot challenge page instead of the listing for ${product.name}; it was not checked.`,
      ),
      { code: 'ANTI_BOT_CHALLENGE' },
    );
  }

  // A share bridge always has a title but never a purchase control, so it would
  // otherwise be scored as a readable, out-of-stock listing. It is not a listing.
  if (isShareUrl(finalUrl)) {
    throw Object.assign(
      new Error(
        `Could not resolve the share link for ${product.name} to a Lazada product page; it was not checked.`,
      ),
      { code: 'UNRESOLVED_SHARE_LINK' },
    );
  }

  if (!snapshot.title?.trim() && !snapshot.priceText && !snapshot.control) {
    throw new Error(
      `Could not read the listing content for ${product.name} (no title, price or purchase control found).`,
    );
  }

  return normalizeObservation(product, finalUrl, snapshot);
}
