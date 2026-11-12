type CursorSdkErrorKind = "AuthenticationError" | "ConfigurationError" | "CursorSdkError";

export interface CursorSdkWireError {
  readonly name: string;
  readonly message: string;
  readonly kinds: ReadonlyArray<CursorSdkErrorKind>;
  readonly code?: string | number;
  readonly status?: number;
  readonly method?: string;
  readonly cause?: CursorSdkWireError;
}

export class CursorSdkRemoteError extends Error {
  readonly kinds: ReadonlyArray<CursorSdkErrorKind>;
  readonly code: string | number | undefined;
  readonly status: number | undefined;
  readonly method: string | undefined;

  constructor(error: CursorSdkWireError) {
    super(
      error.message,
      error.cause === undefined ? undefined : { cause: new CursorSdkRemoteError(error.cause) },
    );
    this.name = error.name;
    this.kinds = error.kinds;
    this.code = error.code;
    this.status = error.status;
    this.method = error.method;
  }
}

export function cursorSdkWireError(
  error: unknown,
  isSdkError: (error: unknown, kind: CursorSdkErrorKind) => boolean = () => false,
  seen = new Set<object>(),
): CursorSdkWireError {
  if (typeof error !== "object" || error === null) {
    return { name: "Error", message: String(error), kinds: [] };
  }
  if (seen.has(error) || seen.size >= 16) {
    return { name: "Error", message: "Cursor error cause chain truncated.", kinds: [] };
  }
  seen.add(error);
  const name = Reflect.get(error, "name");
  const message = Reflect.get(error, "message");
  const code = Reflect.get(error, "code");
  const status = Reflect.get(error, "status");
  const method =
    Reflect.get(error, "_tag") === "CursorAgentSdkRunnerError"
      ? Reflect.get(error, "method")
      : error instanceof CursorSdkRemoteError
        ? error.method
        : undefined;
  const cause = Reflect.get(error, "cause");
  return {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : String(error),
    kinds: (["AuthenticationError", "ConfigurationError", "CursorSdkError"] as const).filter(
      (kind) =>
        isSdkError(error, kind) ||
        (error instanceof CursorSdkRemoteError && error.kinds.includes(kind)),
    ),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof method === "string" ? { method } : {}),
    ...(cause === undefined ? {} : { cause: cursorSdkWireError(cause, isSdkError, seen) }),
  };
}
