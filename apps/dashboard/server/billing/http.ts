import type { IncomingMessage, ServerResponse } from "node:http";
import { CANCEL_ANSWERS, CLOUD_SWATCHES, RETENTION_OFFERS } from "../../../../shared/billing-api.ts";
import type { CancelSurvey, CloudSwatch } from "../../../../shared/billing-api.ts";
import { BillingError } from "./service.ts";

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
export function invalid(): never { throw new BillingError(400, "invalid_request"); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export async function rawBody(req: IncomingMessage, cap: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > cap) { req.resume(); invalid(); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function body(req: IncomingMessage) {
  const raw = await rawBody(req, 16 * 1024);
  try { return object(JSON.parse(raw.toString("utf8") || "{}")); } catch { return invalid(); }
}
export function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
export function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value); }
export function cloudName(value: unknown): string {
  const name = text(value).replace(/\s+/g, " ").trim();
  if (!name || [...name].length > 40 || /[\p{Cc}<>]/u.test(name)) invalid();
  return name;
}
export function color(value: unknown): CloudSwatch | null {
  if (value === null) return null;
  if (!CLOUD_SWATCHES.includes(value as CloudSwatch)) invalid();
  return value as CloudSwatch;
}
export function survey(value: unknown): CancelSurvey {
  const data = object(value);
  if (!CANCEL_ANSWERS.includes(data.answer as CancelSurvey["answer"])) invalid();
  if (data.offer !== undefined && !RETENTION_OFFERS.includes(data.offer as NonNullable<CancelSurvey["offer"]>)) invalid();
  return { answer: data.answer as CancelSurvey["answer"], ...(data.expected === undefined ? {} : { expected: text(data.expected) }), ...(data.improve === undefined ? {} : { improve: text(data.improve) }),
    ...(data.offer === undefined ? {} : { offer: data.offer as NonNullable<CancelSurvey["offer"]> }) };
}
export function cartInput(value: unknown) {
  const data = object(value), license = object(data.license), desktop = object(data.desktop);
  const spec = desktop.spec === undefined ? undefined : object(desktop.spec);
  return { interval: data.interval, license: { kind: license.kind, ...(license.members === undefined ? {} : { members: license.members }) },
    desktop: { kind: desktop.kind, ...(desktop.region === undefined ? {} : { region: desktop.region }), ...(spec ? { spec: { vcpu: spec.vcpu, ramGb: spec.ramGb, diskGb: spec.diskGb } } : {}) } };
}
