import { ZodError } from "zod";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json(
      { error: { code: "invalid_request", message: "The request payload is invalid." } },
      { status: 400 },
    );
  }
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }
  return Response.json(
    { error: { code: "internal_error", message: "The operation could not be completed." } },
    { status: 500 },
  );
}
