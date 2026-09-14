import { chromium } from 'playwright';
import { PRODUCTS } from './src/config.js';
import { observeListing, resetShareLinkCache } from './src/lazada-observer.js';

const ATTEMPTS = 12;
const GAP_MS = 150_000;
let ok = 0, blocked = 0, other = 0;

const browser = await chromium.launch({ headless: true });
for (let i = 0; i < ATTEMPTS; i++) {
  const product = PRODUCTS[i % PRODUCTS.length];
  // Fresh context每 attempt: clean cookies, clean storage.
  const ctx = await browser.newContext({ locale: 'en-SG', timezoneId: 'Asia/Singapore' });
  const page = await ctx.newPage();
  const at = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore' });
  try {
    resetShareLinkCache();
    const o = await observeListing(page, product, { timeoutMs: 25000, logger: { warn() {} } });
    ok++;
    console.log(`${at}  OK       ${product.name.slice(0,34).padEnd(34)} available=${o.available} price=${o.priceCents}`);
  } catch (e) {
    const isBlock = /anti-bot/.test(e.message);
    isBlock ? blocked++ : other++;
    console.log(`${at}  ${isBlock ? 'BLOCKED ' : 'ERROR   '} ${product.name.slice(0,34).padEnd(34)} ${isBlock ? '' : e.message.slice(0,60)}`);
  } finally { await ctx.close(); }
  if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, GAP_MS));
}
await browser.close();
console.log(`\nRESULT over ${ATTEMPTS} spaced attempts: ${ok} readable, ${blocked} blocked, ${other} other errors`);
