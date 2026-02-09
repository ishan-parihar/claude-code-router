import { ChatCompletion } from "openai/resources";
import {
  LLMProvider,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
  MessageContent,
} from "@/types/llm";
import {
  Transformer,
  TransformerContext,
  TransformerOptions,
} from "@/types/transformer";
import { createApiError } from "@/api/middleware";

export class OpenAITransformer implements Transformer {
  name = "OpenAI";
  endPoint = "/v1/chat/completions";
  logger?: any;

  constructor(private readonly options?: TransformerOptions) {}

  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers: Record<string, string | undefined> = {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
    };

    return {
      body: request,
      config: {
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];
    const requestMessages = request.messages || [];

    requestMessages?.forEach((msg: any) => {
      if (msg.role === "system") {
        messages.push({
          role: "system",
          content: msg.content,
        });
        return;
      }

      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({
            role: "user",
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          const content: MessageContent[] = msg.content.map((part: any) => {
            if (part.type === "text") {
              return {
                type: "text",
                text: part.text,
              };
            } else if (part.type === "image_url") {
              return {
                type: "image_url",
                image_url: {
                  url: part.image_url.url,
                },
                media_type: part.image_url.detail || "image/jpeg",
              };
            }
            return part;
          });
          messages.push({
            role: "user",
            content: content,
          });
          return;
        }
      }

      if (msg.role === "assistant") {
        const assistantMessage: UnifiedMessage = {
          role: "assistant",
          content: msg.content || "",
        };

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          assistantMessage.tool_calls = msg.tool_calls.map((toolCall: any) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          }));
        }

        if (msg.reasoning_content) {
          assistantMessage.thinking = {
            content: msg.reasoning_content,
          };
        }

        messages.push(assistantMessage);
        return;
      }

      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
          tool_call_id: msg.tool_call_id,
        });
        return;
      }
    });

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertOpenAIToolsToUnified(request.tools)
        : undefined,
      tool_choice: this.convertOpenAIToolChoice(request.tool_choice),
    };

    if (request.reasoning_effort) {
      result.reasoning = {
        effort: request.reasoning_effort,
        enabled: true,
      };
    }

    return result;
  }

  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");

    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      return response;
    } else {
      const data = (await response.json()) as any;
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private convertOpenAIToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters,
      },
    }));
  }

  private convertOpenAIToolChoice(
    toolChoice: any
  ): UnifiedChatRequest["tool_choice"] {
    if (!toolChoice) {
      return undefined;
    }

    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
      return toolChoice;
    }

    if (typeof toolChoice === "object" && toolChoice.type === "function") {
      return {
        type: "function",
        function: { name: toolChoice.function.name },
      };
    }

    return toolChoice;
  }
}