import { randomUUID } from 'crypto';

export interface RequestMetrics {
  requestId: string;
  sessionId?: string;
  startTime: number;
  routingTime?: number;
  slotReservationTime?: number;
  queueTime?: number;
  apiCallTime?: number;
  failoverTime?: number;
  totalTime?: number;
  provider?: string;
  model?: string;
  scenarioType?: string;
  priority?: number;
  wasQueued?: boolean;
  hadFailover?: boolean;
  failoverAttempts?: number;
  success?: boolean;
  error?: string;
  statusCode?: number;
}

export interface RequestStage {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, any>;
}

export class RequestTracker {
  private metrics: Map<string, RequestMetrics> = new Map();
  private stages: Map<string, RequestStage[]> = new Map();
  private logger: any;

  constructor(logger: any = console) {
    this.logger = logger;
  }

  generateRequestId(): string {
    return randomUUID();
  }

  startRequest(requestId: string, sessionId?: string, priority?: number): RequestMetrics {
    const metrics: RequestMetrics = {
      requestId,
      sessionId,
      startTime: Date.now(),
      priority,
    };

    this.metrics.set(requestId, metrics);
    this.stages.set(requestId, []);

    this.logger.info(
      `[RequestTracker] Request started`,
      {
        requestId,
        sessionId,
        priority,
        timestamp: new Date(metrics.startTime).toISOString(),
      }
    );

    this.startStage(requestId, 'request_start');

    return metrics;
  }

  startStage(requestId: string, stageName: string, metadata?: Record<string, any>): void {
    const stages = this.stages.get(requestId);
    if (!stages) return;

    const stage: RequestStage = {
      name: stageName,
      startTime: Date.now(),
      metadata,
    };

    stages.push(stage);

    this.logger.debug(
      `[RequestTracker] Stage started: ${stageName}`,
      {
        requestId,
        stage: stageName,
        metadata,
        timestamp: new Date(stage.startTime).toISOString(),
      }
    );
  }

  endStage(requestId: string, stageName: string, metadata?: Record<string, any>): void {
    const stages = this.stages.get(requestId);
    if (!stages) return;

    const stage = stages.find((s) => s.name === stageName);
    if (!stage) return;

    stage.endTime = Date.now();
    stage.duration = stage.endTime - stage.startTime;
    if (metadata) {
      stage.metadata = { ...stage.metadata, ...metadata };
    }

    this.logger.debug(
      `[RequestTracker] Stage completed: ${stageName}`,
      {
        requestId,
        stage: stageName,
        duration: stage.duration,
        metadata: stage.metadata,
        timestamp: new Date(stage.endTime).toISOString(),
      }
    );
  }

  recordRouting(requestId: string, provider: string, model: string, scenarioType: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    metrics.provider = provider;
    metrics.model = model;
    metrics.scenarioType = scenarioType;

    const now = Date.now();
    metrics.routingTime = now - metrics.startTime;

    this.endStage(requestId, 'routing', {
      provider,
      model,
      scenarioType,
      duration: metrics.routingTime,
    });

    this.logger.info(
      `[RequestTracker] Routing completed`,
      {
        requestId,
        provider,
        model,
        scenarioType,
        routingTime: metrics.routingTime,
      }
    );
  }

  recordSlotReservation(
    requestId: string,
    provider: string,
    model: string,
    immediate: boolean,
    reserved: boolean
  ): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    const now = Date.now();

    if (immediate) {
      metrics.slotReservationTime = now - metrics.startTime;
    }

    this.logger.info(
      `[RequestTracker] Slot reservation`,
      {
        requestId,
        provider,
        model,
        immediate,
        reserved,
        duration: immediate ? metrics.slotReservationTime : undefined,
      }
    );
  }

  recordQueueEnqueue(requestId: string, provider: string, model: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    metrics.wasQueued = true;
    const now = Date.now();
    metrics.queueTime = now - metrics.startTime;

    this.endStage(requestId, 'queue_enqueue', {
      provider,
      model,
      queueWaitTime: metrics.queueTime,
    });

    this.logger.info(
      `[RequestTracker] Request queued`,
      {
        requestId,
        provider,
        model,
        queueWaitTime: metrics.queueTime,
      }
    );
  }

  recordQueueDequeue(requestId: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics || !metrics.wasQueued) return;

    const now = Date.now();
    const totalQueueTime = now - metrics.startTime;

    this.startStage(requestId, 'queue_dequeue');

    this.logger.info(
      `[RequestTracker] Request dequeued`,
      {
        requestId,
        totalQueueTime,
      }
    );
  }

  recordApiCallStart(requestId: string, provider: string, model: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    this.startStage(requestId, 'api_call', {
      provider,
      model,
    });

    this.logger.info(
      `[RequestTracker] API call started`,
      {
        requestId,
        provider,
        model,
      }
    );
  }

  recordApiCallComplete(requestId: string, success: boolean, statusCode?: number, error?: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    const now = Date.now();
    const startTime = metrics.startTime;
    
    metrics.apiCallTime = now - startTime;
    metrics.success = success;
    metrics.statusCode = statusCode;
    metrics.error = error;

    this.endStage(requestId, 'api_call', {
      success,
      statusCode,
      error,
      duration: metrics.apiCallTime,
    });

    this.logger.info(
      `[RequestTracker] API call completed`,
      {
        requestId,
        provider: metrics.provider,
        model: metrics.model,
        success,
        statusCode,
        error,
        duration: metrics.apiCallTime,
      }
    );
  }

  recordFailoverStart(requestId: string, reason: string, alternatives: number): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    metrics.hadFailover = true;
    metrics.failoverAttempts = (metrics.failoverAttempts || 0) + 1;

    this.startStage(requestId, 'failover', {
      reason,
      alternatives,
      attempt: metrics.failoverAttempts,
    });

    this.logger.warn(
      `[RequestTracker] Failover started`,
      {
        requestId,
        reason,
        alternatives,
        attempt: metrics.failoverAttempts,
      }
    );
  }

  recordFailoverComplete(requestId: string, success: boolean, newProvider?: string, newModel?: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    const now = Date.now();
    metrics.failoverTime = now - metrics.startTime;

    if (success && newProvider && newModel) {
      metrics.provider = newProvider;
      metrics.model = newModel;
    }

    this.endStage(requestId, 'failover', {
      success,
      newProvider,
      newModel,
      duration: metrics.failoverTime,
    });

    this.logger.info(
      `[RequestTracker] Failover completed`,
      {
        requestId,
        success,
        newProvider,
        newModel,
        duration: metrics.failoverTime,
      }
    );
  }

  completeRequest(requestId: string, success: boolean, statusCode?: number, error?: string): void {
    const metrics = this.metrics.get(requestId);
    if (!metrics) return;

    const now = Date.now();
    metrics.totalTime = now - metrics.startTime;
    metrics.success = success;
    metrics.statusCode = statusCode;
    metrics.error = error;

    this.endStage(requestId, 'request_complete', {
      success,
      statusCode,
      error,
      totalTime: metrics.totalTime,
    });

    this.logger.info(
      `[RequestTracker] Request completed`,
      {
        requestId,
        success,
        statusCode,
        error,
        totalTime: metrics.totalTime,
        wasQueued: metrics.wasQueued,
        hadFailover: metrics.hadFailover,
        failoverAttempts: metrics.failoverAttempts,
        provider: metrics.provider,
        model: metrics.model,
      }
    );
  }

  getMetrics(requestId: string): RequestMetrics | undefined {
    return this.metrics.get(requestId);
  }

  getStages(requestId: string): RequestStage[] | undefined {
    return this.stages.get(requestId);
  }

  cleanup(requestId: string): void {
    this.metrics.delete(requestId);
    this.stages.delete(requestId);
  }
}

export const requestTracker = new RequestTracker();
