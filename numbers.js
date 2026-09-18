// Norwegian number words, for the tall-og-klokka drill.
//
// Pure functions, no DOM. The conventions are the modern ones taught on
// Norskprøven: "tjueen" (not "en og tyve"), "hundre" without "ett", "og"
// only before the last unit group ("to hundre og fem", "tusen og ti").

const ONES = ['null', 'en', 'to', 'tre', 'fire', 'fem', 'seks', 'sju', 'åtte', 'ni', 'ti', 'elleve', 'tolv', 'tretten', 'fjorten', 'femten', 'seksten', 'sytten', 'atten', 'nitten'];
const TENS = ['', '', 'tjue', 'tretti', 'førti', 'femti', 'seksti', 'sytti', 'åtti', 'nitti'];
const ORDINALS = ['', 'første', 'andre', 'tredje', 'fjerde', 'femte', 'sjette', 'sjuende', 'åttende', 'niende', 'tiende', 'ellevte', 'tolvte', 'trettende', 'fjortende', 'femtende', 'sekstende', 'syttende', 'attende', 'nittende', 'tjuende'];
export const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

function below100(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ONES[o] : '');
}

function below1000(n) {
  if (n < 100) return below100(n);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = (h === 1 ? '' : ONES[h] + ' ') + 'hundre';
  return rest ? `${head} og ${below100(rest)}` : head;
}

/** 0–999 999 in words. */
export function toWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 1000) return below1000(n);
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = (th === 1 ? '' : below1000(th) + ' ') + 'tusen';
  if (!rest) return head;
  // "og" joins directly when what follows has no hundreds of its own.
  return rest < 100 ? `${head} og ${below100(rest)}` : `${head} ${below1000(rest)}`;
}

/** Ordinal 1–31, as in dates. */
export function ordinal(n) {
  if (n <= 20) return ORDINALS[n];
  const o = n % 10;
  const t = Math.floor(n / 10);
  return o === 0 ? TENS[t].replace(/i$/, 'iende') : TENS[t] + ORDINALS[o];
}

/** "12. mars" -> "tolvte mars". */
export function dateWords(day, monthIndex) {
  return `${ordinal(day)} ${MONTHS[monthIndex]}`;
}

/** Spoken years: 1998 -> "nitten nittiåtte", 2024 -> "to tusen og tjuefire". */
export function yearWords(y) {
  if (y >= 1100 && y < 2000) {
    const c = Math.floor(y / 100);
    const rest = y % 100;
    return rest ? `${below100(c)} ${below100(rest)}` : `${below100(c)} hundre`;
  }
  return toWords(y);
}

/** "259 kr" -> "to hundre og femtini kroner". */
export function priceWords(kr) {
  return `${toWords(kr)} ${kr === 1 ? 'krone' : 'kroner'}`;
}

/**
 * Clock time the Norwegian way: the half hour points forward ("halv tre" is
 * 2:30), and minutes near the half hour count to or from it ("fem på halv
 * tre" = 2:25). Twelve-hour, as people say it; "klokka" is left to the drill.
 */
export function clockWords(h, m) {
  // Hours are neuter: "klokka ett", never "klokka en".
  const hour12 = (x) => {
    const h12 = ((x % 12) + 12) % 12 || 12;
    return h12 === 1 ? 'ett' : ONES[h12];
  };
  const next = hour12(h + 1);
  const cur = hour12(h);
  if (m === 0) return cur;
  if (m === 15) return `kvart over ${cur}`;
  if (m === 30) return `halv ${next}`;
  if (m === 45) return `kvart på ${next}`;
  if (m < 20) return `${ONES[m]} over ${cur}`;
  if (m < 30) return `${ONES[30 - m]} på halv ${next}`;
  if (m < 40) return `${ONES[m - 30]} over halv ${next}`;
  return `${ONES[60 - m]} på ${next}`;
}
