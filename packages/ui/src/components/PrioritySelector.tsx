import React, { useState, useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Label } from './ui/label';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export type PriorityLevel = 'high' | 'normal' | 'low';

interface PrioritySelectorProps {
  value?: PriorityLevel;
  onChange?: (priority: PriorityLevel) => void;
  className?: string;
}

const PRIORITY_VALUES: Record<PriorityLevel, number> = {
  high: 10,
  normal: 0,
  low: -10,
};

const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const PRIORITY_DESCRIPTIONS: Record<PriorityLevel, string> = {
  high: 'Requests with high priority are processed first when models are at capacity',
  normal: 'Standard priority for most requests',
  low: 'Requests with low priority are processed when no higher priority requests are waiting',
};

export function PrioritySelector({ value, onChange, className }: PrioritySelectorProps) {
  const [priority, setPriority] = useState<PriorityLevel>(value || 'normal');

  useEffect(() => {
    if (value) {
      setPriority(value);
    }
  }, [value]);

  const handleChange = (newValue: PriorityLevel) => {
    setPriority(newValue);
    onChange?.(newValue);
    
    // Store preference in localStorage
    localStorage.setItem('ccr-request-priority', newValue);
  };

  // Load saved preference on mount
  useEffect(() => {
    const saved = localStorage.getItem('ccr-request-priority') as PriorityLevel;
    if (saved && !value) {
      setPriority(saved);
      onChange?.(saved);
    }
  }, [value, onChange]);

  return (
    <div className={className}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="priority-select">Request Priority</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-gray-400 cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{PRIORITY_DESCRIPTIONS[priority]}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <Select value={priority} onValueChange={handleChange}>
          <SelectTrigger id="priority-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PRIORITY_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-gray-500 mt-1">
          {PRIORITY_DESCRIPTIONS[priority]}
        </p>
      </div>
    </div>
  );
}

/**
 * Hook to get current priority level for API requests
 */
export function useRequestPriority(): PriorityLevel {
  const [priority, setPriority] = useState<PriorityLevel>('normal');

  useEffect(() => {
    const saved = localStorage.getItem('ccr-request-priority') as PriorityLevel;
    if (saved && PRIORITY_VALUES[saved] !== undefined) {
      setPriority(saved);
    }
  }, []);

  return priority;
}

/**
 * Get priority value (number) for a priority level
 */
export function getPriorityValue(priority: PriorityLevel): number {
  return PRIORITY_VALUES[priority];
}