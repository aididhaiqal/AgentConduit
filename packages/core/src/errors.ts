export type CoordinationErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "expired"
  | "git_error"
  | "storage_error";

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: CoordinationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoordinationError";
    this.code = code;
    this.details = details;
  }
}

export function asCoordinationError(error: unknown): CoordinationError {
  if (error instanceof CoordinationError) return error;
  if (error instanceof Error) {
    return new CoordinationError("storage_error", error.message);
  }
  return new CoordinationError("storage_error", String(error));
}
