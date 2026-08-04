import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  INVITATION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10080)
    .default(1440),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).max(320).optional(),
});

export type Env = Omit<
  z.infer<typeof schema>,
  "WEB_ORIGINS" | "COOKIE_SECURE" | "TRUST_PROXY"
> & {
  origins: readonly string[];
  cookieSecure: boolean;
  trustProxy: boolean;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const value = schema.parse(input);
  return {
    ...value,
    origins: value.WEB_ORIGINS.split(",").map(
      (item) => new URL(item.trim()).origin,
    ),
    cookieSecure:
      value.COOKIE_SECURE === undefined
        ? value.NODE_ENV === "production"
        : value.COOKIE_SECURE === "true",
    trustProxy: value.TRUST_PROXY === "true",
  };
}
