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
  };

  private static readonly PROVIDER_HEADERS: Record<
    string,
    Record<string, string>
  > = {
    iflow: {
      "user-agent": "iFlow-Cli",
      "x-client-type": "iflow-cli",
      "x-client-version": "0.5.8"
    },
    openai: {
      "User-Agent": "CCR-OpenAI-Client/1.0",
    },
    anthropic: {
      "User-Agent": "CCR-Anthropic-Client/1.0",
    },
  };

  static deduplicateHeaders(headers: Record<string, string>): Record<string, string> {
    const deduplicated: Record<string, string> = {};
    const seenKeys = new Set<string>();

    for (const [key, value] of Object.entries(headers)) {
      const keyLower = key.toLowerCase();
      if (!seenKeys.has(keyLower)) {
        deduplicated[key] = value;
        seenKeys.add(keyLower);
      }
    }

    return deduplicated;
  }

  static buildRequestHeaders(
    apiKey: string,
    provider: string,
    context: HeaderContext,
    customHeaders?: Record<string, string>,
  ): Record<string, string> {
    const isIflow = (context.providerType 
      ? context.providerType.toLowerCase().startsWith("iflow")
      : provider.toLowerCase().startsWith("iflow"));

    if (isIflow) {
      console.log(`[DIAGNOSTIC] iflow Variant Detected: "${provider}" (Type: "${context.providerType}")`);
    }

    const headers: Record<string, string> = {
      ...this.DEFAULT_HEADERS,
    };

    // iflow-cli uses Title-Case for Authorization and Content-Type
    // but lowercase for user-agent, session-id, etc.
    headers["Authorization"] = `Bearer ${apiKey}`;
    
    // Always include X-Request-ID. We use lowercase for iflow just to be safe, 
    // although Title-Case worked in the test script. 
    // Let's stick to Title-Case X-Request-ID since the test script worked with it.
    headers["X-Request-ID"] = context.requestId;

    // Add provider-specific headers
    // Use providerType if available, otherwise fallback to provider name
    const rawLookupKey = context.providerType 
      ? context.providerType.toLowerCase() 
      : provider.toLowerCase();
    
    // Normalize variant keys (e.g., iflowA, iflowX) to base 'iflow'
    const lookupKey = rawLookupKey.startsWith("iflow") ? "iflow" : rawLookupKey;
    
    if (isIflow) {
      console.log(`[DIAGNOSTIC] lookupKey: "${lookupKey}" (from raw: "${rawLookupKey}")`);
    }
      
    const providerHeaders = this.PROVIDER_HEADERS[lookupKey];
    if (providerHeaders) {
      Object.entries(providerHeaders).forEach(([key, value]) => {
        headers[key] = value;
      });
    }

    // Add session tracking headers
    // Use lowercase headers for iflow provider to match iflow-cli expectations

    // For iflow, always generate a session-id if not provided (required for signature)
    if (isIflow || (context.sessionId && context.sessionId.length > 0)) {
      headers[isIflow ? "session-id" : "X-Session-ID"] =
        (context.sessionId && context.sessionId.length > 0) 
          ? context.sessionId 
          : `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
    if (context.conversationId && context.conversationId.length > 0) {
      headers[isIflow ? "conversation-id" : "X-Conversation-ID"] =
        context.conversationId;
    }

    // Add stream header if applicable
    // NOTE: iflow server REJECTS "Accept: text/event-stream" with 406!
    // It only accepts "Accept: application/json" or no Accept header.
    // For iflow, we use "Accept: application/json" regardless of streaming.
    // For other providers, use the correct Accept header.
    if (context.isStream) {
      headers["Accept"] = isIflow ? "application/json" : "text/event-stream";
    } else {
      headers["Accept"] = "application/json";
    }

    // Apply custom headers (override defaults)
    if (customHeaders) {
      Object.entries(customHeaders).forEach(([key, value]) => {
        if (value && value !== "undefined") {
          // Allow override, but use lowercase keys for iflow, preserve casing for others
          const keyLower = key.toLowerCase();
          // DO NOT override session-id or user-agent as they are used in signature
          // But do allow overriding x-client-version etc.
          // Actually, if they override user-agent here, the signature will be generated 
          // with the overridden user-agent. So it's safe to override!
          headers[isIflow ? keyLower : key] = value;
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

    // Deduplicate headers case-insensitively (fix for iflow 406 errors)
    const finalHeaders = this.deduplicateHeaders(headers);

    if (isIflow) {
      console.log(`[DIAGNOSTIC] buildRequestHeaders Result for ${provider}:`, JSON.stringify(finalHeaders, null, 2));
    }

    return finalHeaders;
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
