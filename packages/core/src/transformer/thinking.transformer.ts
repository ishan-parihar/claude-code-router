import {
  Transformer,
  TransformerContext,
} from "@/types/transformer";
import {
  UnifiedChatRequest,
  ThinkLevel,
} from "@/types/llm";

/**
 * Model thinking configuration patterns based on iflow-cli implementation
 * Maps model name patterns to their thinking configuration formats
 */
interface ModelThinkingConfig {
  pattern: RegExp;
  configureThinking: (request: any, reasoning: any) => void;
  configureNonThinking: (request: any) => void;
}

/**
 * Reasoning level mapping from effort to reasoning_level
 */
const effortToReasoningLevel: Record<ThinkLevel, string> = {
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
};

/**
 * Model-specific thinking configurations
 * Based on iflow-cli's implementation
 */
const modelThinkingConfigs: ModelThinkingConfig[] = [
  // Claude models - use thinking object with enabled, max_tokens, reasoning_level
  {
    pattern: /^claude-3[-.]5-sonnet|^claude-4|^claude-opus-4/i,
    configureThinking: (request, reasoning) => {
      const maxTokens = reasoning.max_tokens || request.max_tokens || 8192;
      const reasoningLevel = reasoning.effort
        ? effortToReasoningLevel[reasoning.effort]
        : "medium";

      request.thinking = {
        enabled: true,
        max_tokens: maxTokens,
        reasoning_level: reasoningLevel,
      };

      // Remove reasoning fields that don't apply to Claude format
      delete request.reasoning;
    },
    configureNonThinking: (request) => {
      delete request.thinking;
      delete request.reasoning;
    },
  },

  // DeepSeek models - use reasoning + thinking_mode
  {
    pattern: /^deepseek/i,
    configureThinking: (request, reasoning) => {
      // Only enable if reasoning level is not "low"
      if (reasoning.effort !== "low") {
        request.reasoning = true;
      }
      request.thinking_mode = true;

      // Keep the original reasoning config for reference
      if (!request.reasoning_config) {
        request.reasoning_config = {};
      }
    },
    configureNonThinking: (request) => {
      delete request.reasoning;
      delete request.thinking_mode;
      delete request.reasoning_config;
    },
  },

  // GLM models - use chat_template_kwargs with enable_thinking
  {
    pattern: /^glm-4/i,
    configureThinking: (request, reasoning) => {
      request.chat_template_kwargs = {
        enable_thinking: true,
      };

      // GLM also supports reasoning field for some versions
      if (reasoning.effort !== "low") {
        request.reasoning = true;
      }
    },
    configureNonThinking: (request) => {
      delete request.chat_template_kwargs;
      delete request.reasoning;
    },
  },

  // OpenAI o1/o3 models - use reasoning boolean
  {
    pattern: /^o1|^o3/i,
    configureThinking: (request, reasoning) => {
      // o1/o3 only enable reasoning when effort is not "low"
      if (reasoning.effort !== "low") {
        request.reasoning = true;
      }
    },
    configureNonThinking: (request) => {
      delete request.reasoning;
    },
  },

  // MiniMax models - similar to DeepSeek
  {
    pattern: /^minimax/i,
    configureThinking: (request, reasoning) => {
      if (reasoning.effort !== "low") {
        request.reasoning = true;
      }
      request.thinking_mode = true;
    },
    configureNonThinking: (request) => {
      delete request.reasoning;
      delete request.thinking_mode;
    },
  },

  // Gemini models with thinking support
  {
    pattern: /^gemini-.*-thinking|^gemini-3-pro-high/i,
    configureThinking: (request, reasoning) => {
      // Gemini uses thinking_config with include_thoughts
      request.thinking_config = {
        include_thoughts: true,
      };

      // Also set reasoning if effort is medium or high
      if (reasoning.effort === "medium" || reasoning.effort === "high") {
        request.reasoning = true;
      }
    },
    configureNonThinking: (request) => {
      delete request.thinking_config;
      delete request.reasoning;
    },
  },
];

/**
 * Detect model type from model name and return appropriate config
 */
function getModelThinkingConfig(
  modelName: string
): ModelThinkingConfig | undefined {
  return modelThinkingConfigs.find((config) => config.pattern.test(modelName));
}

/**
 * Thinking Transformer
 *
 * Transforms the unified reasoning configuration into model-specific
 * thinking formats based on the target model type.
 *
 * Supports formats from iflow-cli:
 * - Claude: thinking: { enabled, max_tokens, reasoning_level }
 * - DeepSeek: reasoning: true + thinking_mode: true
 * - GLM: chat_template_kwargs: { enable_thinking: true }
 * - OpenAI o1/o3: reasoning: true
 * - MiniMax: reasoning: true + thinking_mode: true
 * - Gemini: thinking_config: { include_thoughts: true }
 */
export class ThinkingTransformer implements Transformer {
  name = "Thinking";

  async transformRequestIn(
    request: UnifiedChatRequest,
    _provider?: any,
    _context?: TransformerContext
  ): Promise<UnifiedChatRequest> {
    // Clone request to avoid mutations
    const transformedRequest = { ...request };

    // Get model name (handle provider,model format)
    const modelName = request.model.includes(",")
      ? request.model.split(",")[1]
      : request.model;

    // Check if reasoning is enabled
    const hasReasoning =
      request.reasoning?.enabled ||
      (request.reasoning?.effort && request.reasoning.effort !== "none");

    // Get model-specific configuration
    const modelConfig = getModelThinkingConfig(modelName);

    if (hasReasoning && modelConfig) {
      // Apply model-specific thinking configuration
      modelConfig.configureThinking(transformedRequest, request.reasoning);

      // Log the transformation for debugging
      console.log(
        `[ThinkingTransformer] Applied thinking config for model: ${modelName}`,
        {
          originalReasoning: request.reasoning,
          transformedFields: Object.keys(transformedRequest).filter(
            (key) =>
              key !== "messages" &&
              key !== "model" &&
              key !== "max_tokens" &&
              key !== "temperature" &&
              key !== "stream" &&
              key !== "tools" &&
              key !== "tool_choice"
          ),
        }
      );
    } else if (modelConfig) {
      // Ensure thinking is disabled for models that don't support it or when not requested
      modelConfig.configureNonThinking(transformedRequest);
    }

    return transformedRequest;
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    // This transformer is only for request input (provider-bound)
    // Pass through unchanged
    return request as UnifiedChatRequest;
  }
}

export default ThinkingTransformer;
