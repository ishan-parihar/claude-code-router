import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ArrowUp, ArrowDown, Trash2, Plus, Globe } from "lucide-react";
import type { Provider } from "@/types";

interface FailoverConfigProps {
  failover: Record<string, (string | { provider: string; model: string })[]>;
  providers: Provider[];
  defaultModel: string;
  onChange: (failover: Record<string, (string | { provider: string; model: string })[]>) => void;
}

export function FailoverConfig({ failover, providers, defaultModel, onChange }: FailoverConfigProps) {
  const { t } = useTranslation();

  // Extract provider name from default model (e.g., "iflow,glm-4.7" -> "iflow")
  const defaultProvider = defaultModel.split(",")[0] || "";

  const handleAddFailoverForProvider = (providerName: string, value: string) => {
    const [targetProvider, modelName] = value.split(",");
    if (targetProvider && modelName) {
      const newFailover = { ...failover };
      if (!newFailover[providerName]) {
        newFailover[providerName] = [];
      }
      newFailover[providerName].push({ provider: targetProvider, model: modelName });
      onChange(newFailover);
    }
  };

  const handleAddGlobalFailover = (value: string) => {
    const [targetProvider, modelName] = value.split(",");
    if (targetProvider) {
      const newFailover = { ...failover };
      if (!newFailover.global) {
        newFailover.global = [];
      }
      newFailover.global.push({ provider: targetProvider, model: modelName });
      onChange(newFailover);
    }
  };

  const handleAddStringFailoverForProvider = (providerName: string, targetProvider: string) => {
    const newFailover = { ...failover };
    if (!newFailover[providerName]) {
      newFailover[providerName] = [];
    }
    newFailover[providerName].push(targetProvider);
    onChange(newFailover);
  };

  const handleRemoveFailover = (providerName: string, index: number, isGlobal: boolean = false) => {
    const key = isGlobal ? "global" : providerName;
    const newFailover = { ...failover };
    if (newFailover[key]) {
      newFailover[key] = newFailover[key].filter((_, i) => i !== index);
      if (newFailover[key].length === 0) {
        delete newFailover[key];
      }
      onChange(newFailover);
    }
  };

  const handleMoveUp = (providerName: string, index: number, isGlobal: boolean = false) => {
    const key = isGlobal ? "global" : providerName;
    if (index === 0) return;
    const newFailover = { ...failover };
    if (newFailover[key]) {
      const arr = [...newFailover[key]];
      [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
      newFailover[key] = arr;
      onChange(newFailover);
    }
  };

  const handleMoveDown = (providerName: string, index: number, isGlobal: boolean = false) => {
    const key = isGlobal ? "global" : providerName;
    if (!failover[key] || index === failover[key].length - 1) return;
    const newFailover = { ...failover };
    const arr = [...newFailover[key]];
    [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
    newFailover[key] = arr;
    onChange(newFailover);
  };

  const modelOptions = providers.flatMap((provider) => {
    if (!provider) return [];
    const models = Array.isArray(provider.models) ? provider.models : [];
    const providerName = provider.name || "Unknown Provider";
    return models.map((model) => ({
      value: `${providerName},${model || "Unknown Model"}`,
      label: `${providerName}, ${model || "Unknown Model"}`,
    }));
  });

  const providerOptions = providers
    .filter(p => p && p.name)
    .map(p => ({
      value: p.name!,
      label: p.name!
    }));

  const renderFailoverItem = (
    item: string | { provider: string; model: string },
    index: number,
    providerName: string,
    isGlobal: boolean = false
  ) => {
    const displayText = typeof item === "string" ? item : `${item.provider},${item.model}`;
    return (
      <div key={index} className="flex items-center gap-2 border rounded-md p-2">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleMoveUp(providerName, index, isGlobal)}
            disabled={index === 0}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleMoveDown(providerName, index, isGlobal)}
            disabled={!failover[isGlobal ? "global" : providerName] || index === failover[isGlobal ? "global" : providerName].length - 1}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1">
          <Badge variant="outline" className="font-normal">
            {displayText}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-red-500 hover:text-red-700"
          onClick={() => handleRemoveFailover(providerName, index, isGlobal)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  const renderProviderFailover = (providerName: string) => {
    const failoverList = failover[providerName];
    if (!failoverList || failoverList.length === 0) return null;

    return (
      <div key={providerName} className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium text-gray-700">
            {providerName}
          </Label>
        </div>
        <div className="space-y-2 ml-4">
          {failoverList.map((item, index) => renderFailoverItem(item, index, providerName, false))}
        </div>
        <div className="flex gap-2 ml-4">
          <div className="flex-1">
            <Combobox
              options={modelOptions}
              value=""
              onChange={(value) => handleAddFailoverForProvider(providerName, value)}
              placeholder={`Add failover for ${providerName}`}
              searchPlaceholder="Search model"
              emptyPlaceholder="No model found"
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Label>{t("router.failover_config")}</Label>
      <p className="text-sm text-gray-500">
        Configure failover providers for when the primary model is rate-limited or unavailable.
        Failover is only enabled for custom-model (default scenario).
      </p>

      {/* Provider-specific failover */}
      <div className="space-y-3">
        <Label className="text-sm font-medium text-gray-700 flex items-center gap-2">
          <span>Provider Failover</span>
        </Label>

        {providers.map((provider) => {
          if (!provider?.name) return null;
          return <div key={provider.name}>{renderProviderFailover(provider.name)}</div>;
        })}
      </div>

      {/* Global failover */}
      <div className="space-y-3 border-t pt-3">
        <Label className="text-sm font-medium text-gray-700 flex items-center gap-2">
          <Globe className="h-4 w-4" />
          <span>Global Failover</span>
        </Label>
        <p className="text-xs text-gray-500">
          Global failover providers are used as a last resort when provider-specific failover is not configured.
        </p>

        {failover.global && failover.global.length > 0 ? (
          <div className="space-y-2 ml-4">
            {failover.global.map((item, index) => renderFailoverItem(item, index, "global", true))}
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic ml-4">No global failover configured</div>
        )}

        <div className="flex gap-2 ml-4">
          <div className="flex-1">
            <Combobox
              options={modelOptions}
              value=""
              onChange={handleAddGlobalFailover}
              placeholder="Add global failover"
              searchPlaceholder="Search model"
              emptyPlaceholder="No model found"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
