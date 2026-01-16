import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { RefreshCw, AlertCircle, CheckCircle, Clock, Zap } from 'lucide-react';

interface ModelSlotStatus {
  provider: string;
  model: string;
  activeRequests: number;
  maxConcurrent: number;
  queuedRequests: number;
  circuitBreakerOpen: boolean;
  circuitBreakerOpenUntil: string | null;
  rateLimitUntil: string | null;
  failureCount: number;
  successCount: number;
  successRate: number;
  lastUsed: string;
}

interface QueueStatus {
  queueLength: number;
  oldestRequestTimestamp: number;
  oldestRequestAge: number;
  priorityRange: {
    min: number;
    max: number;
  };
}

export function ModelPoolStatus() {
  const [status, setStatus] = useState<Record<string, ModelSlotStatus>>({});
  const [queueStatus, setQueueStatus] = useState<Record<string, QueueStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [statusRes, queueRes] = await Promise.all([
        fetch('/api/model-pool/status'),
        fetch('/api/model-pool/queue'),
      ]);
      
      if (!statusRes.ok || !queueRes.ok) {
        throw new Error('Failed to fetch status');
      }
      
      const statusData = await statusRes.json();
      const queueData = await queueRes.json();
      
      setStatus(statusData);
      setQueueStatus(queueData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  };

  const resetCircuitBreakers = async () => {
    try {
      await fetch('/api/model-pool/reset-circuit-breakers', { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset circuit breakers');
    }
  };

  const clearQueue = async () => {
    try {
      await fetch('/api/model-pool/clear-queue', { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear queue');
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const getStatusIcon = (slot: ModelSlotStatus) => {
    if (slot.circuitBreakerOpen) {
      return <AlertCircle className="h-4 w-4 text-red-500" />;
    }
    if (slot.rateLimitUntil) {
      return <Clock className="h-4 w-4 text-yellow-500" />;
    }
    if (slot.activeRequests >= slot.maxConcurrent) {
      return <Zap className="h-4 w-4 text-orange-500" />;
    }
    return <CheckCircle className="h-4 w-4 text-green-500" />;
  };

  const getStatusBadge = (slot: ModelSlotStatus) => {
    if (slot.circuitBreakerOpen) {
      return <Badge variant="destructive">Circuit Breaker Open</Badge>;
    }
    if (slot.rateLimitUntil) {
      return <Badge variant="secondary">Rate Limited</Badge>;
    }
    if (slot.activeRequests >= slot.maxConcurrent) {
      return <Badge variant="outline">At Capacity</Badge>;
    }
    return <Badge variant="default">Available</Badge>;
  };

  const formatAge = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  if (loading && Object.keys(status).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Model Pool Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Model Pool Status</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchStatus}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={resetCircuitBreakers}>
              Reset Circuit Breakers
            </Button>
            <Button variant="outline" size="sm" onClick={clearQueue}>
              Clear Queue
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {Object.keys(status).length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-8">
            No models in pool yet. Make a request to initialize.
          </p>
        ) : (
          <div className="space-y-4">
            {Object.entries(status).map(([key, slot]) => (
              <div
                key={key}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(slot)}
                    <h3 className="font-semibold">{key}</h3>
                  </div>
                  {getStatusBadge(slot)}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500">Active Requests</p>
                    <p className="font-semibold">
                      {slot.activeRequests} / {slot.maxConcurrent}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Queued Requests</p>
                    <p className="font-semibold">{slot.queuedRequests}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Success Rate</p>
                    <p className="font-semibold">{slot.successRate.toFixed(1)}%</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Last Used</p>
                    <p className="font-semibold">
                      {new Date(slot.lastUsed).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                {slot.circuitBreakerOpen && slot.circuitBreakerOpenUntil && (
                  <div className="text-sm text-red-600">
                    Circuit breaker open until{' '}
                    {new Date(slot.circuitBreakerOpenUntil).toLocaleString()}
                  </div>
                )}

                {slot.rateLimitUntil && (
                  <div className="text-sm text-yellow-600">
                    Rate limited until{' '}
                    {new Date(slot.rateLimitUntil).toLocaleString()}
                  </div>
                )}

                {queueStatus[key] && queueStatus[key].queueLength > 0 && (
                  <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
                    <p className="font-medium">Queue Status</p>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div>
                        <span className="text-gray-500">Length:</span>{' '}
                        <span className="font-semibold">{queueStatus[key].queueLength}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Oldest:</span>{' '}
                        <span className="font-semibold">
                          {formatAge(queueStatus[key].oldestRequestAge)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Priority Range:</span>{' '}
                        <span className="font-semibold">
                          {queueStatus[key].priorityRange.min} - {queueStatus[key].priorityRange.max}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}