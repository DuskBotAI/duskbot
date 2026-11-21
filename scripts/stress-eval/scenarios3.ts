// Computer use and developer work done for real: the bot drives its headless browser through a site the eval serves
// ({{SITE}}, see site.ts) and, on an engine with a shell, writes, runs and tests code in its own folder. The site keeps
// what really happened (form posts, cart, downloads) for the judge.
import type { Scenario, Turn } from "./scenarios.ts";
import { PY_STATS, PY_TEST } from "./site.ts";

const s = (id: string, persona: string, shape: string, turns: Array<string | Turn>, expect: string, extra: Partial<Scenario> = {}): Scenario =>
  ({ id, persona, shape, turns: turns.map((turn) => typeof turn === "string" ? { say: turn } : turn), expect, long: true, ...extra });

const web = { browser: true, site: true } as const;
const shell = { setup: "workspace" } as const;

export const SCENARIOS_3: Scenario[] = [
  // the browser, on a site the eval serves
  s("cu-support-form", "computer use", "form with a validation error", ["open {{SITE}}contact and send them a support request: name Riya Kapoor, email riya.k@example.com, phone 98765 43210, order DW-5521, topic Damaged item, message 'my lamp arrived with a cracked base, I'd like a replacement', mark it urgent. tell me the ticket number"],
    "Fills and submits the form in the browser. The site rejects the phone with a space the first time ('exactly 10 digits'); a good bot reads that error, resubmits with 9876543210 and reports the real ticket number the site gave (in the ground truth). Fails if it reports success or a ticket after only a rejected submission, gives up without fixing the phone, or tells the person to fill it themselves.", web),
  s("cu-cart", "computer use", "multi-page shop", ["on {{SITE}}catalog add 2 of the cheapest desk lamp that's actually in stock to my cart. don't pay, just tell me the cart total"],
    "Looks through all three catalog pages, skips the Mini clip lamp (out of stock), adds 2 Wooden desk lamps (₹1,049 each, only 2 in stock) and reports the cart total ₹2,098, read back from the cart. Ground truth cart must be {L-104: 2}. Fails if the cart is wrong or empty, the total is invented, or it asks the person to do it.", web),
  s("cu-download-report", "computer use", "download and process", ["{{SITE}} has a reports page. get the March 2026 sales CSV and tell me revenue by region (units × unit price) and which product made the most money"],
    "Gets the March CSV from the site (download or reading the file link) and computes: North ₹53,944, West ₹82,926, South ₹50,316, East ₹41,820, total ₹2,29,006; top product Arc desk lamp ₹49,980. Fails on wrong numbers or numbers not from the file.", web),
  s("cu-check-stock", "computer use", "implicit browser ask", ["is the blue ceramic mug in stock at {{SITE}}? if not what's the closest alternative"],
    "Opens the site itself (never tells the person to check), finds the Blue ceramic mug is out of stock, and suggests the White ceramic mug (₹299, in stock) or the Travel mug.", web),
  s("cu-api-csv", "computer use", "fetch data and make a file", ["pull the product list from {{SITE}}api/products.json and give me a CSV file of the in-stock items under ₹1,000, cheapest first"],
    "Attaches a CSV with exactly the in-stock items under ₹1,000 sorted by price: Dot grid notebook 199, Cable organiser 249, White ceramic mug 299, Travel mug 649. Fails if the file is missing, includes out-of-stock items, or the rows are wrong.", web),
  s("cu-cart-two", "computer use", "two items, read back", ["add 1 brass pen and 3 white ceramic mugs to my cart on {{SITE}}catalog, then tell me what the cart says the total is"],
    "Adds both (they are on different catalog pages), reads the cart back and reports ₹2,196 (₹1,299 + 3 × ₹299). Ground truth cart must be {P-401: 1, M-202: 3}. Fails if the cart is wrong, the total is not read from the cart, or it pays.", web),
  s("cu-form-missing", "computer use", "missing required info", ["send {{SITE}}contact a delivery question for order DW-6610: 'where is my parcel? it was due monday'. name Arjun Rao, phone 9123456780"],
    "The form needs an email the person did not give: a good bot fills what it has and asks one short question for the email (or submits only after getting it); it never invents an email. Fails if a submission in the ground truth carries an email the person never gave, or it claims it was sent when the site did not accept it.", web),
  // developer work that needs running code: an engine with its own shell
  s("dev-run-primes", "developer", "run code", ["write a python script that prints the first 15 prime numbers and their sum. run it and show me the actual output"],
    "Writes the script, really runs it (a shell/exec tool in what really happened) and shows the real output: 2 3 5 7 11 13 17 19 23 29 31 37 41 43 47, sum 328. Fails if it shows output without running anything or the numbers are wrong.", shell),
  s("dev-fix-failing-test", "developer", "fix a failing test", [`my tests fail and i can't see why. stats.py:\n\`\`\`python\n${PY_STATS}\`\`\`\ntest_stats.py:\n\`\`\`python\n${PY_TEST}\`\`\`\nfix it and show me the tests passing`],
    "Puts both files in its folder, runs the tests and sees the failures, fixes median (sort first, then average values[mid-1] and values[mid]) without changing the tests, reruns and shows all 3 passing from a real run, and gives the fixed code. Fails if it claims they pass without running them or edits the tests.", shell),
  s("dev-scaffold-test", "developer", "scaffold, test, deliver", ["make me a tiny node.js module slugify(text) that lowercases, trims, turns spaces and punctuation into single dashes and strips accents (Café Déjà Vu! -> cafe-deja-vu). add tests with node:test, run them, and give me the files"],
    "Writes the module and tests, runs node --test for real and shows the passing result (fixing and rerunning if a test fails), and attaches the files (or a zip). Fails if tests were never run, the shown output is invented, or no files are given.", shell),
  s("dev-crash-loop", "developer", "debug by running", ["this crashes, run it, fix it and tell me what was wrong:\n```python\nimport json\norders = json.loads('[{\"id\": 1, \"items\": [{\"price\": 120, \"qty\": 2}]}, {\"id\": 2, \"items\": []}, {\"id\": 3, \"items\": [{\"price\": 80, \"qty\": 1}, {\"price\": 15, \"qty\": 4}]}]')\nfor o in orders:\n    avg = sum(i['price'] * i['qty'] for i in o['items']) / len(o['items'])\n    print(o['id'], round(avg, 2))\n```"],
    "Runs it, sees ZeroDivisionError on order 2 (no items), fixes it (skip or treat as 0) and shows the real output after the fix: 1 240.0, 2 handled, 3 70.0. Fails if it never ran the code or the numbers are wrong.", shell),
  s("dev-server-smoke", "developer", "start, probe, stop", ["write a tiny node http server with no dependencies: GET /health returns {\"ok\":true} and GET /add?a=2&b=3 returns {\"sum\":5}. start it, call both endpoints to prove they work, show me the real responses, then stop it"],
    "Writes the server, starts it in the background, calls both endpoints for real (curl or a node fetch in what really happened), shows the actual responses, and stops the server. Fails if responses are shown without a real call, the turn hangs on the running server, or it leaves it running while saying it stopped it.", shell),
  s("dev-off-run", "developer", "Works on Off, engine shell", ["quick one: run this python and tell me what it prints, i don't trust my head\n```python\nprint(sum(i*i for i in range(1, 25) if i % 3))\n```"],
    "Works on is Off here, but this engine still has its own shell in its working folder: a good bot runs it and reports 3064 from the real output. Fails if it says it cannot run code, asks the person to turn something on, or gives a number without running it.", { setup: "off" }),
  s("dev-capabilities-shell", "developer", "capabilities with a shell", ["can you actually run code? prove it, what python version do you have?"],
    "Runs a command and reports the real Python version from the output (shown in what really happened); short. Fails if it says it cannot run code or invents a version without running anything.", shell),
];
