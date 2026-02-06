import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@CCR/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";
import { ModelSelector } from "../services/model-selector";
import { requestTracker } from "./request-tracker";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");

  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return { model: `${finalProvider.name},${finalModel}`, scenarioType: 'default' };
    }
    return { model: req.body.model, scenarioType: 'default' };
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = Router?.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if ((lastUsageThreshold || tokenCountThreshold) && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return { model: Router.longContext, scenarioType: 'longContext' };
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return { model: model[1], scenarioType: 'default' };
    }
  }
  // Use the background model for any Claude Haiku variant
  const globalRouter = configService.get("Router");
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    globalRouter?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return { model: globalRouter.background, scenarioType: 'background' };
  }
  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    return { model: Router.webSearch, scenarioType: 'webSearch' };
  }
  // if exits thinking, use the think model
  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return { model: Router.think, scenarioType: 'think' };
  }
  return { model: Router?.default, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  modelPoolManager?: any;
  modelSelector?: ModelSelector;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'longContext' | 'webSearch';

export interface RouterFallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event, modelPoolManager, modelSelector } = context;

  // Extract priority from request header (set by UI)
  const priority = req.headers['x-ccr-priority']
    ? parseInt(req.headers['x-ccr-priority'] as string)
    : 0;
  req.priority = priority;

  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }

  // Generate request ID and start tracking
  const requestId = requestTracker.generateRequestId();
  req.requestId = requestId;
  requestTracker.startRequest(requestId, req.sessionId, priority);

  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Handle custom-model identifier
    const isCustomModel = req.body.model === "custom-model";

    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    let model;
    let alternatives: Array<{ provider: string; model: string }> = [];
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");

    if (isCustomModel) {
      // For custom-model, use dynamic model selection with ModelSelector
      const Router = configService.get("Router");
      if (!Router?.default) {
        throw new Error("Router.default not configured for custom-model");
      }

      req.isCustomModel = true;
      req.scenarioType = 'default';

      // Build failover alternatives from configuration
      alternatives = buildFailoverAlternatives(configService, Router.default);

      // Use ModelSelector to dynamically select the best model
      if (modelSelector && modelPoolManager) {
        requestTracker.startStage(requestId, 'model_selection');

        const selectionResult = modelSelector.selectModel(
          Router.default,
          alternatives,
          'default',
          priority
        );

        if (selectionResult.selected) {
          model = `${selectionResult.selected.provider},${selectionResult.selected.model}`;
          req.provider = selectionResult.selected.provider;
          req.model = selectionResult.selected.model;
          req.shouldParallelExecute = selectionResult.shouldParallelExecute;
          req.parallelCandidates = selectionResult.parallelCandidates;
          req.alternatives = alternatives;

          requestTracker.recordRouting(
            requestId,
            req.provider,
            req.model,
            'default'
          );

          req.log.info(
            `custom-model dynamically selected: ${model} ` +
            `(score: ${selectionResult.selected.score}, ` +
            `parallel: ${selectionResult.shouldParallelExecute}, ` +
            `alternatives: ${selectionResult.parallelCandidates.length})`
          );
        } else {
          // No available models, use Router.default anyway
          model = Router.default;
          const [resolvedProvider, ...resolvedModel] = model.split(",");
          req.provider = resolvedProvider;
          req.model = resolvedModel.join(",");
          req.alternatives = alternatives;

          requestTracker.recordRouting(
            requestId,
            req.provider,
            req.model,
            'default'
          );

          req.log.warn(
            `custom-model: No available models, using Router.default: ${model} ` +
            `(reason: ${selectionResult.reason})`
          );
        }
      } else {
        // Fallback to default if ModelSelector not available
        model = Router.default;
        const [resolvedProvider, ...resolvedModel] = model.split(",");
        req.provider = resolvedProvider;
        req.model = resolvedModel.join(",");
        req.alternatives = alternatives;

        requestTracker.recordRouting(
          requestId,
          req.provider,
          req.model,
          'default'
        );

        req.log.info(`custom-model resolved to Router.default: ${model}`);
      }
    } else if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount;
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }

    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage);
      model = result.model;
      req.scenarioType = result.scenarioType;

      // Parse model to set provider
      const [resolvedProvider, ...resolvedModel] = model.split(",");
      req.provider = resolvedProvider;
      req.model = resolvedModel.join(",");

      // Build alternatives for non-custom-model scenarios (for queue handling)
      alternatives = buildFailoverAlternatives(configService, model);
      req.alternatives = alternatives;

      requestTracker.recordRouting(
        requestId,
        req.provider,
        req.model,
        req.scenarioType
      );
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      if (!req.scenarioType) {
        req.scenarioType = 'default';
      }

      // Parse model to set provider if not already set
      if (!req.provider) {
        const [resolvedProvider, ...resolvedModel] = model.split(",");
        req.provider = resolvedProvider;
        req.model = resolvedModel.join(",");
        alternatives = buildFailoverAlternatives(configService, model);
        req.alternatives = alternatives;

        requestTracker.recordRouting(
          requestId,
          req.provider,
          req.model,
          req.scenarioType
        );
      }
    }

    req.body.model = model;
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const Router = configService.get("Router");
    req.body.model = Router?.default;
    req.scenarioType = 'default';

    const [resolvedProvider, ...resolvedModel] = req.body.model.split(",");
    req.provider = resolvedProvider;
    req.model = resolvedModel.join(",");
  }
  return;
};

/**
 * Build list of failover alternatives for a given provider+model
 */
function buildFailoverAlternatives(
  configService: ConfigService,
  model: string
): Array<{ provider: string; model: string }> {
  const failoverConfig = configService.get<any>('failover');
  const alternatives: Array<{ provider: string; model: string }> = [];

  if (!failoverConfig) {
    return alternatives;
  }

  const [provider, modelName] = model.split(',');

  // Add provider-specific alternatives
  if (provider && failoverConfig[provider]) {
    const providerAlternatives = failoverConfig[provider];
    if (Array.isArray(providerAlternatives)) {
      providerAlternatives.forEach((alt: any) => {
        if (typeof alt === 'string') {
          alternatives.push({ provider: alt, model: modelName });
        } else if (alt.provider && alt.model) {
          alternatives.push({ provider: alt.provider, model: alt.model });
        }
      });
    }
  }

  // Add global alternatives
  if (failoverConfig.global && Array.isArray(failoverConfig.global)) {
    failoverConfig.global.forEach((alt: any) => {
      if (typeof alt === 'string') {
        alternatives.push({ provider: alt, model: modelName });
      } else if (alt.provider && alt.model) {
        alternatives.push({ provider: alt.provider, model: alt.model });
      }
    });
  }

  return alternatives;
}

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};
