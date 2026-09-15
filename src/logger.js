const SINGAPORE_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Singapore',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Wraps a console-like sink so every line carries a Singapore-time stamp and
 * occupies exactly one line, keeping multi-line driver errors out of the log.
 */
export function createTimestampedLogger(sink = console, now = () => new Date()) {
  const write = (method) => (message) => {
    const firstLine = String(message ?? '').split('\n')[0].trim();
    sink[method](`[${SINGAPORE_CLOCK.format(now())}] ${firstLine}`);
  };

  return { info: write('info'), warn: write('warn'), error: write('error') };
}
