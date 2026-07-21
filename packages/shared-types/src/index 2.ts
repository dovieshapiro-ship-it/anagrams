import { z } from "zod";

export const gameRulesSchema = z
  .object({
    rackSize: z.number().int().min(3).max(12),
    roundSeconds: z.number().int().positive(),
    minimumWordLength: z.number().int().positive(),
    scoreByLength: z.record(
      z.string().regex(/^\d+$/),
      z.number().int().nonnegative(),
    ),
  })
  .strict();

export type GameRules = z.infer<typeof gameRulesSchema>;

export const DEFAULT_GAME_RULES = gameRulesSchema.parse({
  rackSize: 6,
  roundSeconds: 60,
  minimumWordLength: 3,
  scoreByLength: {
    3: 100,
    4: 400,
    5: 1200,
    6: 2000,
  },
}) satisfies GameRules;
