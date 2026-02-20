import crypto from "crypto";

export interface SignatureConfig {
  algorithm: "hmac-sha256" | "custom";
  fields: string[];
  headerName: string;
  timestampHeader: string;
  timestampWindow?: number;
}

export class RequestSigner {
  constructor(
    private apiKey: string,
    private config: SignatureConfig,
  ) {}

  sign(headers: Record<string, string>, body?: any): Record<string, string> {
    const timestampMs = Date.now();
    const timestamp = timestampMs.toString();
    
    // Create a copy of headers to avoid mutating the input
    // This is critical for parallel requests that might share header references
    const signedHeaders: Record<string, string> = { ...headers };
    
    // Ensure session-id header exists for iflow
    if (this.config.headerName === 'x-iflow-signature') {
      if (!signedHeaders['session-id']) {
        signedHeaders['session-id'] = '';
      }
    }
    
    const signature = this.generateSignature(signedHeaders, body, timestamp);

    return {
      ...signedHeaders,
      [this.config.headerName]: signature,
      [this.config.timestampHeader]: timestamp,
    };
  }

  private generateSignature(
    headers: Record<string, string>,
    body: any,
    timestamp: string,
  ): string {
    if (this.config.algorithm === "hmac-sha256") {
      // Standard HMAC-SHA256: fields joined with colons, timestamp appended
      // Format: "field1:field2:...:timestamp"
      const fieldValues = this.config.fields.map((field) => {
        const key = Object.keys(headers).find(
          (k) => k.toLowerCase() === field.toLowerCase()
        );
        return key ? headers[key] : "";
      });

      const data = [...fieldValues, timestamp].join(":");

      return crypto.createHmac("sha256", this.apiKey).update(data, "utf8").digest("hex");
    }

    // Custom algorithm - implement based on provider requirements
    return this.generateCustomSignature(headers, body, timestamp);
  }

  private generateCustomSignature(
    headers: Record<string, string>,
    body: any,
    timestamp: string,
  ): string {
    // iflow-cli compatible signature format
    // Format: "user-agent:session-id:timestamp" (exactly as iflow-cli)
    // apiKey is ONLY used as HMAC key, NOT in the data

    // For iflow, we use fixed fields: user-agent, session-id, and the timestamp
    // Use case-insensitive lookup for headers to be safe
    const findHeader = (name: string) => {
      const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    };

    const userAgent = findHeader("user-agent") || "iFlow-Cli";
    const sessionId = findHeader("session-id") || "";
    
    const data = `${userAgent}:${sessionId}:${timestamp}`;

    // Detailed diagnostic logging for iflow signature
    if (this.config.headerName === 'x-iflow-signature') {
      console.log(`[DIAGNOSTIC] iflow Signature Generation:`);
      console.log(`  - Data String: "${data}"`);
      console.log(`  - user-agent:  "${userAgent}"`);
      console.log(`  - session-id:  "${sessionId}"`);
      console.log(`  - timestamp:   "${timestamp}"`);
    }

    const signature = crypto.createHmac("sha256", this.apiKey).update(data, "utf8").digest("hex");
    
    if (this.config.headerName === 'x-iflow-signature') {
      console.log(`  - Signature:   "${signature.substring(0, 8)}..."`);
    }

    return signature;
  }

  verify(
    headers: Record<string, string>,
    body?: any,
    timestamp?: string,
    signature?: string,
  ): boolean {
    const ts = timestamp || headers[this.config.timestampHeader];
    const sig = signature || headers[this.config.headerName];

    if (!ts || !sig) {
      return false;
    }

    // Check timestamp window
    if (this.config.timestampWindow) {
      const now = Date.now();
      const requestTime = parseInt(ts, 10);
      if (
        isNaN(requestTime) ||
        Math.abs(now - requestTime) > this.config.timestampWindow * 1000
      ) {
        return false;
      }
    }

    const expectedSignature = this.generateSignature(headers, body, ts);
    return crypto.timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expectedSignature),
    );
  }
}

// Provider-specific signer configurations
export const PROVIDER_SIGNATURES: Record<string, SignatureConfig> = {
  iflow: {
    algorithm: "custom",
    fields: ["user-agent", "session-id"],
    headerName: "x-iflow-signature",
    timestampHeader: "x-iflow-timestamp",
    timestampWindow: 300, // 5 minutes
  },
};

// Get signer for a provider
export function getSignerForProvider(
  providerName: string,
  apiKey: string,
  providerType?: string
): RequestSigner | null {
  const name = providerName.toLowerCase();
  const type = providerType?.toLowerCase();
  
  const isIflow = name.startsWith('iflow') || type?.startsWith('iflow');
  const lookupKey = isIflow ? 'iflow' : (type || name);
    
  const config = PROVIDER_SIGNATURES[lookupKey];
  if (!config) {
    return null;
  }
  return new RequestSigner(apiKey, config);
}

// Check if provider requires signing
export function providerRequiresSigning(providerName: string, providerType?: string): boolean {
  const name = providerName.toLowerCase();
  const type = providerType?.toLowerCase();
  
  if (name.startsWith('iflow') || type?.startsWith('iflow')) {
    return true;
  }
    
  return (type || name) in PROVIDER_SIGNATURES;
}

export default RequestSigner;
