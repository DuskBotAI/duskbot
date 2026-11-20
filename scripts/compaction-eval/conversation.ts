// A synthetic 43-turn chat: facts the person states early, a six-step task worked across both folds, side questions
// between, and tool results that only the folded part saw.

export interface Turn {
  user: string;
  assistant: string;
  tools?: Array<{ name: string; input: string; result: string }>;
}

const filler: Array<[string, string]> = [
  ["Unrelated: give me a regex for UK postcodes.", "A practical one: ^[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}$ (case-insensitive). It accepts the common forms like SW1A 1AA and M1 1AE, but it does not check that a postcode actually exists."],
  ["What's a good lunch spot near Rotterdam Centraal?", "Close to the station, Fenix Food Factory and the Markthal both work for a quick lunch; the Markthal has the most choice if people in the group want different things."],
  ["Translate 'the truck is delayed by two hours' into Dutch.", "\"De vrachtwagen heeft twee uur vertraging.\""],
  ["How do I freeze the top row in Google Sheets?", "View > Freeze > 1 row. On the phone app, tap the row number and pick Freeze."],
  ["Explain what a cross-dock is in one paragraph.", "A cross-dock is a facility where inbound goods are unloaded and moved almost straight onto outbound trucks with little or no storage in between. It cuts warehousing time and cost, and it works best when inbound and outbound schedules are tightly coordinated."],
  ["Any tips for a 10 minute standup?", "Keep it to three things per person: yesterday, today, blockers. Park long discussions for after, use a visible timer, and rotate who runs it."],
  ["What's the difference between FTL and LTL?", "FTL (full truckload) books a whole truck for one shipper; LTL (less than truckload) shares a truck between several shippers' freight. FTL is faster and handles fragile loads better; LTL is cheaper for small shipments."],
  ["Suggest a name for our team's Slack channel about the migration.", "#routing-cutover is clear and searchable. If you want something lighter: #new-roads."],
  ["How many hours is it from Rotterdam to Warsaw by truck?", "About 13 to 14 hours of driving for roughly 1,150 km, so with EU driving-time rules it is in practice a two-day trip for a single driver."],
  ["Write a one-line thank-you to the night shift.", "Thank you, night shift: everything was loaded and out on time last night, and it did not go unnoticed."],
  ["What's a polite way to decline a meeting?", "\"Thanks for the invite. I can't make this one, but I'm happy to read the notes and follow up on anything that needs me.\""],
  ["Remind me how to compute a percentage change.", "(new - old) / old * 100. From 80 to 92 is (92 - 80) / 80 * 100 = 15%."],
  ["Is it 'affect' or 'effect' in 'the delay will ___ delivery'?", "'Affect': the delay will affect delivery. 'Effect' is usually the noun."],
  ["Give me three icebreakers for a new driver onboarding.", "1. What's the best road you've ever driven? 2. Which service station has the best coffee on your usual route? 3. What's one thing you wish dispatch knew about your day?"],
  ["Quick: what's 17% of 2,350?", "399.5"],
  ["What does ETA vs ETD mean?", "ETA is estimated time of arrival; ETD is estimated time of departure."],
  ["Recommend a podcast for long drives.", "Hardcore History is a classic for long drives: episodes run four to six hours, so one covers a whole shift."],
  ["How do I say 'thank you for your patience' in German?", "\"Vielen Dank für Ihre Geduld.\""],
  ["What's a quick way to dedupe a column in Excel?", "Select the column, then Data > Remove Duplicates. To keep the original, copy the column first or use =UNIQUE(A:A) in Excel 365."],
  ["Is 7am too early for a team call?", "For a team that starts at 6 on the dock, 7am is fine; for office staff, 8:30 or later lands better. Ask once and keep it fixed."],
  ["Write a subject line for a weekly ops report.", "\"Ops weekly: on-time rate, incidents and next week's watch list\""],
  ["Convert 65 miles to km.", "About 104.6 km."],
  ["What's the plural of 'forklift'?", "Forklifts."],
  ["Give me a two-sentence summary of what a WMS does.", "A warehouse management system tracks stock, locations and movements inside a warehouse. It directs receiving, put-away, picking and shipping so that the right goods leave on time."],
  ["Any idea for a small team reward under 100 euros?", "A catered breakfast for the shift, or a pizza night at the depot: both cost well under 100 euros and everyone can join."],
  ["What's a good stretch to do after hours of driving?", "Stand up, clasp your hands behind your back and gently open the chest for 20 seconds, then do slow neck rolls and a standing hamstring stretch against the truck step."],
];

/** Facts are stated once, early; the probes ask for them after both folds. */
export function conversation(): Turn[] {
  const f = [...filler];
  const side = (): Turn => { const [user, assistant] = f.shift()!; return { user, assistant }; };
  return [
    { user: "Hi! I'm Maya, ops lead at Kestrel Freight. I'll be using you a lot for our routing migration.", assistant: "Nice to meet you, Maya. Happy to help with the routing migration: tell me what you have so far." },
    { user: "Our main warehouse is WH-7731 in Rotterdam. Everything starts there.", assistant: "Got it: main warehouse WH-7731 in Rotterdam." },
    { user: "Budget cap for the whole migration is €18,400. Don't let anything push past that.", assistant: "Noted: the migration budget is capped at €18,400." },
    side(),
    { user: "One preference: always write dates as DD/MM/YYYY in anything you draft for me.", assistant: "Understood, dates in DD/MM/YYYY in every draft." },
    { user: "Our vendor contact for the new routing system is Tomasz Wierzbicki, tomasz@nordlane.io.", assistant: "Thanks: Tomasz Wierzbicki at tomasz@nordlane.io is the vendor contact." },
    side(),
    { user: "Hard deadline: the cutover must finish by 14 March 2027.", assistant: "Noted: cutover complete by 14 March 2027." },
    side(),
    { user: "The current routing table lives at /srv/kestrel/routing/v3/routes.csv.", assistant: "OK, the current table is /srv/kestrel/routing/v3/routes.csv." },
    { user: "Important: never email the finance team directly. Anything money-related goes through Ilse.", assistant: "Understood: nothing goes to finance directly; money questions go through Ilse." },
    side(),
    { user: "We have 312 active trucks right now, for scale.", assistant: "312 active trucks, noted." },
    side(),
    side(),
    { user: "Track everything for this under ticket OPS-4471.", assistant: "Will do: everything goes under OPS-4471." },
    { user: "And keep any message to drivers under 40 words, they read them on the road.", assistant: "Got it: driver messages stay under 40 words." },
    { user: "Here's the plan, six steps: 1) export the current routes, 2) dedupe the depots, 3) map every depot to the new zone codes, 4) validate the mapping with the vendor, 5) draft the driver notice, 6) schedule the cutover. Let's start with step 1.",
      assistant: "Step 1 done: I exported the current routes from /srv/kestrel/routing/v3/routes.csv to /srv/kestrel/exports/routes-export.csv, 2,114 routes in total. The per-depot parcel counts came back with the export.",
      tools: [
        { name: "Bash", input: "{\"command\": \"python3 export_routes.py --src /srv/kestrel/routing/v3/routes.csv --out /srv/kestrel/exports/routes-export.csv\"}", result: "exported 2114 routes\nper-depot parcels:\n  Rotterdam: 6,402\n  Utrecht: 1,947\n  Eindhoven: 2,310\n  Antwerp: 3,118\n  Duisburg: 1,226\nwritten /srv/kestrel/exports/routes-export.csv" },
      ] },
    side(),
    side(),
    { user: "Great. Step 2 now: dedupe the depots.", assistant: "Step 2 done: I found 37 duplicate depot rows (same depot under two spellings) and merged them; the clean list has 58 depots and is saved as /srv/kestrel/exports/depots-clean.csv.",
      tools: [{ name: "Bash", input: "{\"command\": \"python3 dedupe_depots.py /srv/kestrel/exports/routes-export.csv\"}", result: "duplicates: 37\nmerged pairs: Utrecht-Lage Weide/Utrecht LW, Antwerpen/Antwerp, ...\nclean depots: 58 -> /srv/kestrel/exports/depots-clean.csv\nchecksum 9f3c2e1" }] },
    side(),
    side(),
    side(),
    { user: "Before step 3: the vendor says their zone codes look like NLR-02. Use their format.", assistant: "Understood: I'll use the vendor's format (like NLR-02) for the new zone codes." },
    side(),
    side(),
    { user: "Start step 3, mapping depots to zones. Do the Dutch depots first.", assistant: "Step 3 is under way: the Dutch depots are mapped. Rotterdam is NLR-02, Utrecht is NLU-01 and Eindhoven is NLE-03. The Belgian and German depots are still to do.",
      tools: [{ name: "Bash", input: "{\"command\": \"python3 map_zones.py --country NL\"}", result: "Rotterdam -> NLR-02\nUtrecht -> NLU-01\nEindhoven -> NLE-03\n3 depots mapped, 0 unmatched" }] },
    side(),
    side(),
    side(),
    { user: "Now finish step 3 with the Belgian and German depots.", assistant: "Step 3 done: Antwerp is BEA-01 and Duisburg is DED-04, so all 58 depots now have zone codes. The full mapping is in /srv/kestrel/exports/zone-map.csv.",
      tools: [{ name: "Bash", input: "{\"command\": \"python3 map_zones.py --country BE,DE --out /srv/kestrel/exports/zone-map.csv\"}", result: "Antwerp -> BEA-01\nDuisburg -> DED-04\n58/58 depots mapped -> /srv/kestrel/exports/zone-map.csv" }] },
    side(),
    side(),
    { user: "Quick status check, no action needed: where are we on the six steps?", assistant: "Steps 1 to 3 are done (routes exported, depots deduped to 58, all depots mapped to zone codes in /srv/kestrel/exports/zone-map.csv). Next is step 4, validating the mapping with the vendor." },
    side(),
    side(),
    side(),
    side(),
    side(),
    side(),
    side(),
  ];
}

export interface Probe { id: string; ask: string; expect: RegExp; early: boolean; archiveOnly?: boolean }

export const RECALL: Probe[] = [
  { id: "company", ask: "Quick one: which company do I work for?", expect: /kestrel/i, early: true },
  { id: "warehouse", ask: "What's our main warehouse code again?", expect: /WH-?7731/i, early: true },
  { id: "budget", ask: "Remind me of the migration budget cap?", expect: /18[,.]?400/, early: true },
  { id: "date-format", ask: "What date format do I want in drafts?", expect: /DD\/MM\/YYYY/i, early: true },
  { id: "vendor", ask: "What's the vendor contact's email?", expect: /tomasz@nordlane\.io/i, early: true },
  { id: "deadline", ask: "When does the cutover have to be finished?", expect: /14(th)? march|14\/03|march 14/i, early: true },
  { id: "routes-path", ask: "Where does the current routing table live? Full path please.", expect: /\/srv\/kestrel\/routing\/v3\/routes\.csv/, early: true },
  { id: "finance", ask: "If I need something from finance, who do I go through?", expect: /ilse/i, early: true },
  { id: "trucks", ask: "How many active trucks do we have?", expect: /\b312\b/, early: true },
  { id: "ticket", ask: "Which ticket are we tracking this under?", expect: /OPS-?4471/i, early: true },
  { id: "driver-limit", ask: "What's the word limit for messages to drivers?", expect: /\b40\b/, early: true },
  { id: "zone-rotterdam", ask: "What zone code did Rotterdam get?", expect: /NLR-?02/i, early: false },
  { id: "dupes", ask: "How many duplicate depot rows did step 2 find?", expect: /\b37\b/, early: false },
  { id: "utrecht-parcels", ask: "In the route export, how many parcels did the Utrecht depot have?", expect: /1[,.]?947/, early: true, archiveOnly: true },
];

export const CONTINUE = [
  { id: "next-step", ask: "OK, carry on with the next step.",
    pass: "The bot works on step 4, validating the depot-to-zone mapping with the vendor (Tomasz, tomasz@nordlane.io): it sends or fully drafts the validation request itself (a send_email call to tomasz@nordlane.io counts), rather than only describing what it will do or asking what the next step is. It does not redo steps 1 to 3, and it does not contact finance." },
  { id: "driver-notice", ask: "Vendor signed off. Now do step 5.",
    pass: "The bot drafts the driver notice about the routing cutover (step 5). The notice itself is under 40 words, and any date in it is written DD/MM/YYYY (for example 14/03/2027). It must not ask what step 5 is." },
];
