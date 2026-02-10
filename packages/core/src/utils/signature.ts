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
    
    // Ensure session-id header exists for iflow
    if (this.config.headerName === 'x-iflow-signature') {
      if (!headers['session-id']) {
        headers['session-id'] = '';
      }
    }
    
    const signature = this.generateSignature(headers, body, timestamp);

    return {
      ...headers,
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
    const fieldValues = this.config.fields.map((field) => {
      const key = Object.keys(headers).find(
        (k) => k.toLowerCase() === field.toLowerCase()
      );
      return key ? headers[key] : "";
    });

    const data = [...fieldValues, timestamp].join(":");
    
    // Debug logging for iflow signature
    if (this.config.headerName === 'x-iflow-signature') {
      console.log(`[Signature Debug] Generating signature for iflow:`);
      console.log(`[Signature Debug] Data: "${data}"`);
      console.log(`[Signature Debug] Timestamp: ${timestamp}`);
      console.log(`[Signature Debug] Fields: ${JSON.stringify(fieldValues)}`);
      console.log(`[Signature Debug] Headers keys: ${Object.keys(headers).join(', ')}`);
    }

    return crypto.createHmac("sha256", this.apiKey).update(data, "utf8").digest("hex");
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
  const lookupKey = providerType 
    ? providerType.toLowerCase() 
    : providerName.toLowerCase();
    
  const config = PROVIDER_SIGNATURES[lookupKey];
  if (!config) {
    return null;
  }
  return new RequestSigner(apiKey, config);
}

// Check if provider requires signing
export function providerRequiresSigning(providerName: string, providerType?: string): boolean {
  const lookupKey = providerType 
    ? providerType.toLowerCase() 
    : providerName.toLowerCase();
    
  return lookupKey in PROVIDER_SIGNATURES;
}

export default RequestSigner;
