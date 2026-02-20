import { ProxyAgent } from "undici";
import { UnifiedChatRequest } from "../types/llm";

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  context: any,
  logger?: any
): Promise<Response> {
  const isIflow = config.headers?.["user-agent"]?.startsWith("iFlow-Cli") || 
                  config.headers?.["x-client-type"] === "iflow-cli";
  
  // Use a plain object for iflow to preserve header casing exactly as specified.
  // The Headers constructor in Node.js (undici) might normalize keys to title-case.
  let headers: Headers | Record<string, string>;
  
  if (isIflow) {
    // For iflow, we must be extremely careful with casing and avoid duplicates.
    // HeaderManager already provides most headers with correct casing.
    headers = {};
    if (config.headers) {
      const deduplicatedHeaders = deduplicateHeadersCaseInsensitive(config.headers);
      Object.entries(deduplicatedHeaders).forEach(([key, value]) => {
        if (value) {
          headers[key] = value as string;
        }
      });
    }
    // Ensure Content-Type is set with Title-Case if not already present
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    console.log(`[DIAGNOSTIC] sendUnifiedRequest Final Headers for iflow:`, JSON.stringify(headers, null, 2));
  } else {
    const defaultHeaders = { "Content-Type": "application/json" };
    headers = new Headers(defaultHeaders);
    if (config.headers) {
      const deduplicatedHeaders = deduplicateHeadersCaseInsensitive(config.headers);
      Object.entries(deduplicatedHeaders).forEach(([key, value]) => {
        if (value) {
          (headers as Headers).set(key, value as string);
        }
      });
    }
  }
  
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }
  
  // Debug log for iflow to verify final headers on the wire
  if (isIflow) {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const logPath = path.join(os.homedir(), '.claude-code-router', 'iflow-final-headers.log');
      const debugHeaders = headers instanceof Headers 
        ? Object.fromEntries(headers.entries())
        : headers;
      const debugInfo = {
        timestamp: new Date().toISOString(),
        url: typeof url === "string" ? url : url.toString(),
        headers: debugHeaders
      };
      fs.appendFileSync(logPath, JSON.stringify(debugInfo) + '\n');
    } catch (e) {
      // ignore
    }
  }

  const loggedHeaders = headers instanceof Headers 
    ? Object.fromEntries(headers.entries())
    : headers;

  logger?.debug(
    {
      reqId: context.req.id,
      request: fetchOptions,
      headers: loggedHeaders,
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );
  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions);
}

function deduplicateHeadersCaseInsensitive(headers: Record<string, string>): Record<string, string> {
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
