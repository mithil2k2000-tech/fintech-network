// The one piece of code in the apps that talks HTTP. Screens never build
// a URL or read a token; each app wraps this in its own `api` object, so
// changing the API or the auth scheme later means changing this file and
// each app's wrapper — not every screen.
import type { ApiErrorBody } from "@fintech-network/shared-types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type HttpMethod = "GET" | "POST";

export interface HttpClient {
  request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options?: { auth?: boolean }
  ): Promise<T>;
  /** Wired up once by the session provider. */
  configure(options: { onUnauthorized: () => void }): void;
}

export interface HttpClientOptions {
  /**
   * Which app this is. Sent on every request so the API knows which
   * session cookie is this app's — cookies ignore port numbers, so two
   * apps on one machine would otherwise share (and overwrite) one
   * session. See the API's modules/identity/session.ts.
   */
  sessionScope: string;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Since Phase 14 the session is an httpOnly cookie: this client never
 * sees a token, can't read one, and doesn't store one. The browser
 * attaches the cookie to same-origin requests; all this has to do is
 * ask for it to be sent.
 */
export function createHttpClient(basePath: string, options: HttpClientOptions): HttpClient {
  let onUnauthorized: () => void = () => undefined;
  const sessionScope = options.sessionScope;

  return {
    configure(next) {
      onUnauthorized = next.onUnauthorized;
    },

    async request<T>(
      method: HttpMethod,
      path: string,
      body?: unknown,
      { auth = true }: { auth?: boolean } = {}
    ): Promise<T> {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Session-Scope": sessionScope,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      let response: Response;
      try {
        response = await fetch(`${basePath}${path}`, {
          method,
          headers,
          // The session cookie rides along on same-origin requests. It
          // is never readable here — that's the point of it.
          credentials: "same-origin",
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new ApiError(
          0,
          "NETWORK_ERROR",
          "Can't reach the server. Check your connection and try again."
        );
      }

      const text = await response.text();
      const data = text ? safeJson(text) : null;

      if (!response.ok) {
        const err = (data ?? {}) as Partial<ApiErrorBody>;
        // Only a 401 ends a session. Everything else is the caller's to
        // handle, so a rate limit or a blip never signs anyone out.
        if (response.status === 401 && auth) onUnauthorized();
        throw new ApiError(
          response.status,
          err.code ?? "HTTP_ERROR",
          err.message ?? "Something went wrong. Please try again.",
          err.details
        );
      }
      return data as T;
    },
  };
}
