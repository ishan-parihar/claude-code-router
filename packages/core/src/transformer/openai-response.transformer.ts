/**
 * OpenAI Response Transformer
 * Transforms responses to/from OpenAI format
 */

import { ResponseTransformer } from "@/interfaces/response-transformer";

export class OpenAIResponseTransformer implements ResponseTransformer {
  name = "OpenAI";

  async transform(response: Response): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");

    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      return response;
    } else {
      const data = (await response.clone().json()) as any;
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
}
