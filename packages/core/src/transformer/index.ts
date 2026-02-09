/**
 * Transformer Exports
 * Maintains backward compatibility while adding decoupled transformers
 */

// Legacy transformers (backward compatibility)
export { AnthropicTransformer } from "./anthropic.transformer";
export { GeminiTransformer } from "./gemini.transformer";
export { VertexGeminiTransformer } from "./vertex-gemini.transformer";
export { DeepseekTransformer } from "./deepseek.transformer";
export { TooluseTransformer } from "./tooluse.transformer";
export { OpenrouterTransformer } from "./openrouter.transformer";
export { MaxTokenTransformer } from "./maxtoken.transformer";
export { GroqTransformer } from "./groq.transformer";
export { CleancacheTransformer } from "./cleancache.transformer";
export { EnhanceToolTransformer } from "./enhancetool.transformer";
export { ReasoningTransformer } from "./reasoning.transformer";
export { SamplingTransformer } from "./sampling.transformer";
export { MaxCompletionTokens } from "./maxcompletiontokens.transformer";
export { VertexClaudeTransformer } from "./vertex-claude.transformer";
export { CerebrasTransformer } from "./cerebras.transformer";
export { StreamOptionsTransformer } from "./streamoptions.transformer";
export { OpenAITransformer } from "./openai.transformer";
export { CustomParamsTransformer } from "./customparams.transformer";
export { VercelTransformer } from "./vercel.transformer";
export { OpenAIResponsesTransformer } from "./openai.responses.transformer";
export { ForceReasoningTransformer } from "./forcereasoning.transformer";
export { ThinkingTransformer } from "./thinking.transformer";

// New decoupled transformers (Phase 3 Architecture)
export { OpenAIAuthProvider } from "./openai-auth.provider";
export { OpenAIRequestTransformer } from "./openai-request.transformer";
export { OpenAIResponseTransformer } from "./openai-response.transformer";
export { AnthropicAuthProvider } from "./anthropic-auth.provider";
export { AnthropicRequestTransformer } from "./anthropic-request.transformer";
export { AnthropicResponseTransformer } from "./anthropic-response.transformer";

// Legacy default export for backward compatibility
import { AnthropicTransformer } from "./anthropic.transformer";
import { GeminiTransformer } from "./gemini.transformer";
import { VertexGeminiTransformer } from "./vertex-gemini.transformer";
import { DeepseekTransformer } from "./deepseek.transformer";
import { TooluseTransformer } from "./tooluse.transformer";
import { OpenrouterTransformer } from "./openrouter.transformer";
import { MaxTokenTransformer } from "./maxtoken.transformer";
import { GroqTransformer } from "./groq.transformer";
import { CleancacheTransformer } from "./cleancache.transformer";
import { EnhanceToolTransformer } from "./enhancetool.transformer";
import { ReasoningTransformer } from "./reasoning.transformer";
import { SamplingTransformer } from "./sampling.transformer";
import { MaxCompletionTokens } from "./maxcompletiontokens.transformer";
import { VertexClaudeTransformer } from "./vertex-claude.transformer";
import { CerebrasTransformer } from "./cerebras.transformer";
import { StreamOptionsTransformer } from "./streamoptions.transformer";
import { OpenAITransformer } from "./openai.transformer";
import { CustomParamsTransformer } from "./customparams.transformer";
import { VercelTransformer } from "./vercel.transformer";
import { OpenAIResponsesTransformer } from "./openai.responses.transformer";
import { ForceReasoningTransformer } from "./forcereasoning.transformer";
import { ThinkingTransformer } from "./thinking.transformer";

export default {
  AnthropicTransformer,
  GeminiTransformer,
  VertexGeminiTransformer,
  VertexClaudeTransformer,
  DeepseekTransformer,
  TooluseTransformer,
  OpenrouterTransformer,
  OpenAITransformer,
  MaxTokenTransformer,
  GroqTransformer,
  CleancacheTransformer,
  EnhanceToolTransformer,
  ReasoningTransformer,
  SamplingTransformer,
  MaxCompletionTokens,
  CerebrasTransformer,
  StreamOptionsTransformer,
  CustomParamsTransformer,
  VercelTransformer,
  OpenAIResponsesTransformer,
  ForceReasoningTransformer,
  ThinkingTransformer,
};
