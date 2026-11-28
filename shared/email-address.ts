// resend answers 422 validation_error for any `to` it can't parse (checked 2026-11-28): non-ascii anywhere, a dot at either
// end of the local part or two in a row, commas, semicolons, colons, brackets, parens or backslashes, a domain label that
// starts or ends with a hyphen or holds an underscore, and a top-level domain of one letter or digits. this is the shape
// both providers take, so an address outside it gets "enter a valid email address" before any send
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** an address as typed or pasted, lower-cased, or null when no mail provider would take it. fullwidth characters from
 *  an input method are folded to ascii (nfkc) and invisible ones a paste carries (zero-width, bom, soft hyphen) dropped */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const email = value.normalize("NFKC").replace(INVISIBLE, "").trim().toLowerCase();
  if (email.length > 254) return null;
  const at = email.lastIndexOf("@"), local = email.slice(0, at), domain = email.slice(at + 1), labels = domain.split(".");
  if (at < 1 || local.length > 64 || !LOCAL.test(local) || labels.length < 2) return null;
  return labels.every(label => LABEL.test(label)) && TLD.test(labels.at(-1)!) ? email : null;
}
