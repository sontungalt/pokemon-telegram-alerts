const PURCHASE_CONTROL = /\b(add to (cart|bag)|buy now|pre[- ]?order)\b/i;
const UNAVAILABLE_CONTROL = /\b(out of stock|sold out|notify me|coming soon|unavailable)\b/i;

export function parsePriceCents(priceText) {
  if (!priceText) return null;
  const match = String(priceText).match(/(?:S\$|SGD)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;

  const dollars = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

function purchaseControlIsReady(control) {
  if (!control?.visible || !control.enabled) return false;
  const text = control.text?.trim() ?? '';
  return PURCHASE_CONTROL.test(text) && !UNAVAILABLE_CONTROL.test(text);
}

export function normalizeObservation(product, observedUrl, snapshot) {
  const listing = snapshot ?? {};
  const available = purchaseControlIsReady(listing.control);

  return {
    productName: product.name,
    productUrl: product.url,
    observedUrl,
    title: listing.title?.trim() || product.name,
    seller: listing.seller?.trim() || null,
    priceCents: parsePriceCents(listing.priceText),
    available,
    reason: available ? 'purchase-control-ready' : 'purchase-control-unavailable',
  };
}
