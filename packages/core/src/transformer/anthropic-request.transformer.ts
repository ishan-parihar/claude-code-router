/**
 * Anthropic Request Transformer
 * Transforms requests from Anthropic format to unified format
 */

import { RequestTransformer } from "@/interfaces/request-transformer";
import {
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from "@/types/llm";
import { formatBase64 } from "@/utils/image";
import { getThinkLevel } from "@/utils/thinking";

export class AnthropicRequestTransformer implements RequestTransformer {
  name = "Anthropic";

  async transformOut(request: Record<string, any>): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => ({
            type: "text" as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({
          role: "system",
          content: textParts,
        });
      }
    }

    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    requestMessages?.forEach((msg: any) => {
      if (msg.role === "user" || msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          if (msg.role === "user") {
            const toolParts = msg.content.filter(
              (c: any) => c.type === "tool_result" && c.tool_use_id
            );
            if (toolParts.length) {
              toolParts.forEach((tool: any) => {
                const toolMessage: UnifiedMessage = {
                  role: "tool",
                  content:
                    typeof tool.content === "string"
                      ? tool.content
                      : JSON.stringify(tool.content),
                  tool_call_id: tool.tool_use_id,
                  cache_control: tool.cache_control,
                };
                messages.push(toolMessage);
              });
            }

            const textAndMediaParts = msg.content.filter(
              (c: any) =>
                (c.type === "text" && c.text) ||
                (c.type === "image" && c.source)
            );
            if (textAndMediaParts.length) {
              messages.push({
                role: "user",
                content: textAndMediaParts.map((part: any) => {
                  if (part?.type === "image") {
                    return {
                      type: "image_url",
                      image_url: {
                        url:
                          part.source?.type === "base64"
                            ? formatBase64(
                                part.source.data,
                                part.source.media_type
                              )
                            : part.source.url,
                      },
                      media_type: part.source.media_type,
                    };
                  }
                  return part;
                }),
              });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            if (textParts.length) {
              assistantMessage.content = textParts
                .map((text: any) => text.text)
                .join("\n");
            }

            const toolCallParts = msg.content.filter(
              (c: any) => c.type === "tool_use" && c.id
            );
            if (toolCallParts.length) {
              assistantMessage.tool_calls = toolCallParts.map((tool: any) => {
                return {
                  id: tool.id,
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input || {}),
                  },
                };
              });
            }

            const thinkingPart = msg.content.find(
              (c: any) => c.type === "thinking"
            );
            if (thinkingPart) {
              assistantMessage.thinking = {
                content: thinkingPart.thinking || "",
                signature: thinkingPart.signature,
              };
            }

            messages.push(assistantMessage);
          }
          return;
        }
      }
    });

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertAnthropicToolsToUnified(request.tools)
        : undefined,
      tool_choice: request.tool_choice,
    };
    if (request.thinking) {
      result.reasoning = {
        effort: getThinkLevel(request.thinking.budget_tokens),
        max_tokens: request.thinking.budget_tokens,
        enabled: request.thinking.type === "enabled",
      };
    }
    if (request.tool_choice) {
      if (request.tool_choice.type === "tool") {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }
    return result;
  }

  async transformIn(request: any): Promise<any> {
    // Transform from unified format back to Anthropic format if needed
    return request;
  }

  private convertAnthropicToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema,
      },
    }));
  }
}
