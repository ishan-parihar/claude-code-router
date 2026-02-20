import crypto from "crypto";
import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { createApiError } from "./middleware";
import { version } from "../../package.json";
import { HeaderManager } from "@/utils/headers";
import { getSignerForProvider, providerRequiresSigning } from "@/utils/signature";
import {
  ProviderErrorHandler,
  createProviderErrorHandler,
  ProviderError,
} from "@/utils/errors";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import { ModelPoolManager } from "@/services/model-pool-manager";
import { QueuedRequest } from "@/services/model-pool-manager";
import { EndpointGroupManager } from "@/services/endpoint-group-manager";
import { requestTracker } from "@/utils/request-tracker";
import { metricsCollector, RequestMetrics } from "@/services/metrics";
import { SSEStreamManager, readWithTimeout } from "@/utils/sse-stream-manager";

declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
    modelPoolManager: ModelPoolManager;
    modelSelector: any;
    endpointGroupManager: EndpointGroupManager;
  }

  interface FastifyRequest {
    provider?: string;
    model?: string;
    priority?: number;
    needsQueue?: boolean;
    queueModel?: string;
    isCustomModel?: boolean;
    scenarioType?: string;
    sessionId?: string;
    resolvedModel?: string;
    requestId?: string;
    shouldParallelExecute?: boolean;
    parallelCandidates?: Array<{ provider: string; model: string }>;
    alternatives?: Array<{ provider: string; model: string }>;
  }
}

// Error handler for provider-specific error handling with retry
const errorHandler = createProviderErrorHandler({
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
});

/**
 * Execute request with retry logic for provider-specific errors
 */
async function executeWithRetry<T>(
  provider: string,
  operation: () => Promise<T>,
  onError?: (error: any, attempt: number) => void
): Promise<T> {
  return errorHandler.executeWithRetry(provider, operation, onError);
}

async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  const requestId = req.requestId || 'unknown';
  const startTime = Date.now();

  // Record metrics start
  metricsCollector.recordStart(requestId, req.provider || 'unknown', req.model || body.model, {
    endpoint: transformer?.endPoint,
    isStream: body.stream === true,
    scenarioType: req.scenarioType,
  });

  req.log.info(
    `[Routes] Request started (requestId: ${requestId}, provider: ${req.provider}, model: ${req.model}, stream: ${body.stream === true})`
  );

  try {
    // Check if we should use proactive parallel execution
    if (req.shouldParallelExecute && req.parallelCandidates && req.parallelCandidates.length > 0) {
      req.log.info(
        `[Routes] Using proactive parallel execution for ${req.provider},${req.model} (requestId: ${requestId}, parallelCount: ${req.parallelCandidates.length})`
      );

      const result = await tryProactiveParallel(
        req,
        reply,
        fastify,
        transformer,
        req.parallelCandidates
      );

      if (result) {
        metricsCollector.recordComplete(requestId);
        req.log.info(
          `[Routes] Request completed via parallel execution (requestId: ${requestId}, duration: ${Date.now() - startTime}ms)`
        );
        requestTracker.completeRequest(requestId, true, 200);
        return result;
      }
    }

    // Normal single-path execution with unified slot management
    const result = await handleSinglePath(
      req,
      reply,
      fastify,
      transformer
    );

    metricsCollector.recordComplete(requestId);
    req.log.info(
      `[Routes] Request completed successfully (requestId: ${requestId}, duration: ${Date.now() - startTime}ms)`
    );
    requestTracker.completeRequest(requestId, true, 200);
    return result;
  } catch (error: any) {
    const errorCode = error.code || error.statusCode?.toString() || 'unknown';
    const errorMessage = error.message || 'Unknown error';

    req.log.error(
      `[Routes] Request failed (requestId: ${requestId}, error: ${errorMessage}, statusCode: ${error.statusCode}, code: ${errorCode})`
    );

    metricsCollector.recordError(requestId, errorCode, errorMessage);
    requestTracker.completeRequest(requestId, false, error.statusCode, errorMessage);

    // Try failover if applicable
    if (shouldAttemptFailover(req, error)) {
      req.log.warn(
        `[Routes] Attempting failover for failed request (requestId: ${requestId})`
      );
      const fallbackResult = await handleFallback(req, reply, fastify, transformer, error, 'error');
      if (fallbackResult) {
        // Update metrics to reflect successful failover
        const metric = metricsCollector.getMetric(requestId);
        if (metric) {
          metric.success = true;
          metric.errorCode = undefined;
          metric.errorMessage = undefined;
        }
        req.log.info(
          `[Routes] Failover succeeded (requestId: ${requestId})`
        );
        requestTracker.completeRequest(requestId, true, 200);
        return fallbackResult;
      }
    }

    throw error;
  }
}

async function handleSinglePath(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
): Promise<any> {
  const body = req.body as any;
  const requestId = req.requestId || 'unknown';
  const pathStartTime = Date.now();

  req.log.debug(
    `[Routes] Starting single path execution (requestId: ${requestId}, provider: ${req.provider}, model: ${body.model})`
  );

  const provider = fastify.providerService.getProviderForRequest(req.provider!);
  if (!provider) {
    req.log.error(
      `[Routes] Provider not found (requestId: ${requestId}, provider: ${req.provider})`
    );
    throw createApiError(
      `Provider '${req.provider}' not found`,
      404,
      "provider_not_found"
    );
  }

  req.log.debug(
    `[Routes] Provider resolved (requestId: ${requestId}, baseUrl: ${provider.baseUrl})`
  );

  // Unified slot management - only check provider+model capacity
  const slotReserved = await reserveSlotWithRetry(
    fastify,
    req.provider!,
    body.model,
    requestId,
    req.priority || 0
  );

  if (!slotReserved) {
    // No capacity, queue the request
    req.log.info(
      `[Routes] No provider capacity, queuing request for ${req.provider},${body.model} (requestId: ${requestId})`
    );

    const queueResult = await handleQueuedRequest(
      req,
      reply,
      fastify,
      transformer
    );

    return queueResult;
  }

  requestTracker.recordSlotReservation(
    requestId,
    req.provider!,
    body.model,
    true,
    true
  );

  try {
    // Process request
    requestTracker.recordApiCallStart(requestId, req.provider!, body.model);

    req.log.debug(
      `[Routes] Processing request transformers (requestId: ${requestId}, transformer: ${transformer?.name || 'none'})`
    );

    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      { req }
    );

    req.log.debug(
      `[Routes] Request transformers completed (requestId: ${requestId}, bypass: ${bypass})`
    );

    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      { req }
    );

    req.log.debug(
      `[Routes] Provider response received (requestId: ${requestId}, status: ${response.status})`
    );

    const finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      { req }
    );

    requestTracker.recordApiCallComplete(requestId, true, response.status);

    // Mark success and release slot
    fastify.modelPoolManager.markSuccess(req.provider!, body.model);
    fastify.modelPoolManager.releaseSlot(req.provider!, body.model, true);

    req.log.debug(
      `[Routes] Single path completed successfully (requestId: ${requestId}, duration: ${Date.now() - pathStartTime}ms)`
    );

    return await formatResponse(
      finalResponse,
      reply,
      body,
      req.log,
      fastify.configService.getAll(),
      req.scenarioType,
      {
        originalRequest: body,
        provider: req.provider,
        sendRequestFn: async () => {
          const retryResponse = await sendRequestToProvider(
            body,
            {},
            fastify.providerService.getProviderForRequest(req.provider!),
            fastify,
            false,
            transformer,
            { req }
          );
          if (!retryResponse.ok) {
            throw new Error(`Retry request failed: ${retryResponse.status}`);
          }
          return retryResponse;
        }
      }
    );
  } catch (error: any) {
    // Handle rate limits
    if (isRateLimitError(error)) {
      const retryAfter = error.headers?.['retry-after']
        ? parseInt(error.headers['retry-after']) * 1000
        : undefined;
      fastify.modelPoolManager.markRateLimit(req.provider!, body.model, retryAfter);
    }

    // Mark failure and release slot
    fastify.modelPoolManager.markFailure(req.provider!, body.model);
    fastify.modelPoolManager.releaseSlot(req.provider!, body.model, false);

    requestTracker.recordApiCallComplete(
      requestId,
      false,
      error.statusCode || 500,
      error.message
    );

    throw error;
  }
}

async function reserveSlotWithRetry(
  fastify: FastifyInstance,
  provider: string,
  model: string,
  requestId: string,
  priority: number
): Promise<boolean> {
  const isRateLimited = fastify.modelPoolManager.isRateLimited(provider, model);
  const isCircuitOpen = fastify.modelPoolManager.isCircuitBreakerOpen(provider, model);

  if (isRateLimited || isCircuitOpen) {
    return false;
  }

  const reservationId = fastify.modelPoolManager.reserveSlot(
    provider,
    model,
    30000,
    requestId
  );

  if (reservationId === false || !reservationId) {
    return false;
  }

  fastify.modelPoolManager.confirmSlot(provider, model, reservationId as string);

  return true;
}

async function handleEndpointQueuedRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  endpoint: string
): Promise<any> {
  const body = req.body as any;
  const requestId = req.requestId || 'unknown';

  requestTracker.recordQueueEnqueue(requestId, req.provider!, body.model);

  // Get the preferred provider from the endpoint group
  const preferredProvider = fastify.endpointGroupManager.selectProvider(endpoint, req.provider);

  // Reserve an endpoint slot for the queued request
  const endpointSlotReserved = fastify.endpointGroupManager.reserveSlot(
    endpoint,
    30000,
    `${requestId}-endpoint-queue`
  ) as string;

  if (!endpointSlotReserved) {
    // Cannot even queue, throw error
    throw createApiError(
      `No capacity and queue full for endpoint ${endpoint}`,
      503,
      "no_capacity"
    );
  }

  try {
    // Define the processing callback
    const onProcess = async (queuedRequest: any) => {
      const dequeuedRequestId = req.requestId || 'unknown';

      requestTracker.recordQueueDequeue(dequeuedRequestId);

      // Confirm the endpoint reservation to convert it to an active request
      fastify.endpointGroupManager.confirmSlot(endpoint, `${requestId}-endpoint-queue`);

      // Select the best provider for this endpoint
      const selectedProviderName = fastify.endpointGroupManager.selectProvider(endpoint, preferredProvider);
      if (!selectedProviderName) {
        fastify.endpointGroupManager.releaseSlot(endpoint, false);
        reply.code(503).send({ error: 'No available providers for endpoint' });
        return;
      }

      // Update the request to use the selected provider
      req.provider = selectedProviderName;

      try {
        const provider = fastify.providerService.getProviderForRequest(selectedProviderName);
        if (!provider) {
          throw createApiError(
            `Provider '${selectedProviderName}' not found`,
            404,
            "provider_not_found"
          );
        }

        // Reserve provider slot
        const providerSlotReserved = await reserveSlotWithRetry(
          fastify,
          selectedProviderName,
          body.model,
          requestId,
          req.priority || 0
        );

        if (!providerSlotReserved) {
          fastify.endpointGroupManager.releaseSlot(endpoint, false);
          reply.code(503).send({ error: 'No provider capacity' });
          return;
        }

        const { requestBody, config, bypass } = await processRequestTransformers(
          body,
          provider,
          transformer,
          req.headers,
          { req }
        );

        const response = await sendRequestToProvider(
          requestBody,
          config,
          provider,
          fastify,
          bypass,
          transformer,
          { req }
        );

        const finalResponse = await processResponseTransformers(
          requestBody,
          response,
          provider,
          transformer,
          bypass,
          { req }
        );

        await formatResponse(
          finalResponse,
          reply,
          body,
          req.log,
          fastify.configService.getAll(),
          req.scenarioType,
          {
            originalRequest: body,
            provider: selectedProviderName,
            sendRequestFn: async () => {
              const retryResponse = await sendRequestToProvider(
                body,
                {},
                fastify.providerService.getProviderForRequest(selectedProviderName),
                fastify,
                false,
                transformer,
                { req }
              );
              if (!retryResponse.ok) {
                throw new Error(`Retry request failed: ${retryResponse.status}`);
              }
              return retryResponse;
            }
          }
        );

        fastify.modelPoolManager.markSuccess(selectedProviderName, body.model);
        fastify.modelPoolManager.releaseSlot(selectedProviderName, body.model, true);
        fastify.endpointGroupManager.releaseSlot(endpoint, true);
      } catch (error: any) {
        if (isRateLimitError(error)) {
          const retryAfter = error.headers?.['retry-after']
            ? parseInt(error.headers['retry-after']) * 1000
            : undefined;
          fastify.modelPoolManager.markRateLimit(selectedProviderName, body.model, retryAfter);
          fastify.endpointGroupManager.markRateLimit(endpoint, retryAfter);
        }

        fastify.modelPoolManager.markFailure(selectedProviderName, body.model);
        fastify.modelPoolManager.releaseSlot(selectedProviderName, body.model, false);
        fastify.endpointGroupManager.releaseSlot(endpoint, false);

        reply.code(error.statusCode || 500).send({ error: error.message });
      }
    };

    // Enqueue the request at the endpoint level
    await fastify.endpointGroupManager.enqueueRequest(
      endpoint,
      req,
      reply,
      transformer,
      req.priority || 0,
      onProcess,
      preferredProvider
    );

    // Return early - the request will be processed when dequeued
    return reply.send({ message: 'Request queued' });
  } catch (queueError: any) {
    // Release the endpoint reservation if enqueue failed
    fastify.endpointGroupManager.releaseReservation(endpoint, `${requestId}-endpoint-queue`);

    throw createApiError(
      `Queue error: ${queueError.message}`,
      503,
      "queue_error"
    );
  }
}

async function handleQueuedRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
): Promise<any> {
  const body = req.body as any;
  const requestId = req.requestId || 'unknown';

  requestTracker.recordQueueEnqueue(requestId, req.provider!, body.model);

  // Reserve a slot for the queued request
  const queueSlotReserved = fastify.modelPoolManager.reserveSlot(
    req.provider!,
    body.model,
    30000,
    `${requestId}-queue`
  ) as string;

  if (!queueSlotReserved) {
    // Cannot even queue, throw error
    throw createApiError(
      `No capacity and queue full for ${req.provider},${body.model}`,
      503,
      "no_capacity"
    );
  }

  try {
    // Define the processing callback
    const onProcess = async (queuedRequest: QueuedRequest) => {
      const dequeuedRequestId = req.requestId || 'unknown';

      requestTracker.recordQueueDequeue(dequeuedRequestId);

      // Confirm the queue reservation to convert it to an active request
      fastify.modelPoolManager.confirmSlot(req.provider!, body.model, `${requestId}-queue`);

      try {
        const provider = fastify.providerService.getProviderForRequest(req.provider!);

        const { requestBody, config, bypass } = await processRequestTransformers(
          body,
          provider,
          transformer,
          req.headers,
          { req }
        );

        const response = await sendRequestToProvider(
          requestBody,
          config,
          provider,
          fastify,
          bypass,
          transformer,
          { req }
        );

        const finalResponse = await processResponseTransformers(
          requestBody,
          response,
          provider,
          transformer,
          bypass,
          { req }
        );

        await formatResponse(
          finalResponse,
          reply,
          body,
          req.log,
          fastify.configService.getAll(),
          req.scenarioType,
          {
            originalRequest: body,
            provider: req.provider,
            sendRequestFn: async () => {
              const retryResponse = await sendRequestToProvider(
                body,
                {},
                fastify.providerService.getProviderForRequest(req.provider!),
                fastify,
                false,
                transformer,
                { req }
              );
              if (!retryResponse.ok) {
                throw new Error(`Retry request failed: ${retryResponse.status}`);
              }
              return retryResponse;
            }
          }
        );

        fastify.modelPoolManager.markSuccess(req.provider!, body.model);
        fastify.modelPoolManager.releaseSlot(req.provider!, body.model, true);
      } catch (error: any) {
        if (isRateLimitError(error)) {
          const retryAfter = error.headers?.['retry-after']
            ? parseInt(error.headers['retry-after']) * 1000
            : undefined;
          fastify.modelPoolManager.markRateLimit(req.provider!, body.model, retryAfter);
        }

        fastify.modelPoolManager.markFailure(req.provider!, body.model);
        fastify.modelPoolManager.releaseSlot(req.provider!, body.model, false);

        reply.code(error.statusCode || 500).send({ error: error.message });
      }
    };

    // Enqueue the request
    await fastify.modelPoolManager.enqueueRequest(
      req.provider!,
      body.model,
      req,
      reply,
      transformer,
      req.priority || 0,
      onProcess
    );

    // Return early - the request will be processed when dequeued
    // The queue reservation will be confirmed and used in onProcess callback
    return reply.send({ message: 'Request queued' });
  } catch (queueError: any) {
    // Release the queue reservation if enqueue failed
    fastify.modelPoolManager.releaseReservation(req.provider!, body.model, `${requestId}-queue`);

    throw createApiError(
      `Queue error: ${queueError.message}`,
      503,
      "queue_error"
    );
  }
}

async function tryProactiveParallel(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  parallelCandidates: Array<{ provider: string; model: string }>
): Promise<any> {
  const requestId = req.requestId || 'unknown';
  const controller = new AbortController();

  // Include the primary model in the parallel execution
  const allCandidates = [
    { provider: req.provider!, model: (req.body as any).model, isPrimary: true },
    ...parallelCandidates.map(c => ({ ...c, isPrimary: false }))
  ];

req.log.info(
        `[Routes] Starting proactive parallel execution (requestId: ${requestId}, totalCandidates: ${allCandidates.length})`
      );

  const promises = allCandidates.map(async (candidate) => {
    let slotReserved = false;
    const reservationId = `${requestId}-${candidate.provider}-${candidate.model}`;

    try {
      // Reserve slot
      if (fastify.modelPoolManager) {
        const reservationResult = fastify.modelPoolManager.reserveSlot(
          candidate.provider,
          candidate.model,
          30000,
          reservationId
        );

        slotReserved = reservationResult !== false;

        if (!slotReserved) {
          return {
            success: false,
            provider: candidate.provider,
            model: candidate.model,
            reason: 'no_capacity'
          };
        }

        fastify.modelPoolManager.confirmSlot(candidate.provider, candidate.model, reservationId);
      }

      req.log.info(
        `[Routes] Parallel attempt: ${candidate.provider},${candidate.model} (requestId: ${requestId}, isPrimary: ${candidate.isPrimary})`
      );

      const provider = fastify.providerService.getProviderForRequest(candidate.provider);
      if (!provider) {
        return {
          success: false,
          provider: candidate.provider,
          model: candidate.model,
          reason: 'provider_not_found'
        };
      }

      const newBody = { ...(req.body as any) };
      newBody.model = candidate.model;

      // Ensure each parallel candidate has a unique session ID if it's an iflow provider
      // This prevents multiple parallel requests from interfering with each other's iflow sessions
      let sessionContext = req.sessionContext;
      const isIflowCandidate = candidate.provider.toLowerCase().startsWith("iflow") || 
                               provider.type?.toLowerCase()?.startsWith("iflow");
      if (isIflowCandidate) {
        const baseSessionId = req.sessionContext?.sessionId || req.sessionId || requestId;
        const baseConversationId = req.sessionContext?.conversationId || req.conversationId || requestId;
        
        // Use a purely random suffix for maximum entropy and minimal length
        const isolationSuffix = Math.random().toString(36).substring(2, 10);

        sessionContext = {
          ...req.sessionContext,
          sessionId: `${baseSessionId}-${isolationSuffix}`,
          conversationId: `${baseConversationId}-${isolationSuffix}`,
        };
      }

      const newReq = {
        ...req,
        provider: candidate.provider,
        body: newBody,
        sessionContext,
      };

      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        provider,
        transformer,
        req.headers,
        { req: newReq, signal: controller.signal }
      );

      const response = await sendRequestToProvider(
        requestBody,
        config,
        provider,
        fastify,
        bypass,
        transformer,
        { req: newReq, signal: controller.signal }
      );

      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        provider,
        transformer,
        bypass,
        { req: newReq }
      );

      // Success - cancel other requests
      controller.abort();

      if (fastify.modelPoolManager) {
        fastify.modelPoolManager.markSuccess(candidate.provider, candidate.model);
        fastify.modelPoolManager.releaseSlot(candidate.provider, candidate.model, true);
      }

      req.log.info(
        `[Routes] Parallel success: ${candidate.provider},${candidate.model} (requestId: ${requestId}, isPrimary: ${candidate.isPrimary})`
      );

      return {
        success: true,
        provider: candidate.provider,
        model: candidate.model,
        isPrimary: candidate.isPrimary,
        result: await formatResponse(
          finalResponse,
          reply,
          newBody,
          req.log,
          fastify.configService.getAll(),
          req.scenarioType,
          {
            originalRequest: newBody,
            provider: candidate.provider,
            sendRequestFn: async () => {
              const retryResponse = await sendRequestToProvider(
                newBody,
                {},
                provider,
                fastify,
                false,
                transformer,
                { req: newReq }
              );
              if (!retryResponse.ok) {
                throw new Error(`Retry request failed: ${retryResponse.status}`);
              }
              return retryResponse;
            }
          }
        )
      };
    } catch (fallbackError: any) {
      if (fastify.modelPoolManager) {
        if (isRateLimitError(fallbackError)) {
          const retryAfter = fallbackError.headers?.['retry-after']
            ? parseInt(fallbackError.headers['retry-after']) * 1000
            : undefined;
          fastify.modelPoolManager.markRateLimit(candidate.provider, candidate.model, retryAfter);
        }

        fastify.modelPoolManager.markFailure(candidate.provider, candidate.model);

        if (slotReserved) {
          fastify.modelPoolManager.releaseSlot(candidate.provider, candidate.model, false);
        }
      }

      req.log.warn(
        `[Routes] Parallel attempt failed: ${candidate.provider},${candidate.model} (requestId: ${requestId}, error: ${fallbackError.message}, isPrimary: ${candidate.isPrimary})`
      );

      return {
        success: false,
        provider: candidate.provider,
        model: candidate.model,
        error: fallbackError
      };
    }
  });

  // Wait for first success or all failures
  const results = await Promise.allSettled(promises);

  // Find first successful result (prefer primary if available)
  let primarySuccess = null;
  let altSuccess = null;

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.success) {
      if (result.value.isPrimary) {
        primarySuccess = result.value;
      } else if (!altSuccess) {
        altSuccess = result.value;
      }
    }
  }

  // Return primary success if available, otherwise alternative success
  if (primarySuccess) {
    return primarySuccess.result;
  }

  if (altSuccess) {
    return altSuccess.result;
  }

  // All failed
  throw new Error('All parallel attempts failed');
}

function shouldAttemptFailover(req: FastifyRequest, error: any): boolean {
  // Only attempt failover for custom-model (default scenario)
  const isCustomModel = req.isCustomModel === true;

  if (!isCustomModel) {
    return false;
  }

  // Check if error triggers failover
  const shouldFallback =
    error.code === 'provider_response_error' ||
    error.statusCode === 429 ||
    error.statusCode === 439 ||
    error.statusCode === 449 ||
    error.statusCode === 503 ||
    error.statusCode === 502;

  return shouldFallback;
}

function isRateLimitError(error: any): boolean {
  return (
    error.statusCode === 429 ||
    error.statusCode === 439 ||
    error.statusCode === 449
  );
}

async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any,
  reason: 'error' | 'capacity' = 'error'
): Promise<any> {
  const requestId = req.requestId || 'unknown';
  const originalProvider = req.provider;
  const originalModel = (req.body as any).model;

  requestTracker.recordFailoverStart(
    requestId,
    reason,
    req.alternatives?.length || 0
  );

  const alternatives = req.alternatives || [];

  if (alternatives.length === 0) {
    req.log.warn(`No failover alternatives configured`);
    return null;
  }

  // Filter out rate-limited and circuit-open alternatives
  const availableAlternatives = alternatives.filter(alt => {
    const isRateLimited = fastify.modelPoolManager.isRateLimited(alt.provider, alt.model);
    const isCircuitOpen = fastify.modelPoolManager.isCircuitBreakerOpen(alt.provider, alt.model);
    const hasCapacity = fastify.modelPoolManager.hasCapacity(alt.provider, alt.model);

    return !isRateLimited && !isCircuitOpen && hasCapacity;
  });

  if (availableAlternatives.length === 0) {
    req.log.warn(`No available alternatives (all rate-limited or circuit-open)`);
    return null;
  }

  req.log.warn(
    `Attempting failover with ${availableAlternatives.length} alternatives (requestId: ${requestId}, reason: ${reason}, original: ${originalProvider},${originalModel})`
  );

  try {
    const result = await tryAlternativesParallel(
      availableAlternatives,
      req,
      reply,
      fastify,
      transformer,
      reason
    );

    if (result) {
      requestTracker.recordFailoverComplete(
        requestId,
        true,
        req.provider,
        req.model
      );
      return result;
    }
  } catch (parallelError: any) {
    req.log.error(`Parallel failover failed: ${parallelError.message}`);
  }

  requestTracker.recordFailoverComplete(requestId, false);
  return null;
}

async function tryAlternativesParallel(
  alternatives: Array<{ provider: string; model: string }>,
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  reason: 'error' | 'capacity'
): Promise<any> {
  const requestId = req.requestId || 'unknown';
  const controller = new AbortController();

  const promises = alternatives.map(async (alternative) => {
    let slotReserved = false;
    const reservationId = `${requestId}-failover-${alternative.provider}-${alternative.model}`;

    try {
      const provider = fastify.providerService.getProviderForRequest(alternative.provider);
      if (!provider) {
        return { success: false, provider: alternative.provider, model: alternative.model, reason: 'provider_not_found' };
      }

      if (fastify.modelPoolManager) {
        const reservationResult = fastify.modelPoolManager.reserveSlot(
          alternative.provider,
          alternative.model,
          30000,
          reservationId
        );

        slotReserved = reservationResult !== false;

        if (!slotReserved) {
          return { success: false, provider: alternative.provider, model: alternative.model, reason: 'no_capacity' };
        }

        fastify.modelPoolManager.confirmSlot(alternative.provider, alternative.model, reservationId);
      }

      req.log.info(`Trying failover alternative: ${alternative.provider},${alternative.model} (requestId: ${requestId})`);

      const newBody = { ...(req.body as any) };
      newBody.model = alternative.model;

      const newReq = {
        ...req,
        provider: alternative.provider,
        body: newBody,
      };

      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        provider,
        transformer,
        req.headers,
        { req: newReq, signal: controller.signal }
      );

      const response = await sendRequestToProvider(
        requestBody,
        config,
        provider,
        fastify,
        bypass,
        transformer,
        { req: newReq, signal: controller.signal }
      );

      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        provider,
        transformer,
        bypass,
        { req: newReq }
      );

      if (fastify.modelPoolManager) {
        fastify.modelPoolManager.markSuccess(alternative.provider, alternative.model);
        fastify.modelPoolManager.releaseSlot(alternative.provider, alternative.model, true);
      }

      controller.abort();

      req.log.info(`Failover alternative succeeded: ${alternative.provider},${alternative.model} (requestId: ${requestId})`);

      return {
        success: true,
        provider: alternative.provider,
        model: alternative.model,
        result: await formatResponse(
          finalResponse,
          reply,
          newBody,
          req.log,
          fastify.configService.getAll(),
          req.scenarioType,
          {
            originalRequest: newBody,
            provider: alternative.provider,
            sendRequestFn: async () => {
              const retryResponse = await sendRequestToProvider(
                newBody,
                {},
                provider,
                fastify,
                false,
                transformer,
                { req: newReq }
              );
              if (!retryResponse.ok) {
                throw new Error(`Retry request failed: ${retryResponse.status}`);
              }
              return retryResponse;
            }
          }
        )
      };
    } catch (fallbackError: any) {
      if (fastify.modelPoolManager) {
        if (isRateLimitError(fallbackError)) {
          const retryAfter = fallbackError.headers?.['retry-after']
            ? parseInt(fallbackError.headers['retry-after']) * 1000
            : undefined;
          fastify.modelPoolManager.markRateLimit(alternative.provider, alternative.model, retryAfter);
        }

        fastify.modelPoolManager.markFailure(alternative.provider, alternative.model);

        if (slotReserved) {
          fastify.modelPoolManager.releaseSlot(alternative.provider, alternative.model, false);
        }
      }

      req.log.warn(`Failover alternative failed: ${alternative.provider},${alternative.model} (requestId: ${requestId}, error: ${fallbackError.message})`);

      return { success: false, provider: alternative.provider, model: alternative.model, error: fallbackError };
    }
  });

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.success) {
      return result.value.result;
    }
  }

  throw new Error('All failover alternatives failed');
}

async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  let requestBody = body;
  let config: any = {};
  let bypass = false;

  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    // Filter out headers that we manage ourselves to avoid duplicates
    // These headers are set by HeaderManager and should not come from incoming requests
    const managedHeaders = ['accept', 'content-type', 'authorization', 'user-agent', 'x-client-type', 'x-client-version', 'session-id', 'conversation-id', 'x-request-id'];
    const filteredHeaders: Record<string, string> = {};
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        if (!managedHeaders.includes(key.toLowerCase())) {
          filteredHeaders[key] = value;
        }
      });
    } else {
      for (const [key, value] of Object.entries(headers)) {
        if (!managedHeaders.includes(key.toLowerCase())) {
          filteredHeaders[key] = value;
        }
      }
    }
    config.headers = filteredHeaders;
  }

  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {


  const url = config.url || new URL(provider.baseUrl);

  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Apply model-specific configuration for iflow provider (glm-4.7)
  if ((provider.name === 'iflow' || provider.type === 'iflow') && requestBody.model?.includes('glm-4.7')) {
    requestBody.temperature = 1;
    requestBody.top_p = 0.95;
    console.log(`[iflow Debug] Applied glm-4.7 specific settings: temperature=1, top_p=0.95`);
  }

  // Ensure iflow URLs have the correct path
  if ((provider.name === 'iflow' || provider.type === 'iflow') && !url.pathname.endsWith('/chat/completions')) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  }

  // Helper function to generate fresh headers with fresh signature
  // This is called on each retry attempt to ensure valid signatures
  const generateRequestHeaders = () => {
    // Build header context dynamically to pick up isolated session IDs from parallel runner
    const currentSessionCtx = context.req?.sessionContext;
    const dynamicHeaderContext = {
      provider: provider.name,
      providerType: provider.type,
      model: requestBody.model,
      sessionId: currentSessionCtx?.sessionId || context.req?.sessionId || context.req?.sessionContext?.sessionId,
      conversationId: currentSessionCtx?.conversationId || context.req?.conversationId || context.req?.sessionContext?.conversationId,
      requestId: currentSessionCtx?.requestId || context.req?.id,
      isStream: requestBody.stream === true,
    };

    console.log(`[DIAGNOSTIC] dynamicHeaderContext for ${provider.name}:`, JSON.stringify(dynamicHeaderContext, null, 2));

    // Filter config headers (from transformer) to remove conflicting/unwanted headers
    const configHeaders = config?.headers || {};
    const filteredConfigHeaders: Record<string, string> = {};
    
    // List of headers that we manage explicitly or want to exclude
    const excludedHeaders = [
      'content-type', 'content-length', 'accept', 
      'authorization', 'host', 'connection',
      'user-agent', 'x-client-type', 'x-client-version',
      'session-id', 'conversation-id', 'x-request-id',
      // Exclude x-api-key for iflow as it uses Bearer token
      'x-api-key'
    ];

    Object.entries(configHeaders).forEach(([key, value]) => {
      if (value && !excludedHeaders.includes(key.toLowerCase())) {
        filteredConfigHeaders[key] = value as string;
      }
    });

    let headers = HeaderManager.buildRequestHeaders(
      provider.apiKey,
      provider.name,
      dynamicHeaderContext,
      { ...provider.headers, ...filteredConfigHeaders }
    );

    // Apply request signing if provider requires it
    if (providerRequiresSigning(provider.name, provider.type)) {
      const signer = getSignerForProvider(provider.name, provider.apiKey, provider.type);
      if (signer) {
        headers = signer.sign(headers, requestBody);
      }
    }

    if (provider.name.toLowerCase().startsWith('iflow') || provider.type?.toLowerCase()?.startsWith('iflow')) {
      context.req?.log?.info({ iflowHeaders: headers, iflowContext: dynamicHeaderContext }, `[iflow Debug] Generated headers for ${provider.name}`);
    }

    return headers;
  };

  // Initial headers for first attempt
  let requestHeaders = generateRequestHeaders();

  // Debug logging for iflow provider - log full request details
  const isIflowProvider = provider.name.toLowerCase().startsWith('iflow') || provider.type?.toLowerCase()?.startsWith('iflow');
  if (isIflowProvider) {
    const debugInfo = {
      url: url.toString(),
      pathname: url.pathname,
      baseUrl: provider.baseUrl,
      providerName: provider.name,
      providerType: provider.type,
      sessionId: context.req?.sessionContext?.sessionId,
      conversationId: context.req?.sessionContext?.conversationId,
      requestId: context.req?.sessionContext?.requestId,
      hasSessionContext: !!context.req?.sessionContext,
      headers: requestHeaders,
      body: requestBody
    };
    
    console.error(`[iflow DEBUG] ======================================`);
    console.error(`[iflow DEBUG] REQUEST DETAILS FOR ${provider.name}`);
    console.error(`[iflow DEBUG] ======================================`);
    console.error('[iflow DEBUG] URL:', debugInfo.url);
    console.error('[iflow DEBUG] Headers:', JSON.stringify(debugInfo.headers, null, 2));
    console.error('[iflow DEBUG] Body:', JSON.stringify(debugInfo.body, null, 2));
    console.error('[iflow DEBUG] ======================================');
    
    // Also write to file for persistence
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const logPath = path.join(os.homedir(), '.claude-code-router', 'iflow-debug.log');
      fs.appendFileSync(logPath, JSON.stringify(debugInfo, null, 2) + '\n\n');
    } catch (e) {
      // Ignore file write errors
    }
  }

  // Execute request with retry logic for provider-specific errors
  const response = await executeWithRetry(
    provider.name,
    async () => {
      // Generate fresh headers with fresh signature for each retry attempt
      // This ensures the timestamp in the signature is always valid
      const freshHeaders = generateRequestHeaders();
      
      const res = await sendUnifiedRequest(
        url,
        requestBody,
        {
          httpsProxy: fastify.configService.getHttpsProxy(),
          ...config,
          headers: freshHeaders,
        },
        context,
        fastify.log
      );

      if (!res.ok) {
        const errorText = await res.text();

        // Debug logging for iflow provider errors
        if (isIflowProvider) {
          const diagnosticInfo = {
            status: res.status,
            provider: provider.name,
            headers: freshHeaders,
            bodySnippet: JSON.stringify(requestBody).substring(0, 500) + '...',
            errorResponse: errorText
          };
          
          console.error(`[iflow Debug] ========== ERROR RESPONSE FOR ${provider.name} ==========`);
          console.error(`[iflow Debug] Status: ${res.status}`);
          console.error(`[iflow Debug] Diagnostic Info: ${JSON.stringify(diagnosticInfo, null, 2)}`);
          console.error(`[iflow Debug] ======================================`);
          
          if (res.status === 406) {
            throw createApiError(
              `Error from ${provider.name}: Not Acceptable (likely signature or header format rejected). ` +
              `DIAGNOSTIC: ${JSON.stringify(diagnosticInfo)}`,
              406,
              "not_acceptable",
            );
          }
        }

        let errorBody: any;
        try {
          errorBody = JSON.parse(errorText);
        } catch {
          errorBody = { message: errorText };
        }

        // Parse provider-specific error
        const providerError = ProviderErrorHandler.parseError(
          provider.name,
          res.status,
          errorBody,
          provider.type
        );

        // Create enhanced error with provider-specific details
        const error = new Error(
          new ProviderErrorHandler().formatUserMessage(providerError)
        ) as any;
        error.statusCode = res.status;
        error.code = providerError.code;
        error.body = errorBody;
        error.providerError = providerError;

        throw error;
      }

      return res;
    },
    (error, attempt) => {
      if (error.providerError) {
        fastify.log.warn(
          `[Retry] Attempt ${attempt + 1} failed for provider ${provider.name}: ${error.providerError.code} - ${error.providerError.message}`
        );
        // Record retry in metrics
        const requestId = context.req?.requestId;
        if (requestId) {
          metricsCollector.recordRetry(requestId);
        }
      }
    }
  );

  return response;
}

async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  return finalResponse;
}

async function formatResponse(
  response: any,
  reply: FastifyReply,
  body: any,
  logger?: any,
  config?: any,
  scenarioType?: string,
  retryContext?: {
    originalRequest?: any;
    provider?: any;
    sendRequestFn?: () => Promise<Response>;
  }
) {
  if (!response.ok) {
    reply.code(response.status);
  }

  const isStream = body.stream === true;
  if (!isStream) {
    return response.json();
  }

  // Set SSE headers
  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");
  reply.header("X-Accel-Buffering", "no");
  reply.header("Transfer-Encoding", "chunked");

  // Check for Web Streams API ReadableStream
  if (!response.body || typeof response.body.getReader !== 'function') {
    return reply.send(response.body);
  }

  // Read streaming configuration
  const streamingConfig = config?.streaming || {};
  const heartbeatIntervalMs = streamingConfig.sseHeartbeatIntervalMs || 30000;
  const isIflow = ((retryContext?.provider as string)?.startsWith("iflow") || (req.provider as string)?.startsWith("iflow"));
  const enableKeepalive = isIflow ? false : (streamingConfig.sseEnableKeepalive !== false);
  const backpressureTimeoutMs = streamingConfig.sseBackpressureTimeoutMs || 60000;
  const enableStaggeredDetection = streamingConfig.sseEnableStaggeredDetection !== false;
  const maxInterChunkDelayMs = streamingConfig.sseMaxInterChunkDelayMs || 10000;
  const minTokenRate = streamingConfig.sseMinTokenRate || 1;

  // Scenario-aware read timeouts
  const scenarioTimeouts: Record<string, number> = {
    think: 300000,      // 5 minutes for reasoning models
    default: 180000,    // 2 minutes for default (covers reasoning models on default route)
    longContext: 180000, // 3 minutes for long context
    background: 120000,  // 2 minutes for background tasks
    webSearch: 120000,   // 2 minutes for web search
  };
  const readTimeoutMs = (scenarioType && scenarioTimeouts[scenarioType]) || streamingConfig.sseReadTimeoutMs || 180000;

  // Max stream retries for connection errors
  const maxStreamRetries = streamingConfig.sseMaxRetries || 2;

  // Create a TransformStream-like structure to pump data through SSEStreamManager
  // We use a manual ReadableStream to capture the controller
  let streamController: ReadableStreamDefaultController<any>;
  let streamManagerRef: SSEStreamManager | null = null;

  const outStream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      // Signal the SSEStreamManager to stop
      streamManagerRef?.abort();
    }
  });

  // Stream pump with retry support
  const pumpStreamWithRetry = async (
    initialResponse: Response,
    retryAttempt: number = 0
  ): Promise<void> => {
    let reader = initialResponse.body.getReader();
    let currentResponse = initialResponse;

    // Initialize manager with the controller
    const streamManager = new SSEStreamManager(streamController!, {
      heartbeatIntervalMs,
      enableKeepalive,
      backpressureTimeoutMs,
      enableStaggeredDetection,
      maxInterChunkDelayMs,
      minTokenRate,
      onStaggeredDetected: (info) => {
        logger?.warn(`[Stream] Staggered streaming detected for request: ${info.delayMs}ms delay, ${info.tokenRate.toFixed(2)} tokens/sec`);
      }
    });
    streamManagerRef = streamManager;

    logger?.info(`[Stream] Started for request with heartbeat enabled (interval: ${heartbeatIntervalMs}ms, timeout: ${readTimeoutMs}ms, attempt: ${retryAttempt + 1})`);

    try {
      while (streamManager.connected) {
        // Check for abort signal
        if (streamManager.signal.aborted) {
          logger?.info(`[Stream] Aborted by client disconnect`);
          break;
        }

        // Read with timeout wrapper to prevent indefinite blocking
        const readResult = await readWithTimeout(reader, readTimeoutMs, streamManager.signal);

        const { done, value } = readResult;

        if (done) {
          logger?.info(`[Stream] Provider stream completed`);
          break;
        }

        // Write with backpressure handling (writes to controller)
        const success = await streamManager.write(value);

        if (!success) {
          logger?.warn(`[Stream] Write failed, client likely disconnected`);
          break;
        }
      }
    } catch (error: any) {
      const errorMessage = error.message || String(error);

      // Check if this is a connection error that can be retried
      const isConnectionError =
        errorMessage.includes('Connection reset') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ENOTCONN') ||
        errorMessage.includes('Broken pipe') ||
        errorMessage.includes('Premature close');

      const isRetryable = isConnectionError && retryAttempt < maxStreamRetries && retryContext?.sendRequestFn;

      if (errorMessage === 'Aborted' || error.name === 'AbortError') {
        logger?.info(`[Stream] Client disconnected`);
      } else if (errorMessage === 'Read timeout') {
        logger?.warn(`[Stream] Timeout waiting for provider data`);
      } else if (isRetryable) {
        // Attempt to reconnect
        logger?.warn(`[Stream] Connection error detected: ${errorMessage}. Attempting retry ${retryAttempt + 1}/${maxStreamRetries}`);

        // Cleanup current reader
        await reader.cancel().catch(() => {});
        reader.releaseLock();

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryAttempt + 1)));

        try {
          // Make new request to reconnect
          const newResponse = await retryContext.sendRequestFn();

          if (!newResponse.ok) {
            logger?.error(`[Stream] Retry request failed with status: ${newResponse.status}`);
            throw error;
          }

          if (!newResponse.body || typeof newResponse.body.getReader !== 'function') {
            logger?.error(`[Stream] Retry response has no readable body`);
            throw error;
          }

          logger?.info(`[Stream] Retry successful, resuming stream`);

          // Recursively pump the new stream with incremented retry count
          await pumpStreamWithRetry(newResponse, retryAttempt + 1);
          return;
        } catch (retryError: any) {
          logger?.error(`[Stream] Retry failed: ${retryError.message}`);
          throw error;
        }
      } else {
        logger?.error(`[Stream] Error: ${errorMessage} (retryable: ${isRetryable}, attempts: ${retryAttempt}/${maxStreamRetries})`);
        throw error;
      }
    } finally {
      // Cleanup
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await streamManager.end();
      logger?.info(`[Stream] Ended`);
    }
  };

  // Start the pump process in the background
  // We don't await this because we want to return the stream to Fastify immediately
  (async () => {
    try {
      await pumpStreamWithRetry(response);
    } catch (error: any) {
      // Final error handler - stream has failed after all retries
      logger?.error(`[Stream] Failed after retries: ${error.message}`);
      // Send error event to client if still connected
      if (streamManagerRef?.connected) {
        const errorEvent = `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`;
        await streamManagerRef.write(errorEvent).catch(() => {});
      }
    }
  })();

  return reply.send(outStream);
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  fastify.get("/metrics", async (req: FastifyRequest) => {
    const timeWindow = parseInt(req.query?.timeWindow as string) || undefined;
    const provider = req.query?.provider as string || undefined;

    const stats = metricsCollector.getStats(timeWindow);

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalRequests: stats.totalRequests,
        successfulRequests: stats.successfulRequests,
        failedRequests: stats.failedRequests,
        successRate: stats.totalRequests > 0
          ? (stats.successfulRequests / stats.totalRequests * 100).toFixed(2) + '%'
          : '0%',
        averageLatency: stats.averageLatency.toFixed(2) + 'ms',
      },
      providers: provider
        ? { [provider]: stats.providers[provider] }
        : stats.providers,
      timeWindow: stats.timeWindow,
    };
  });

  fastify.get("/metrics/recent", async (req: FastifyRequest) => {
    const limit = parseInt(req.query?.limit as string) || 100;
    const provider = req.query?.provider as string || undefined;
    const model = req.query?.model as string || undefined;
    const success = req.query?.success !== undefined
      ? req.query?.success === 'true'
      : undefined;
    const timeWindow = parseInt(req.query?.timeWindow as string) || undefined;

    const metrics = metricsCollector.getRecentMetrics({
      provider,
      model,
      success,
      limit,
      timeWindowMs: timeWindow,
    });

    return {
      timestamp: new Date().toISOString(),
      count: metrics.length,
      metrics: metrics.map(m => ({
        requestId: m.requestId,
        provider: m.provider,
        model: m.model,
        duration: m.duration,
        success: m.success,
        errorCode: m.errorCode,
        retryCount: m.retryCount,
        scenarioType: m.scenarioType,
      })),
    };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      const { name, baseUrl, apiKey, apiKeys, models } = request.body;

      // Handle api_key / apiKeys backward compatibility
      let finalApiKeys: string[] = [];
      if (apiKeys && Array.isArray(apiKeys) && apiKeys.length > 0) {
        finalApiKeys = apiKeys;
      } else if (apiKey && typeof apiKey === 'string') {
        finalApiKeys = apiKey.split(',').map(k => k.trim()).filter(k => k.length > 0);
      }

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (finalApiKeys.length === 0) {
        throw createApiError("API key is required", 400, "invalid_request");
      }
      
      // Update body with final parsed keys
      request.body.apiKey = finalApiKeys[0];
      request.body.apiKeys = finalApiKeys;
      request.body.currentKeyIndex = 0;

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );

  fastify.get("/v1/models", async () => {
    const providers = fastify.providerService.getProviders();
    const models = [];

    models.push({
      id: "custom-model",
      object: "model",
      owned_by: "claude-code-router",
      description: "Automatic model routing using Router.default with intelligent failover and parallel execution",
      capabilities: {
        automatic_routing: true,
        failover: true,
        parallel_execution: true,
        health_based_selection: true,
      }
    });

    providers.forEach((provider) => {
      provider.models.forEach((model) => {
        models.push({
          id: model,
          object: "model",
          owned_by: provider.name,
          provider: provider.name
        });
        models.push({
          id: `${provider.name},${model}`,
          object: "model",
          owned_by: provider.name,
          provider: provider.name
        });
      });
    });

    return {
      object: "list",
      data: models
    };
  });

  fastify.get("/model-pool/status", async () => {
    return fastify.modelPoolManager.getStatus();
  });

  fastify.get("/model-pool/queue", async () => {
    return fastify.modelPoolManager.getQueueStatus();
  });

  fastify.get("/model-pool/config", async () => {
    return fastify.modelPoolManager.getConfig();
  });

  fastify.post("/model-pool/reset-circuit-breakers", async () => {
    fastify.modelPoolManager.resetCircuitBreakers();
    return { success: true, message: "All circuit breakers reset" };
  });

  fastify.post("/model-pool/clear-queue", async () => {
    fastify.modelPoolManager.clearQueue();
    return { success: true, message: "All queues cleared" };
  });

  fastify.get("/endpoint-groups/status", async () => {
    return fastify.endpointGroupManager.getStatus();
  });

  fastify.post("/endpoint-groups/reset-circuit-breakers", async () => {
    fastify.endpointGroupManager.resetCircuitBreakers();
    return { success: true, message: "All endpoint circuit breakers reset" };
  });

  fastify.post("/endpoint-groups/clear-queue", async () => {
    fastify.endpointGroupManager.clearQueue();
    return { success: true, message: "All endpoint queues cleared" };
  });

  fastify.get("/endpoint-groups/config", async () => {
    return fastify.endpointGroupManager.getConfig();
  });

  fastify.get("/model-selector/config", async () => {
    return fastify.modelSelector.getConfig();
  });
};

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
