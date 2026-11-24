import { describe, expect, it } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { botPreview, groupPreview, lastPreviewable, sidebarPreviewMessages, waitingLine } from "./sidebar-preview";

let at = 0;
const message = (fields: Partial<Message>): Message => ({ id: `m${++at}`, at, role: "bot", kind: "text", ...fields }) as Message;
const screen = () => message({ kind: "screen", png: "frame", mime: "image/jpeg" });
const bot = { id: "ada", name: "Ada", messages: [], busy: false } as unknown as Bot;

describe("sidebar previews", () => {
  it("keeps partial bot and room previews meaningful and overlays streamed updates", () => {
    const person = message({ role: "user", text: "Tidy my inbox" });
    const question = message({ kind: "options", card: { title: "question", subtitle: "Which folder?", options: [], requestId: "q" } } as Partial<Message>);
    const reply = message({ text: "Archived the newsletters." });
    const step = message({ kind: "activity", tool: { name: "Read", ok: true } });
    const partial = { ...bot, transcriptLoaded: false, previewMessages: [person, question, reply, step], messages: [step, screen()] };
    expect(botPreview(partial, sidebarPreviewMessages(partial), [])).toBe("Archived the newsletters.");
    expect(waitingLine(partial, sidebarPreviewMessages(partial), [])).toBe("Which folder?");
    const patched = { ...partial, messages: [{ ...step, tool: { name: "error: Connection lost", ok: false } }] };
    expect(botPreview(patched, sidebarPreviewMessages(patched), [])).toContain("Your bot couldn't finish this reply. Try again.");
    const room = { ...partial, id: "room", name: "Room" } as unknown as Group;
    expect(groupPreview(room, [bot], [])).toBe("Archived the newsletters.");
    expect(sidebarPreviewMessages({ ...partial, transcriptLoaded: true })).toBe(partial.messages);
  });

  it("shows a bot's reply, not the screen frame its computer turn ended with", () => {
    const visible = [message({ role: "user", text: "Paint a sunset" }), message({ text: "I painted a sunset in JS Paint." }), screen()];
    expect(botPreview(bot, visible, [])).toBe("I painted a sunset in JS Paint.");
    expect(botPreview(bot, [...visible, message({ kind: "digest", text: "[digest]" }), screen()], [])).toBe("I painted a sunset in JS Paint.");
  });

  it("quotes the open question when waiting, not the bot's later closing line, and falls back to the newest line", () => {
    const question = message({ kind: "options", card: { title: "Your bot has a question", subtitle: "Which folder for trip files?", options: [], requestId: "q1", requestType: "question" } } as unknown as Partial<Message>);
    const closing = message({ text: "Setup's done. Want me to plan another trip?" });
    expect(waitingLine(bot, [question, closing], [])).toBe("Which folder for trip files?");
    expect(waitingLine(bot, [closing], [])).toBe("Setup's done. Want me to plan another trip?");
  });

  it("names a pending sign-in, password or app card over every newer bot reply until it is answered", () => {
    const signIn = message({ kind: "signin", signIn: { site: "X", url: "https://x.com/login" } } as unknown as Partial<Message>);
    const later = [message({ text: "Checked the feed." }), message({ role: "user", text: "Anything new?" }), message({ text: "Nothing left for today." })];
    expect(waitingLine(bot, [signIn, ...later], [])).toBe("Sign in to X");
    expect(waitingLine({ ...bot, busy: true } as Bot, [signIn, ...later], [])).toBe("Sign in to X");
    const done = { ...signIn, signIn: { site: "X", url: "https://x.com/login", done: true } } as Message;
    expect(waitingLine(bot, [done, ...later], [])).toBe("Nothing left for today.");
    const secret = message({ kind: "secret", secret: { label: "the Stripe key" } } as unknown as Partial<Message>);
    expect(waitingLine(bot, [secret, ...later], [])).toBe("Needs the Stripe key");
    const connect = message({ kind: "connector", connector: { label: "Gmail", status: "needed", resumeKey: "gmail" } } as unknown as Partial<Message>);
    expect(waitingLine(bot, [connect, ...later], [])).toBe("Connect Gmail");
  });

  it("shows nothing for a conversation that holds only screen frames", () => {
    expect(botPreview(bot, [screen(), screen()], [])).toBe("");
    expect(lastPreviewable([screen(), message({ kind: "compaction" })])).toBeUndefined();
  });

  const step = (name: string) => message({ kind: "activity", tool: { name, ok: true } } as Partial<Message>);

  it.each([
    ["Run schedule", "Waiting for a background task"],
    ["Run manage_task", "Checking a background task"],
  ])("shows a friendly sidebar preview for %s", (name, label) => {
    expect(botPreview(bot, [step(name)], [])).toBe(label);
  });

  it("quotes the bot when its newest line is a step that went fine", () => {
    const visible = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "Archived 31 newsletters." }), step("Bash")];
    expect(botPreview(bot, visible, [])).toBe("Archived 31 newsletters.");
    expect(botPreview(bot, [message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [])).not.toBe("Tidy my inbox");
    expect(botPreview(bot, [message({ text: "Earlier reply" }), message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [])).not.toBe("Earlier reply");
  });

  it("keeps a failed step's error line and a recovery or notice line as they are", () => {
    const failed = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), message({ kind: "activity", tool: { name: "error: Gmail is not connected", ok: false } } as Partial<Message>)];
    expect(botPreview(bot, failed, [])).toContain("Your bot couldn't finish this reply. Try again.");
    const notice = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), step("notice: Switched to a backup model")];
    expect(botPreview(bot, notice, [])).toBe("Switched to a backup model");
  });

  it("says a helper's intro card by its first line in the reader's language instead of its stored English title", () => {
    const intro = message({ kind: "options", helperIntro: true, card: { title: "Hi! I'm Ada, your Chief of Staff.", options: [] } } as unknown as Partial<Message>);
    expect(botPreview({ ...bot, chiefOfStaff: true } as Bot, [intro], [])).toBe("Hi! I'm Ada. Hand me one real job and I'll get it done.");
    expect(botPreview(bot, [intro], [])).toBe("Hi! I'm Ada, your helper for everything here.");
  });

  it("quotes the bot in a group chat too", () => {
    const from = { botId: "ada", name: "Ada", color: "green" } as Message["from"];
    const group = { id: "g", name: "Room", messages: [message({ role: "user", text: "Plan the launch" }), message({ text: "Here is the plan.", from }), message({ kind: "activity", tool: { name: "Read", ok: true }, from } as Partial<Message>)] } as unknown as Group;
    expect(groupPreview(group, [bot], [])).toBe("Ada: Here is the plan.");
  });

  it("says a message of files only as grok does: sent 1 PDF, Sent 1 spreadsheet, Sent 1 video, and a mix as files", () => {
    const file = (mime: string, name: string) => ({ kind: "file" as const, path: name, mime, name });
    const sent = (attachments: Message["attachments"], text = "") => botPreview(bot, [message({ text, attachments })], []);
    expect(sent([file("application/pdf", "trip.pdf")])).toBe("Sent 1 PDF");
    expect(sent([file("text/plain", "orders.csv")])).toBe("Sent 1 spreadsheet");
    expect(sent([file("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "q3.xlsx")])).toBe("Sent 1 spreadsheet");
    expect(sent([file("video/mp4", "demo.mp4")])).toBe("Sent 1 video");
    expect(sent([{ kind: "image", path: "a.png", mime: "image/png" }, { kind: "image", path: "b.png", mime: "image/png" }])).toBe("Sent 2 images");
    expect(sent([file("application/pdf", "a.pdf"), file("video/mp4", "b.mp4")])).toBe("Sent 2 files");
    expect(sent([file("application/pdf", "trip.pdf")], "Here is your checklist.")).toBe("Here is your checklist.");
    const from = { botId: "ada", name: "Ada", color: "green" } as Message["from"];
    expect(groupPreview({ id: "g", name: "Room", messages: [message({ from, attachments: [file("application/pdf", "a.pdf")] })] } as unknown as Group, [bot], [])).toBe("Ada: Sent 1 PDF");
  });

  it("quotes the reply, not Partly done, when the reply already says what failed", () => {
    const visible = [message({ role: "user", text: "Email Maya" }), message({ text: "I couldn't send it: Gmail isn't connected." })];
    const owned = message({ kind: "activity", tool: { name: "error: Gmail send failed", ok: false, partial: true, owned: true } });
    expect(botPreview(bot, [...visible, owned], [])).toBe("I couldn't send it: Gmail isn't connected.");
    const unowned = message({ kind: "activity", tool: { name: "error: Gmail send failed", ok: false, partial: true } });
    expect(botPreview(bot, [...visible, unowned], [])).toBe("Partly done: a step didn't work");
  });
  it("skips screen frames in a group chat's preview too", () => {
    const group = { id: "g", name: "Room", messages: [message({ text: "Done.", from: { botId: "ada", name: "Ada", color: "green" } }), screen()] } as unknown as Group;
    expect(groupPreview(group, [bot], [])).toBe("Ada: Done.");
  });

  it("skips auto-approval audit chips in bot and group previews", () => {
    const approved = step("approved other (full access): Run mcp_agents_search");
    const visible = [message({ role: "user", text: "Check my inbox" }), approved];
    expect(botPreview(bot, visible, [])).toBe("Check my inbox");
    expect(lastPreviewable([approved])).toBeUndefined();
    const withRealStep = [message({ role: "user", text: "Check my inbox" }), step("Read"), approved];
    expect(botPreview(bot, withRealStep, [])).toBe("Read a file");
  });
});
