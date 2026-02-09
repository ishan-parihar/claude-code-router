/**
 * Provider-specific error handling
 */

export interface ProviderError {
  code: string;
  message: string;
  statusCode: number;
  isRetryable: boolean;
  retryAfter?: number;
  provider: string;
}

export interface ErrorRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: ErrorRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
};

export const PROVIDER_ERROR_MAPS: Record<
  string,
  Record<string, ProviderError>
> = {
  iflow: {
    "434": {
      code: "invalid_api_key",
      message: "Invalid API key provided",
      statusCode: 401,
      isRetryable: false,
      provider: "iflow",
    },
    "439": {
      code: "token_expired",
      message: "API token has expired",
      statusCode: 401,
      isRetryable: false,
      provider: "iflow",
    },
    "511": {
      code: "content_too_large",
      message: "Request content exceeds maximum size",
      statusCode: 413,
      isRetryable: false,
      provider: "iflow",
    },
    "514": {
      code: "model_error",
      message: "Model encountered an error",
      statusCode: 500,
      isRetryable: true,
      retryAfter: 1000,
      provider: "iflow",
    },
    "429": {
      code: "rate_limit",
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: true,
      provider: "iflow",
    },
    "449": {
      code: "rate_limit_variant",
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: true,
      provider: "iflow",
    },
    "8211": {
      code: "rate_limit_aggressive",
      message: "Rate limit exceeded - aggressive throttling",
      statusCode: 429,
      isRetryable: true,
      retryAfter: 60000,
      provider: "iflow",
    },
  },
  openai: {
    "rate_limit_exceeded": {
      code: "rate_limit",
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: true,
      provider: "openai",
    },
    "insufficient_quota": {
      code: "insufficient_quota",
      message: "Insufficient quota",
      statusCode: 429,
      isRetryable: false,
      provider: "openai",
    },
    "invalid_api_key": {
      code: "invalid_api_key",
      message: "Invalid API key",
      statusCode: 401,
      isRetryable: false,
      provider: "openai",
    },
  },
  anthropic: {
    "rate_limit_error": {
      code: "rate_limit",
      message: "Rate limit exceeded",
      statusCode: 429,
      isRetryable: true,
      provider: "anthropic",
    },
    "authentication_error": {
      code: "invalid_api_key",
      message: "Invalid API key",
      statusCode: 401,
      isRetryable: false,
      provider: "anthropic",
    },
    "invalid_request_error": {
      code: "invalid_request",
      message: "Invalid request",
      statusCode: 400,
      isRetryable: false,
      provider: "anthropic",
    },
  },
};

export class ProviderErrorHandler {
  private retryConfig: ErrorRetryConfig;

  constructor(retryConfig: Partial<ErrorRetryConfig> = {}) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  static parseError(
    provider: string,
    statusCode: number,
    errorBody: any,
    providerType?: string
  ): ProviderError {
    const lookupKey = providerType 
      ? providerType.toLowerCase() 
      : provider.toLowerCase();
      
    const errorMap = PROVIDER_ERROR_MAPS[lookupKey];

    const errorCode =
      errorBody?.error_code ||
      errorBody?.error?.code ||
      errorBody?.code ||
      errorBody?.error?.type ||
      statusCode.toString();

    if (errorMap && errorMap[errorCode]) {
      return { ...errorMap[errorCode], provider };
    }

    return {
      code: "unknown_error",
      message: errorBody?.message || errorBody?.error?.message || "Unknown error",
      statusCode,
      isRetryable: statusCode >= 500 || statusCode === 429,
      provider: provider,
    };
  }

  static shouldFailover(error: ProviderError): boolean {
    return error.isRetryable && (error.statusCode >= 500 || error.statusCode === 429);
  }

  static isRetryable(error: ProviderError): boolean {
    return error.isRetryable;
  }

  getRetryDelay(error: ProviderError, attempt: number): number {
    if (error.retryAfter) {
      return error.retryAfter;
    }

    const delay = Math.min(
      this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt),
      this.retryConfig.maxDelayMs
    );

    return delay;
  }

  async executeWithRetry<T>(
    provider: string,
    operation: () => Promise<T>,
    onError?: (error: ProviderError, attempt: number) => void
  ): Promise<T> {
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        let providerError: ProviderError;

        if (error.statusCode) {
          providerError = ProviderErrorHandler.parseError(
            provider,
            error.statusCode,
            error.body || error
          );
        } else {
          providerError = {
            code: "network_error",
            message: error.message || "Network error",
            statusCode: 0,
            isRetryable: true,
            provider,
          };
        }

        lastError = providerError;

        if (onError) {
          onError(providerError, attempt);
        }

        if (!providerError.isRetryable || attempt >= this.retryConfig.maxRetries) {
          throw error;
        }

        const delay = this.getRetryDelay(providerError, attempt);
        await sleep(delay);
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }

  formatUserMessage(error: ProviderError): string {
    switch (error.code) {
      case "invalid_api_key":
        return `Authentication failed: ${error.message}. Please check your API key configuration.`;
      case "token_expired":
        return `Authentication failed: ${error.message}. Please refresh your API token.`;
      case "rate_limit":
      case "rate_limit_variant":
        return `Rate limit reached: ${error.message}. Please wait a moment before retrying.`;
      case "rate_limit_aggressive":
        return `Rate limit reached: ${error.message}. Please wait ${error.retryAfter ? Math.ceil(error.retryAfter / 1000) : 60} seconds before retrying.`;
      case "content_too_large":
        return `Request too large: ${error.message}. Please reduce the size of your request.`;
      case "model_error":
        return `Model error: ${error.message}. The AI model encountered an issue. Please retry.`;
      case "insufficient_quota":
        return `Quota exceeded: ${error.message}. Please check your account limits.`;
      case "invalid_request":
        return `Invalid request: ${error.message}. Please check your request parameters.`;
      default:
        return `Error from ${error.provider}: ${error.message} (code: ${error.code})`;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProviderErrorHandler(config?: Partial<ErrorRetryConfig>): ProviderErrorHandler {
  return new ProviderErrorHandler(config);
}
