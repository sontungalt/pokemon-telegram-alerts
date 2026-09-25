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

// Lazada ships a shell and hydrates the price and buy controls a second or two
// later, so reading at domcontentloaded sees an empty page.
const LISTING_CONTENT = [
  '.pdp-price',
  '[class*="pdp-mod-product-price" i]',
  '[class*="pdp-v2-product-price" i]',
  '.pdp-button',
  '[class*="add-to-cart" i]',
].join(', ');

// The containers an interstitial renders in place of the product page. Waiting
// for these alongside the listing markup lets a blocked read resolve as soon as
// the challenge paints, instead of burning the whole navigation timeout waiting
// for product markup that is never going to arrive.
const CHALLENGE_CONTENT =
  '#baxia-dialog-content, .nc_wrapper, #nocaptcha, .J_MIDDLEWARE_FRAME_WIDGET';

// An upper bound on waiting for the buy control, not a fixed cost. The price
// usually lands before the control, so the snapshot is retaken until a control
// appears rather than sleeping for the worst case on every single read.
const CONTROL_SETTLE_MS = 1_500;
const CONTROL_POLL_MS = 100;

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

  // Only the product-detail price block is trusted. The generic [class*=price]
  // also matches "you may also like" carousel cards, which would report some
  // unrelated item's price and fire spurious price-change alerts.
  const priceText = textFromFirstMatch([
    '.pdp-price',
    '[class*="pdp-mod-product-price" i]',
    '[class*="pdp-v2-product-price" i]',
  ]);

  return {
    title: document.title,
    seller: textFromFirstMatch(['.seller-name', '[class*="seller" i] a', '[class*="seller" i]']),
    priceText,
    control,
    challenged,
  };
}

/**
 * The share bridge runs a script that navigates itself to the destination. If
 * that fires while we are issuing our own goto, Chromium aborts one of them and
 * reports ERR_ABORTED. The page is fine a moment later, so a single retry turns
 * a spurious failure into a normal read.
 */
async function gotoSettled(page, url, options) {
  try {
    return await page.goto(url, options);
  } catch (error) {
    if (!/ERR_ABORTED/.test(error.message ?? '')) throw error;
    return page.goto(url, options);
  }
}

export async function observeListing(page, product, { timeoutMs, logger = console }) {
  let targetUrl = product.url;

  if (isShareUrl(product.url)) {
    targetUrl = await resolveShareLink(page, product, { timeoutMs, logger }) ?? product.url;
  }

  await gotoSettled(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  let snapshot;

  // Give the listing a chance to render; a page that never does is caught below.
  if (typeof page.waitForSelector === 'function') {
    // Whichever paints first settles it: the listing, or the interstitial.
    await page
      .waitForSelector(`${LISTING_CONTENT}, ${CHALLENGE_CONTENT}`, { timeout: timeoutMs })
      .catch(() => {});

    // Re-read until the purchase control appears. A page that is challenged, or
    // that genuinely has no control, still costs the full budget — but a listing
    // that does have one is reported the moment it renders, which is the case
    // where latency actually matters.
    const deadline = Date.now() + CONTROL_SETTLE_MS;
    for (;;) {
      snapshot = await page.evaluate(collectListingSnapshot);
      if (snapshot.challenged || snapshot.control || Date.now() >= deadline) break;
      await page.waitForTimeout?.(CONTROL_POLL_MS);
    }
  } else {
    snapshot = await page.evaluate(collectListingSnapshot);
  }

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
