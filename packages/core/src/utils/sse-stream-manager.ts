/**
 * SSE Stream Manager
 *
 * Manages SSE streaming with heartbeat, connection monitoring, and backpressure handling.
 * This module addresses streaming interruptions caused by:
 * - TCP connection timeouts during idle periods
 * - Missing client disconnect detection
 * - Lack of backpressure handling
 */

export interface SSEStreamManagerOptions {
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Enable keepalive heartbeat (default: true) */
  enableKeepalive?: boolean;
  /** Backpressure timeout in milliseconds (default: 10000) */
  backpressureTimeoutMs?: number; // (default: 60000)
  /** Maximum idle time before considering connection dead (default: 120000) */
  maxIdleTimeMs?: number;
  /** Enable staggered streaming detection (default: true) */
  enableStaggeredDetection?: boolean;
  /** Maximum acceptable delay between chunks in milliseconds (default: 10000) */
  maxInterChunkDelayMs?: number;
  /** Minimum token rate (tokens/second) before considering stream stalled (default: 1) */
  minTokenRate?: number;
  /** Callback invoked when staggered streaming is detected */
  onStaggeredDetected?: (info: StaggeredStreamInfo) => void;
}

/**
 * Information about a detected staggered stream
 */
export interface StaggeredStreamInfo {
  /** Time since last chunk in milliseconds */
  delayMs: number;
  /** Current token rate (tokens/second) */
  tokenRate: number;
  /** Total chunks received */
  chunkCount: number;
  /** Time stream has been active */
  streamDurationMs: number;
  /** Timestamp when detected */
  detectedAt: number;
}

/**
 * SSE Stream Manager handles streaming with:
 * - Heartbeat/keep-alive comments sent during idle periods
 * - Connection monitoring via close/error events
 * - Backpressure handling for slow clients
 * - Abort signal integration for cancellation
 * - Staggered streaming detection for irregular chunk delivery
 */
export class SSEStreamManager {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staggeredCheckTimer: NodeJS.Timeout | null = null;
  private lastActivity: number = Date.now();
  private lastChunkTime: number = Date.now();
  private isConnected: boolean = true;
  private abortController: AbortController;
  private chunkCount: number = 0;
  private tokenCount: number = 0;
  private streamStartTime: number = Date.now();
  private staggeredDetected: boolean = false;

  private raw: NodeJS.WritableStream | null = null;
  private controller: ReadableStreamDefaultController<any> | null = null;

  constructor(
    target: NodeJS.WritableStream | ReadableStreamDefaultController<any>,
    private options: SSEStreamManagerOptions = {}
  ) {
    this.abortController = new AbortController();
    this.streamStartTime = Date.now();
    this.lastChunkTime = Date.now();
    
    if (this.isNodeStream(target)) {
      this.raw = target;
      this.setupConnectionMonitoring();
    } else {
      this.controller = target;
    }
    
    this.startHeartbeat();
    this.startStaggeredDetection();
  }

  private isNodeStream(target: any): target is NodeJS.WritableStream {
    return typeof (target as any).write === 'function' && typeof (target as any).on === 'function';
  }

  /**
   * Setup connection monitoring to detect client disconnects
   */
  private setupConnectionMonitoring(): void {
    if (!this.raw) return;

    // Monitor for client disconnect
    this.raw.on('close', () => {
      this.isConnected = false;
      this.abortController.abort();
      this.stopHeartbeat();
    });

    this.raw.on('error', (err) => {
      console.error('[SSEStreamManager] Stream error:', err);
      this.isConnected = false;
      this.abortController.abort();
      this.stopHeartbeat();
    });
  }

  /**
   * Start the heartbeat timer to send keepalive comments
   */
  private startHeartbeat(): void {
    if (this.options.enableKeepalive === false) return;

    const interval = this.options.heartbeatIntervalMs || 30000;
    let heartbeatInFlight = false;

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected) {
        this.stopHeartbeat();
        return;
      }
      if (heartbeatInFlight) return;

      // Send SSE comment as heartbeat if idle for longer than interval
      const idleTime = Date.now() - this.lastActivity;
      // Use 0.9 factor to fix timing precision issues where setInterval fires slightly early
      if (idleTime >= interval * 0.9) {
        heartbeatInFlight = true;
        try {
          // Send heartbeat without updating activity timestamps
          // to prevent interfering with data chunk tracking
          const success = await this.sendHeartbeat();
          if (!success) this.stopHeartbeat();
        } catch {
          this.stopHeartbeat();
        } finally {
          heartbeatInFlight = false;
        }
      }
    }, interval);
  }

  /**
   * Send a heartbeat ping without updating activity timestamps
   * This prevents the heartbeat from interfering with data chunk boundaries
   */
  private async sendHeartbeat(): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    // Don't update lastActivity or lastChunkTime for heartbeats
    // This ensures heartbeats don't interfere with data chunk tracking

    // Handle Web Stream Controller
    if (this.controller) {
      const chunk = new TextEncoder().encode(':ping\n\n');
      return enqueueWithBackpressure(
        this.controller,
        chunk,
        this.options.backpressureTimeoutMs
      );
    }

    // Handle Node.js Writable Stream
    if (this.raw) {
      if ((this.raw as any).writableEnded) {
        return false;
      }

      return new Promise((resolve) => {
        let resolved = false;
        const safeResolve = (value: boolean) => {
          if (!resolved) {
            resolved = true;
            resolve(value);
          }
        };

        const canContinue = this.raw!.write(':ping\n\n', (err) => {
          if (err) {
            console.error('[SSEStreamManager] Heartbeat write error:', err);
            this.isConnected = false;
            safeResolve(false);
          } else {
            safeResolve(true);
          }
        });

        // Handle backpressure
        if (!canContinue) {
          const timeout = setTimeout(() => {
            console.warn('[SSEStreamManager] Heartbeat backpressure timeout');
            safeResolve(false);
          }, this.options.backpressureTimeoutMs || 60000);

          this.raw!.once('drain', () => {
            clearTimeout(timeout);
            safeResolve(true);
          });
        }
      });
    }

    return false;
  }

  /**
   * Stop the heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Start staggered streaming detection
   * Monitors inter-chunk delays and token rates
   */
  private startStaggeredDetection(): void {
    if (this.options.enableStaggeredDetection === false) return;

    const checkInterval = 2000; // Check every 2 seconds
    const maxDelay = this.options.maxInterChunkDelayMs || 10000;

    this.staggeredCheckTimer = setInterval(() => {
      if (!this.isConnected || this.staggeredDetected) return;

      const now = Date.now();
      const delaySinceLastChunk = now - this.lastChunkTime;
      const streamDuration = now - this.streamStartTime;

      // Only check after we've received some chunks and stream has been active
      if (this.chunkCount < 3 || streamDuration < 5000) return;

      // Check if delay exceeds threshold
      if (delaySinceLastChunk > maxDelay) {
        const tokenRate = this.calculateTokenRate();
        const minRate = this.options.minTokenRate || 1;

        // Only flag if token rate is also below minimum (indicating stall, not just slow model)
        if (tokenRate < minRate) {
          this.staggeredDetected = true;
          const info: StaggeredStreamInfo = {
            delayMs: delaySinceLastChunk,
            tokenRate,
            chunkCount: this.chunkCount,
            streamDurationMs: streamDuration,
            detectedAt: now
          };

          console.warn(`[SSEStreamManager] Staggered streaming detected: ${delaySinceLastChunk}ms since last chunk, ${tokenRate.toFixed(2)} tokens/sec`);

          if (this.options.onStaggeredDetected) {
            this.options.onStaggeredDetected(info);
          }
        }
      }
    }, checkInterval);
  }

  /**
   * Stop staggered detection timer
   */
  private stopStaggeredDetection(): void {
    if (this.staggeredCheckTimer) {
      clearInterval(this.staggeredCheckTimer);
      this.staggeredCheckTimer = null;
    }
  }

  /**
   * Calculate current token rate (tokens per second)
   */
  private calculateTokenRate(): number {
    const duration = (Date.now() - this.streamStartTime) / 1000;
    return duration > 0 ? this.tokenCount / duration : 0;
  }

  /**
   * Update token count for rate calculation
   */
  updateTokenCount(count: number): void {
    this.tokenCount += count;
  }

  /**
   * Write data to the stream with backpressure handling
   * @returns Promise resolving to true if successful, false otherwise
   */
  async write(data: Uint8Array | string): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    this.lastActivity = Date.now();
    this.lastChunkTime = Date.now();
    this.chunkCount++;

    // Handle Web Stream Controller
    if (this.controller) {
      const chunk = typeof data === 'string' 
        ? new TextEncoder().encode(data) 
        : data;
        
      return enqueueWithBackpressure(
        this.controller, 
        chunk, 
        this.options.backpressureTimeoutMs
      );
    }

    // Handle Node.js Writable Stream
    if (this.raw) {
      if ((this.raw as any).writableEnded) {
        return false;
      }

      return new Promise((resolve) => {
        let resolved = false;
        const safeResolve = (value: boolean) => {
          if (!resolved) {
            resolved = true;
            resolve(value);
          }
        };

        const canContinue = this.raw!.write(data, (err) => {
          if (err) {
            console.error('[SSEStreamManager] Write error:', err);
            this.isConnected = false;
            safeResolve(false);
          } else {
            safeResolve(true);
          }
        });

        // Handle backpressure - wait for drain event if buffer is full
        if (!canContinue) {
          const timeout = setTimeout(() => {
            console.warn('[SSEStreamManager] Backpressure timeout');
            safeResolve(false);
          }, this.options.backpressureTimeoutMs || 60000);

          this.raw!.once('drain', () => {
            clearTimeout(timeout);
            safeResolve(true);
          });
        }
      });
    }

    return false;
  }

  /**
   * End the stream gracefully
   */
  async end(): Promise<void> {
    this.stopHeartbeat();
    this.stopStaggeredDetection();
    
    if (this.controller) {
      try {
        this.controller.close();
      } catch (err) {
        // Controller might be already closed
        console.warn('[SSEStreamManager] Error closing controller:', err);
      }
      return;
    }

    if (this.raw && !(this.raw as any).writableEnded) {
      return new Promise((resolve) => {
        this.raw!.end(() => resolve());
      });
    }
  }

  /**
   * Abort the stream immediately (for external termination)
   */
  abort(): void {
    this.isConnected = false;
    this.abortController.abort();
    this.stopHeartbeat();
  }

  /**
   * Get the abort signal for this stream
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if the connection is still active
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Check if stream has been idle for too long
   */
  isIdleTooLong(): boolean {
    const maxIdle = this.options.maxIdleTimeMs || 120000;
    return Date.now() - this.lastActivity > maxIdle;
  }
}

/**
 * Read from a stream reader with timeout and abort signal support
 * This prevents indefinite blocking on reader.read()
 */
export async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number = 60000,
  abortSignal?: AbortSignal
): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    let readCompleted = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      abortSignal.addEventListener('abort', onAbort);
    }

    // Set timeout
    timeoutId = setTimeout(() => {
      cleanup();
      if (!readCompleted) {
        // Log that a read is still pending — the data will be lost
        console.warn('[SSEStreamManager] Read timeout with pending read — data may be lost');
      }
      reject(new Error('Read timeout'));
    }, timeoutMs);

    // Start reading
    reader.read().then(
      (result) => {
        readCompleted = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        readCompleted = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * Write to a controller with backpressure handling
 * Waits for desiredSize to become positive before enqueueing
 */
export async function enqueueWithBackpressure<T>(
  controller: ReadableStreamDefaultController<T>,
  data: T,
  maxWaitMs: number = 60000
): Promise<boolean> {
  const startTime = Date.now();

  while (controller.desiredSize !== null && controller.desiredSize <= 0) {
    if (Date.now() - startTime > maxWaitMs) {
      console.warn('[SSEStreamManager] Backpressure timeout in controller');
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  try {
    controller.enqueue(data);
    return true;
  } catch (error) {
    console.error('[SSEStreamManager] Controller enqueue error:', error);
    return false;
  }
}

export default SSEStreamManager;
