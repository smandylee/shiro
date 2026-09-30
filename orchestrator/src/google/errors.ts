import { GaxiosError } from "googleapis-common";

// What a failed Google call is allowed to look like in a log.
//
// A GaxiosError carries the whole request that failed: the URL, the headers,
// and for a failed token refresh the form body — which is the refresh token and
// the client secret, in plain text. console.error(err) prints all of it. The
// reminder check fails every five minutes when the token is dead, so one bad
// week wrote the client secret into the journal about thirteen thousand times.
//
// Nothing here trusts callers to log carefully. The class itself is changed so
// that printing it, anywhere, gives one line and no request.

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

type ErrorBody = { error?: unknown; error_description?: unknown };

/** What Google's reply said, whether gaxios left it parsed or as a JSON string. */
function bodyOf(err: GaxiosError): ErrorBody | undefined {
  const data: unknown = err.response?.data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as ErrorBody;
    } catch {
      return undefined;
    }
  }
  return data && typeof data === "object" ? (data as ErrorBody) : undefined;
}

/** One line: what Google said, and nothing about what we sent. */
export function describeError(err: unknown): string {
  if (err instanceof GaxiosError) {
    const status = err.response?.status ?? err.status;
    const body = bodyOf(err);
    // `error` is a string from the token endpoint and an object from the APIs.
    const nested = (body?.error as { message?: unknown } | undefined)?.message;
    const reason =
      typeof body?.error === "string" ? body.error : typeof nested === "string" ? nested : undefined;
    const detail = typeof body?.error_description === "string" ? body.error_description : undefined;
    const parts = [`Google ${status ?? "?"}`];
    if (reason) parts.push(reason);
    if (detail) parts.push(`— ${detail}`);
    return parts.join(" ").slice(0, 300);
  }
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
}

/** The refresh token itself is dead: expired, revoked, or the password changed. */
export function isInvalidGrant(err: unknown): boolean {
  if (err instanceof GaxiosError && bodyOf(err)?.error === "invalid_grant") return true;
  // The message is "invalid_grant" for a failed refresh, but do not depend on
  // it being exactly that.
  return err instanceof Error && err.message.includes("invalid_grant");
}

/**
 * Thrown in place of anything that goes wrong while getting an access token.
 * It has a message and a flag and no attached request, so it is safe to log,
 * store, or hand to a language model as-is.
 */
export class GoogleAuthError extends Error {
  readonly invalidGrant: boolean;
  constructor(message: string, invalidGrant: boolean) {
    super(message);
    this.name = "GoogleAuthError";
    this.invalidGrant = invalidGrant;
  }
}

let installed = false;

/**
 * Makes every GaxiosError print as a single summary line. The plain properties
 * are untouched — code that reads `err.response.status` still works — this only
 * changes what console.error and util.inspect show.
 */
export function installSafeErrorPrinting(): void {
  if (installed) return;
  installed = true;
  Object.defineProperty(GaxiosError.prototype, inspectCustom, {
    value: function (this: GaxiosError) {
      return `[GaxiosError: ${describeError(this)}]`;
    },
    configurable: true,
    writable: true,
  });
}
