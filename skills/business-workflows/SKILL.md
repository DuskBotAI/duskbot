---
name: business-workflows
description: "Design, then build, ongoing work handed over as a whole (a department or process: support, deals, outbound sales, hiring, invoices, reports): automations, background jobs, records, approvals and a test run."
---

# Business workflows

Workflows: when the person hands you ongoing work with several parts (a department or process: answer support, track deals, outbound sales, hiring, invoices, reports), design it before you build it.

Split it into parts: an automation for each cadence (when=schedule), when=app_event or when=webhook for "whenever X happens", a background job only for a live chat or feed, a teammate (create_bot) only when the person asks for a team.

For each part decide what it reads, what it does itself, and what waits for the person: mail to customers or strangers they asked to see first, a first batch of cold outreach, refunds, money, legal and contracts become drafts or a NEEDS INPUT question; safe repeat work never asks.

Give it records that outlive each run: one sheet (in a connected spreadsheet app, else create_document kind sheet) or document per workflow, with a row per item keyed by its id or email and a status column (new, drafted, waiting for OK, approved, sent, followed up, done) and dates. Every run reads it first, skips what it already handled, and writes it back last; an approval the person gives in chat is written there as approved, and runs act only on approved rows. Put that sheet's name and id in each automation's instructions.

When their message already says what each part needs (what to watch or do, when, where it goes, who it is for), that is the go-ahead: build it all now, test it, and report the plan with what you built. Only when something only they can answer is missing, send ONE short message first: the plan in three to six plain lines (what runs when, what it sends on its own, what waits for them, where results show up) and, in the same message, every question only they can answer: when, in their time zone (they may not be where this computer is), who it sends as and to, what goes in it, and where the line is between what you do yourself and what waits for them; leave out anything you can read in their apps or default sensibly, and say the default. Then build nothing until they answer, and build it all in the turn they do.

Write each automation's instructions so a run that never saw this chat can do the job: the apps and accounts, the sheet, the rules for what to do itself and what to hold, and what to report. Missing access is one request: request_credential for a key or token, or the app's Connect card; build the rest meanwhile and leave the part that waits on it paused. Automations and background jobs need no computer, so never ask to turn on Works on for them.

Rules the person gives for the work (a policy, an operating manual) go in create_document with manual=true: only they can change it, and every run reads it first. A report or table that goes out as a file is a document made into one with list_documents and export_as (pdf, xlsx, docx); attach that path to the email.

Test it once before it counts: trigger action=run_now with test=true for a schedule (nothing is sent; it takes one real or sample item through every step and reports what it would do), the test event for an app event or webhook, or the same steps by hand now on the real data, and tell the person what the test found. Finish with what is running, when (time zone as people say it), where results appear, what waits for their OK, and that they can say here "pause the follow-ups" or "change the time". When they later ask what is running, call trigger_info list and answer from it, with each part's last result.
