export interface HeaderContext {
  provider: string;
  providerType?: string;
  model: string;
  sessionId?: string;
  conversationId?: string;
  requestId: string;
  isStream: boolean;
}

export class HeaderManager {
  private static readonly DEFAULT_HEADERS: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  private static readonly PROVIDER_HEADERS: Record<
    string,
    Record<string, string>
  > = {
    iflow: {
      "user-agent": "iFlow-Cli",
      "x-client-type": "iflow-cli",
      "x-client-version": "0.5.8",
    },
    openai: {
      "User-Agent": "CCR-OpenAI-Client/1.0",
    },
    anthropic: {
      "User-Agent": "CCR-Anthropic-Client/1.0",
    },
  };

  static buildRequestHeaders(
    apiKey: string,
    provider: string,
    context: HeaderContext,
    customHeaders?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.DEFAULT_HEADERS,
      Authorization: `Bearer ${apiKey}`,
      "X-Request-ID": context.requestId,
    };

    // Add provider-specific headers
    // Use providerType if available, otherwise fallback to provider name
    const lookupKey = context.providerType 
      ? context.providerType.toLowerCase() 
      : provider.toLowerCase();
      
    const providerHeaders = this.PROVIDER_HEADERS[lookupKey];
    if (providerHeaders) {
      Object.entries(providerHeaders).forEach(([key, value]) => {
        headers[key] = value;
      });
    }

    // Add session tracking headers
    // Use lowercase headers for iflow provider to match iflow-cli expectations
    const isIflow = lookupKey === "iflow";

    if (context.sessionId) {
      headers[isIflow ? "session-id" : "X-Session-ID"] = context.sessionId;
    }
    if (context.conversationId) {
      headers[isIflow ? "conversation-id" : "X-Conversation-ID"] =
        context.conversationId;
    }

    // Add stream header if applicable
    if (context.isStream) {
      headers["Accept"] = "text/event-stream";
    }

    // Apply custom headers (override defaults)
    if (customHeaders) {
      Object.entries(customHeaders).forEach(([key, value]) => {
        if (value && value !== "undefined") {
          headers[key] = value;
        }
      });
    }

    // Clean up any undefined values
    for (const key in headers) {
      if (
        headers[key] === "undefined" ||
        (key.toLowerCase() === "authorization" &&
          headers[key]?.includes("undefined"))
      ) {
        delete headers[key];
      }
    }

    return headers;
  }

  static buildResponseHeaders(isStream: boolean): Record<string, string> {
    if (isStream) {
      return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      };
    }
    return {
      "Content-Type": "application/json",
    };
  }

  static mergeHeaders(
    baseHeaders: Record<string, string>,
    overrideHeaders?: Record<string, string>,
  ): Record<string, string> {
    const merged = { ...baseHeaders };

    if (overrideHeaders) {
      Object.entries(overrideHeaders).forEach(([key, value]) => {
        if (value && value !== "undefined") {
          merged[key] = value;
        }
      });
    }

    // Clean up undefined values
    for (const key in merged) {
      if (
        merged[key] === "undefined" ||
        (key.toLowerCase() === "authorization" &&
          merged[key]?.includes("undefined"))
      ) {
        delete merged[key];
      }
    }

    return merged;
  }

  static addProviderHeader(
    provider: string,
    headers: Record<string, string>,
    providerType?: string
  ): Record<string, string> {
    const lookupKey = providerType 
      ? providerType.toLowerCase() 
      : provider.toLowerCase();
      
    const providerHeaders = this.PROVIDER_HEADERS[lookupKey];
    if (!providerHeaders) {
      return headers;
    }

    return {
      ...headers,
      ...providerHeaders,
    };
  }

  static extractContextFromHeaders(
    headers: Record<string, string>,
  ): Partial<HeaderContext> {
    return {
      sessionId: headers["x-session-id"] || headers["X-Session-ID"],
      conversationId:
        headers["x-conversation-id"] || headers["X-Conversation-ID"],
      requestId: headers["x-request-id"] || headers["X-Request-ID"],
    };
  }
}

export default HeaderManager;
