import { z } from "zod";
import { parseAccountAvatarUrl, parseUserAvatarChoice, type UserAvatarChoice } from "../shared/user-avatar.ts";

const accountAvatarUrlSchema = z.string().max(1024).refine(
  (value) => parseAccountAvatarUrl(value) !== null,
  "must be an https URL without credentials or port",
);

export const accountFaceSchema = z.object({
  id: z.string().trim().min(1).max(120),
  email: z.string().optional(),
  avatarUrl: accountAvatarUrlSchema.optional(),
  avatar: z.string().max(40).refine((value) => parseUserAvatarChoice(value) !== null, "invalid avatar choice").transform((value) => value as UserAvatarChoice).optional(),
}).strict();
