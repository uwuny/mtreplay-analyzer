export function round2(x) {
  return roundTo(x, 2);
}

// Округление как в Python: по точной десятичной записи числа, половина — к чётному.
// Разбор записи медленный, а у подавляющего большинства чисел следующий разряд
// далеко от границы — там хватает умножения, и результат тот же. Точный путь
// остаётся для чисел у границы: целое значение или ровно половина.
const FAST_LIMIT = 1e9;
const FAST_GUARD = 1e-6;

export function roundTo(x, digits) {
  if (!Number.isFinite(x)) return x;

  if (Math.abs(x) >= 1e15) return x;

  const scale = 10 ** digits;
  const scaledAbs = Math.abs(x) * scale;
  if (scaledAbs < FAST_LIMIT) {
    const whole = Math.floor(scaledAbs);
    const fraction = scaledAbs - whole;
    if (fraction > FAST_GUARD && fraction < 1 - FAST_GUARD && Math.abs(fraction - 0.5) > FAST_GUARD) {
      const result = (fraction > 0.5 ? whole + 1 : whole) / scale;
      return x < 0 ? -result : result;
    }
  }
  return roundExact(x, digits);
}

function roundExact(x, digits) {
  const negative = x < 0;
  const text = Math.abs(x).toFixed(20);
  const dot = text.indexOf('.');
  const intPart = text.slice(0, dot);
  const frac = text.slice(dot + 1);

  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);

  let scaled = Number(intPart + kept);

  const first = rest.charCodeAt(0) - 48;
  let roundUp;
  if (first > 5) {
    roundUp = true;
  } else if (first < 5) {
    roundUp = false;
  } else if (/[1-9]/.test(rest.slice(1))) {
    roundUp = true;
  } else {
    roundUp = scaled % 2 === 1;
  }
  if (roundUp) scaled += 1;

  const result = scaled / 10 ** digits;
  return negative ? -result : result;
}
