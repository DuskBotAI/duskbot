/** The longest name a person can give themselves in About you, the same cap as a bot's name. */
export const PROFILE_NAME_MAX = 80;
/** The longest address SMTP allows (RFC 5321). */
export const PROFILE_EMAIL_MAX = 254;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** An About you email: empty, or one address with a dotted domain. */
export function isProfileEmail(value: string): boolean {
  const email = value.trim();
  return email === "" || (email.length <= PROFILE_EMAIL_MAX && EMAIL_SHAPE.test(email));
}
