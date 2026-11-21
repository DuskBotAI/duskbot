import { z } from "zod";

export const COUNT_MIN = 2;
export const COUNT_MAX = 1000;
const count = z.number().int().min(COUNT_MIN).max(COUNT_MAX);
const MAX_CORRECTIVE_ROUNDS = 5;

/** The `loopGuard` section of config.json. */
export const loopGuardConfigSchema = z.object({
  /** Off unless true; DUSK_LOOP_GUARD=1 switches it on too. */
  enabled: z.boolean().optional(),
  /** Identical failures in a row before the note; 5 when unset. */
  steerAt: count.optional(),
  /** Identical failures in a row before the turn is stopped; unset never stops. DUSK_LOOP_GUARD_STOP_AT wins; null clears. */
  stopAt: count.nullable().optional(),
  /** For bots on API models: times a turn that answers after a failed tool call is sent back to re-run it; 0 when unset. */
  correctiveRounds: z.number().int().min(0).max(MAX_CORRECTIVE_ROUNDS).optional(),
}).strict();
export type LoopGuardConfig = z.output<typeof loopGuardConfigSchema>;
