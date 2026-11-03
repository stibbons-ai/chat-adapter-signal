import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";

export const ADAPTER_NAME = "signal";

/** A JSON-RPC error object as signal-cli returns it. */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

// Error codes from signal-cli 0.14.9, src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java
const USER_ERROR = -1;
const IO_ERROR = -3;
const UNTRUSTED_KEY_ERROR = -4;
const RATELIMIT_ERROR = -5;
const CAPTCHA_REJECTED_ERROR = -6;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// signal-cli has no dedicated code for an account the daemon does not serve
// (never registered, or deregistered by the Signal server and therefore not
// loaded); it answers INVALID_PARAMS with this message.
const UNKNOWN_ACCOUNT_MESSAGE = "Specified account does not exist";
const UNREGISTERED_USER_MESSAGE = /The user (.+) is not registered\./;

interface SendResult {
  type?: string;
  retryAfterSeconds?: number;
  recipientAddress?: { uuid?: string | null; number?: string | null };
}

/** Per-recipient send results that signal-cli attaches as `data.response.results` when every recipient failed. */
function sendResults(data: unknown): SendResult[] {
  const results = (data as { response?: { results?: unknown } } | undefined)?.response?.results;
  return Array.isArray(results) ? (results as SendResult[]) : [];
}

function allResultsAre(results: SendResult[], type: string): boolean {
  return results.length > 0 && results.every((result) => result.type === type);
}

/** Maps a signal-cli JSON-RPC error to the matching `@chat-adapter/shared` error class. */
export function fromJsonRpcError(error: JsonRpcErrorObject, method: string): AdapterError {
  const detail = `signal-cli ${method} failed: ${error.message}`;
  const results = sendResults(error.data);

  switch (error.code) {
    case RATELIMIT_ERROR: {
      const retryAfter = Math.max(0, ...results.map((result) => result.retryAfterSeconds ?? 0));
      return new AdapterRateLimitError(ADAPTER_NAME, retryAfter || undefined);
    }
    case IO_ERROR:
      return new NetworkError(ADAPTER_NAME, detail);
    case UNTRUSTED_KEY_ERROR:
      return new AdapterError(detail, ADAPTER_NAME, "UNTRUSTED_IDENTITY");
    case CAPTCHA_REJECTED_ERROR:
      return new AdapterError(detail, ADAPTER_NAME, "CAPTCHA_REJECTED");
    case METHOD_NOT_FOUND:
      return new AdapterError(detail, ADAPTER_NAME, "METHOD_NOT_FOUND");
    case INVALID_PARAMS:
      if (error.message === UNKNOWN_ACCOUNT_MESSAGE) {
        return new AuthenticationError(
          ADAPTER_NAME,
          `${detail}. The Bot Account is not registered or linked on this signal-cli daemon.`,
        );
      }
      return new ValidationError(ADAPTER_NAME, detail);
    case INVALID_REQUEST:
      return new ValidationError(ADAPTER_NAME, detail);
    case USER_ERROR: {
      const unregistered = UNREGISTERED_USER_MESSAGE.exec(error.message);
      if (unregistered?.[1]) {
        return new ResourceNotFoundError(ADAPTER_NAME, "user", unregistered[1]);
      }
      if (allResultsAre(results, "UNREGISTERED_FAILURE")) {
        const recipient = results[0]?.recipientAddress;
        return new ResourceNotFoundError(ADAPTER_NAME, "user", recipient?.uuid ?? recipient?.number ?? undefined);
      }
      if (allResultsAre(results, "NETWORK_FAILURE")) {
        return new NetworkError(ADAPTER_NAME, detail);
      }
      return new ValidationError(ADAPTER_NAME, detail);
    }
    default:
      return new AdapterError(detail, ADAPTER_NAME, "SIGNAL_CLI_ERROR");
  }
}

/** fetch failures carry the useful reason (e.g. ECONNREFUSED) on `cause`. */
function causeMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error ? error.cause.message : error.message;
}

export function malformedResponse(method: string): NetworkError {
  return new NetworkError(ADAPTER_NAME, `signal-cli JSON-RPC ${method} returned a malformed response`);
}

export function unreachable(what: string, cause: unknown): NetworkError {
  return new NetworkError(
    ADAPTER_NAME,
    `signal-cli is unreachable: ${what} failed (${causeMessage(cause)})`,
    cause instanceof Error ? cause : undefined,
  );
}

/**
 * Runs one request to signal-cli under a deadline: `exchange` must stop on `signal`. A request
 * signal-cli accepted but did not answer in time (wedged daemon, half-open connection, stuck
 * process) then fails with a `NetworkError` naming `what` and the deadline.
 */
export async function withDeadline<T>(what: string, timeoutMs: number, exchange: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await exchange(signal);
  } catch (error) {
    throw signal.aborted ? new NetworkError(ADAPTER_NAME, `${what} did not answer within ${timeoutMs} ms`) : error;
  }
}

/** Largest delay Node's `setTimeout` honours (2^31 - 1 ms). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Rejects a delay option `setTimeout` would not honour: outside this range it
 * fires after 1 ms, which would turn "wait long" into "don't wait".
 */
export function assertTimeoutMs(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > MAX_TIMEOUT_MS) {
    throw new ValidationError(ADAPTER_NAME, `${name} must be an integer from ${min} to ${MAX_TIMEOUT_MS}`);
  }
}
