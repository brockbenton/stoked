import { ERROR_STATUS, type ErrorCode } from "@stoked/shared";

/** An error the API reports as `{ error: { code, message } }` with the mapped HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = ERROR_STATUS[code];
  }
}

export const notFound = () => new ApiError("not_found", "No gift with that id");
export const invalidState = (message: string) => new ApiError("invalid_state", message);
