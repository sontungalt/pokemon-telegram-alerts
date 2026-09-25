// Singapore never observes DST, so a wall-clock time from the feed can be
// pinned to an exact instant with a fixed offset.
const SINGAPORE_OFFSET = '+08:00';

const SINGAPORE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Public restock channels publish their detection time to the millisecond, which
// is the only externally visible measurement of how fast anyone is actually
// seeing stock flip.
const FOUND_AT = /Found at\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/i;

// The product line is the one carrying the package marker in every message this
// has been seen to produce.
const PRODUCT_LINE = /^\s*(?:\p{Extended_Pictographic}|️|\s)*(.+?)\s*$/u;

const DAY_MS = 86_400_000;

function singaporeDateParts(instant) {
  // en-CA formats as YYYY-MM-DD, which is what the ISO string below needs.
  return SINGAPORE_DATE.format(instant);
}

/**
 * Combines a wall-clock time-of-day from the message body with the calendar day
 * the message was posted on. A detection just before midnight can be published
 * just after it, so a found-at that lands ahead of the post time is rolled back
 * a day rather than reported as a negative delay.
 */
export function resolveFoundAt(timeOfDay, postedAt) {
  if (!timeOfDay || !(postedAt instanceof Date) || Number.isNaN(postedAt.getTime())) return null;

  const { hours, minutes, seconds, milliseconds } = timeOfDay;
  const day = singaporeDateParts(postedAt);
  const stamp = [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');

  const parsed = new Date(
    `${day}T${stamp}.${String(milliseconds).padStart(3, '0')}${SINGAPORE_OFFSET}`,
  );
  if (Number.isNaN(parsed.getTime())) return null;

  // A few seconds of clock skew is normal; a found-at hours ahead is a rollover.
  if (parsed.getTime() - postedAt.getTime() > DAY_MS / 2) {
    return new Date(parsed.getTime() - DAY_MS);
  }
  return parsed;
}

export function parseFoundAtTime(text) {
  const match = FOUND_AT.exec(String(text ?? ''));
  if (!match) return null;

  const [, hours, minutes, seconds, fraction] = match;
  const parsedHours = Number(hours);
  if (parsedHours > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;

  return {
    hours: parsedHours,
    minutes: Number(minutes),
    seconds: Number(seconds),
    // ".1" in a timestamp means 100ms, not 1ms.
    milliseconds: fraction ? Number(fraction.padEnd(3, '0')) : 0,
  };
}

/**
 * Picks the product name out of a restock post. The channel format puts the
 * name on its own line between the found-at line and the link line, so the
 * heuristic is positional rather than pattern-based: the first line that is
 * neither a header, a timestamp, nor a call to action.
 */
export function parseProductName(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (FOUND_AT.test(line)) continue;
    if (/stock found|restock|in stock now/i.test(line)) continue;
    if (/open pdp|=====|click here|buy now/i.test(line)) continue;

    const cleaned = PRODUCT_LINE.exec(line)?.[1];
    // Emoji-only or near-empty lines are separators, not names.
    if (cleaned && cleaned.length > 3) return cleaned;
  }
  return null;
}

/**
 * Normalizes one public restock post into a dataset row.
 *
 * publishDelayMs is the interesting column: the gap between when the channel
 * says it saw stock and when it actually told you. On a free tier that number
 * is the product, and it is why the same post draws a wall of thumbs-down.
 */
export function parseFeedMessage({ id, text, postedAt, links = [] } = {}) {
  const timeOfDay = parseFoundAtTime(text);
  const foundAt = resolveFoundAt(timeOfDay, postedAt);
  const productName = parseProductName(text);

  const pdpUrl = links.find((href) => /lazada\.sg|s\.lazada/i.test(String(href))) ?? null;

  return {
    id: id ?? null,
    productName,
    pdpUrl,
    foundAt: foundAt ? foundAt.toISOString() : null,
    postedAt: postedAt instanceof Date ? postedAt.toISOString() : null,
    publishDelayMs:
      foundAt && postedAt instanceof Date ? postedAt.getTime() - foundAt.getTime() : null,
  };
}

// The preview page timestamps posts to the second while the body reports
// detection to the millisecond. Any gap smaller than this is below the
// resolution of the measurement and says nothing about a real publish delay.
export const TIMESTAMP_RESOLUTION_MS = 1_000;

/**
 * Descriptive stats over collected rows. Restock timing is the question the
 * whole architecture turns on: drops that cluster into known windows are worth
 * watching hard for ten minutes, and drops that are uniformly random are not.
 *
 * Publish delay is reported only over gaps that exceed the source resolution.
 * Dropping the sub-second rows instead of clamping them would bias the median
 * upward, and a channel that restamps its own detection time can report a delay
 * of zero however late it actually published.
 */
export function summarizeFeed(rows) {
  const measurable = rows
    .map((row) => row.publishDelayMs)
    .filter((value) => Number.isFinite(value));

  const delays = measurable
    .filter((value) => value >= TIMESTAMP_RESOLUTION_MS)
    .sort((a, b) => a - b);

  const byHour = new Map();
  for (const row of rows) {
    if (!row.foundAt) continue;
    const hour = new Date(row.foundAt).getUTCHours();
    // Feed timestamps are Singapore local; shift to report in the same clock.
    const singaporeHour = (hour + 8) % 24;
    byHour.set(singaporeHour, (byHour.get(singaporeHour) ?? 0) + 1);
  }

  return {
    rows: rows.length,
    medianPublishDelayMs: delays.length ? delays[Math.floor(delays.length / 2)] : null,
    minPublishDelayMs: delays.length ? delays[0] : null,
    maxPublishDelayMs: delays.length ? delays[delays.length - 1] : null,
    // How many posts carried no measurable gap between detection and publication.
    withinTimestampResolution: measurable.length - delays.length,
    dropsBySingaporeHour: Object.fromEntries([...byHour.entries()].sort((a, b) => a[0] - b[0])),
  };
}
