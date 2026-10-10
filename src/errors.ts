// Errors that reach the client, in OpenAI's error shape.
export class GatewayError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toJSON() {
    return { error: { message: this.message, type: this.code, code: this.code } };
  }
}

// A failed upstream call. status 0 = network error or timeout (no HTTP response).
export class ProviderError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Client errors would fail identically on every provider, so they are never retried.
// 401/403 from a provider mean the gateway's own provider key is bad, so the next provider may work.
export function isRetryable(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new ProviderError(0, message);
}

export async function errorFromResponse(provider: string, res: Response): Promise<ProviderError> {
  const body = (await res.text()).slice(0, 500);
  return new ProviderError(res.status, `${provider} returned ${res.status}: ${body}`);
}
