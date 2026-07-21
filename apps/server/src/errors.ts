import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ZodError) {
    void reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request is invalid",
        requestId: reply.request.id,
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      },
    });
    return;
  }
  if (error instanceof ApiError) {
    void reply
      .status(error.status)
      .send({
        error: {
          code: error.code,
          message: error.message,
          requestId: reply.request.id,
        },
      });
    return;
  }
  if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 429) {
    void reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId: reply.request.id } });
    return;
  }
  reply.request.log.error({ err: error }, "request failed");
  void reply
    .status(500)
    .send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        requestId: reply.request.id,
      },
    });
}
