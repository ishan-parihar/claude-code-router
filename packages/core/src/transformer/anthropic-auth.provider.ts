/**
 * Anthropic Auth Provider
 * Handles authentication for Anthropic APIs
 */

import { AuthProvider, AuthResult } from "@/interfaces/auth-provider";
import { LLMProvider } from "@/types/llm";

export interface AnthropicAuthOptions {
  useBearer?: boolean;
}

export class AnthropicAuthProvider implements AuthProvider {
  name = "Anthropic";
  private useBearer: boolean;

  constructor(options?: AnthropicAuthOptions) {
    this.useBearer = options?.useBearer ?? false;
  }

  async authenticate(request: any, provider: LLMProvider): Promise<AuthResult> {
    const headers: Record<string, string> = {};

    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
    } else {
      headers["x-api-key"] = provider.apiKey;
    }

    return {
      headers,
      body: request,
    };
  }
}
