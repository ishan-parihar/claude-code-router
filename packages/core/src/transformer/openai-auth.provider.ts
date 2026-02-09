/**
 * OpenAI Auth Provider
 * Handles authentication for OpenAI-compatible APIs
 */

import { AuthProvider, AuthResult } from "@/interfaces/auth-provider";
import { LLMProvider } from "@/types/llm";

export class OpenAIAuthProvider implements AuthProvider {
  name = "OpenAI";

  async authenticate(request: any, provider: LLMProvider): Promise<AuthResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
    };

    return {
      headers,
      body: request,
    };
  }
}
