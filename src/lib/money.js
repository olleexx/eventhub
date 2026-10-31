// Money helpers. All arithmetic is done in integer minor units (kobo for NGN) to avoid float error.
// Database columns are Decimal(14,2); convert at the boundary only.

export function toMinor(value) {
  if (value === null || value === undefined || value === '') return 0;
  const s = typeof value === 'string' ? value.trim() : value.toString();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Invalid money value: ${s}`);
  const [, sign, whole, frac = ''] = m;
  const frac2 = (frac + '00').slice(0, 2);
  // Round half up on the third decimal if present.
  let minor = Number(whole) * 100 + Number(frac2);
  if (frac.length > 2 && Number(frac[2]) >= 5) minor += 1;
  return sign === '-' ? -minor : minor;
}

export function fromMinor(minor) {
  if (!Number.isInteger(minor)) throw new Error('fromMinor expects an integer');
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Integer division rounding half up for non-negative numerator/denominator.
export function divRound(numerator, denominator) {
  if (denominator === 0) throw new Error('Division by zero');
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export function formatMoney(value, currency = 'NGN') {
  const minor = toMinor(value);
  const major = fromMinor(Math.abs(minor));
  const [w, f] = major.split('.');
  const withCommas = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${minor < 0 ? '-' : ''}${symbol}${withCommas}.${f}`;
}
