/**
 * Decoupled Transformer Service
 * New service architecture supporting separated concerns
 */

import { AuthProvider } from "@/interfaces/auth-provider";
import { RequestTransformer } from "@/interfaces/request-transformer";
import { ResponseTransformer } from "@/interfaces/response-transformer";
import { ConfigService } from "./config";

export interface TransformerComponents {
  authProvider?: AuthProvider;
  requestTransformer?: RequestTransformer;
  responseTransformer?: ResponseTransformer;
}

export class DecoupledTransformerService {
  private authProviders: Map<string, AuthProvider> = new Map();
  private requestTransformers: Map<string, RequestTransformer> = new Map();
  private responseTransformers: Map<string, ResponseTransformer> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: any
  ) {}

  /**
   * Register an auth provider
   */
  registerAuthProvider(provider: AuthProvider): void {
    this.authProviders.set(provider.name, provider);
    this.logger.info(`registered auth provider: ${provider.name}`);
  }

  /**
   * Register a request transformer
   */
  registerRequestTransformer(transformer: RequestTransformer): void {
    this.requestTransformers.set(transformer.name, transformer);
    this.logger.info(`registered request transformer: ${transformer.name}`);
  }

  /**
   * Register a response transformer
   */
  registerResponseTransformer(transformer: ResponseTransformer): void {
    this.responseTransformers.set(transformer.name, transformer);
    this.logger.info(`registered response transformer: ${transformer.name}`);
  }

  /**
   * Register all components for a provider
   */
  registerProvider(
    name: string,
    components: TransformerComponents
  ): void {
    if (components.authProvider) {
      this.registerAuthProvider(components.authProvider);
    }
    if (components.requestTransformer) {
      this.registerRequestTransformer(components.requestTransformer);
    }
    if (components.responseTransformer) {
      this.registerResponseTransformer(components.responseTransformer);
    }
    this.logger.info(`registered provider components: ${name}`);
  }

  /**
   * Get auth provider by name
   */
  getAuthProvider(name: string): AuthProvider | undefined {
    return this.authProviders.get(name);
  }

  /**
   * Get request transformer by name
   */
  getRequestTransformer(name: string): RequestTransformer | undefined {
    return this.requestTransformers.get(name);
  }

  /**
   * Get response transformer by name
   */
  getResponseTransformer(name: string): ResponseTransformer | undefined {
    return this.responseTransformers.get(name);
  }

  /**
   * Get all components for a provider
   */
  getProviderComponents(name: string): TransformerComponents {
    return {
      authProvider: this.authProviders.get(name),
      requestTransformer: this.requestTransformers.get(name),
      responseTransformer: this.responseTransformers.get(name),
    };
  }

  /**
   * Check if provider is registered
   */
  hasProvider(name: string): boolean {
    return (
      this.authProviders.has(name) ||
      this.requestTransformers.has(name) ||
      this.responseTransformers.has(name)
    );
  }

  /**
   * Get all registered provider names
   */
  getRegisteredProviders(): string[] {
    const providers = new Set<string>();
    this.authProviders.forEach((_, name) => providers.add(name));
    this.requestTransformers.forEach((_, name) => providers.add(name));
    this.responseTransformers.forEach((_, name) => providers.add(name));
    return Array.from(providers);
  }

  /**
   * Initialize with default providers
   */
  async initialize(): Promise<void> {
    this.logger.info("initializing decoupled transformer service");
    
    // Import and register decoupled transformers
    const { OpenAIAuthProvider } = await import("@/transformer/openai-auth.provider");
    const { OpenAIRequestTransformer } = await import("@/transformer/openai-request.transformer");
    const { OpenAIResponseTransformer } = await import("@/transformer/openai-response.transformer");
    const { AnthropicAuthProvider } = await import("@/transformer/anthropic-auth.provider");
    const { AnthropicRequestTransformer } = await import("@/transformer/anthropic-request.transformer");
    const { AnthropicResponseTransformer } = await import("@/transformer/anthropic-response.transformer");

    // Register OpenAI components
    this.registerProvider("OpenAI", {
      authProvider: new OpenAIAuthProvider(),
      requestTransformer: new OpenAIRequestTransformer(),
      responseTransformer: new OpenAIResponseTransformer(),
    });

    // Register Anthropic components
    this.registerProvider("Anthropic", {
      authProvider: new AnthropicAuthProvider(),
      requestTransformer: new AnthropicRequestTransformer(),
      responseTransformer: new AnthropicResponseTransformer(this.logger),
    });

    this.logger.info("decoupled transformer service initialized");
  }
}
