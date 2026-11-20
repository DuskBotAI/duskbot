const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];
const ORDINAL_WORDS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};
const CURRENCY: Record<string, [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"],
};

function underThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]!);
  else if (n > 0) parts.push(ONES[n]!);
  return parts.join(" ");
}

export function cardinal(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 0) return `minus ${cardinal(-n)}`;
  n = Math.floor(n);
  if (n < 20) return ONES[n]!;
  const groups: string[] = [];
  for (let scale = 0; n > 0 && scale < SCALES.length; scale += 1) {
    const chunk = n % 1000;
    if (chunk) groups.unshift(SCALES[scale] ? `${underThousand(chunk)} ${SCALES[scale]}` : underThousand(chunk));
    n = Math.floor(n / 1000);
  }
  return groups.join(" ");
}

export function ordinal(n: number): string {
  const words = cardinal(n);
  const cut = Math.max(words.lastIndexOf(" "), words.lastIndexOf("-"));
  const head = words.slice(0, cut + 1);
  const last = words.slice(cut + 1);
  if (ORDINAL_WORDS[last]) return head + ORDINAL_WORDS[last];
  if (last.endsWith("y")) return `${head}${last.slice(0, -1)}ieth`;
  return `${head}${last}th`;
}

function year(n: number): string {
  if (n >= 2000 && n < 2010) return cardinal(n);
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return `${cardinal(high)} hundred`;
  return `${cardinal(high)} ${low < 10 ? `oh ${ONES[low]}` : cardinal(low)}`;
}

function digits(text: string): string {
  return [...text].map((d) => ONES[Number(d)]).join(" ");
}

function money(symbol: string, amount: string): string {
  const [unit, units, sub, subs] = CURRENCY[symbol]!;
  const [whole = "0", fraction = ""] = amount.replace(/,/g, "").split(".");
  const major = Number(whole);
  const minor = fraction ? Number(fraction.padEnd(2, "0").slice(0, 2)) : 0;
  const parts: string[] = [];
  if (major || !minor) parts.push(`${cardinal(major)} ${major === 1 ? unit : units}`);
  if (minor) parts.push(`${cardinal(minor)} ${minor === 1 ? sub : subs}`);
  return parts.join(" and ");
}

function plainNumber(raw: string): string {
  const clean = raw.replace(/,/g, "");
  if (clean.includes(".")) {
    const [whole = "0", fraction = ""] = clean.split(".");
    return `${cardinal(Number(whole || "0"))} point ${digits(fraction)}`;
  }
  if (/^0\d+/.test(clean)) return digits(clean);
  const n = Number(clean);
  if (!raw.includes(",") && clean.length === 4 && n >= 1100 && n < 2100) return year(n);
  return cardinal(n);
}

/** Numbers, money, times and a few symbols written out as words, so the pronunciation lexicon can read them. */
export function wordsForNumbers(text: string): string {
  return text
    .replace(/([$£€])\s?(\d[\d,]*(?:\.\d+)?)/g, (_, symbol: string, amount: string) => money(symbol, amount))
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h: string, m: string) => {
      const minutes = Number(m);
      if (minutes === 0) return `${cardinal(Number(h))} o'clock`;
      return `${cardinal(Number(h))} ${minutes < 10 ? `oh ${ONES[minutes]}` : cardinal(minutes)}`;
    })
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => ordinal(Number(n)))
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n: string) => `${plainNumber(n)} percent`)
    .replace(/\d[\d,]*(?:\.\d+)?/g, (n) => plainNumber(n.replace(/,(?!\d{3})/g, " ")))
    .replace(/\s&\s/g, " and ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/(\S)@(\S)/g, "$1 at $2");
}
