import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import type { FailoverInstance, Provider } from "@/types";

interface FailoverConfigProps {
  failover: FailoverInstance[];
  providers: Provider[];
  onChange: (failover: FailoverInstance[]) => void;
}

export function FailoverConfig({ failover, providers, onChange }: FailoverConfigProps) {
  const { t } = useTranslation();

  const handleAddInstance = (value: string) => {
    const [providerName, modelName] = value.split(",");
    if (providerName && modelName) {
      const newInstance: FailoverInstance = {
        provider: providerName,
        model: modelName
      };
      onChange([...failover, newInstance]);
    }
  };

  const handleRemoveInstance = (index: number) => {
    const newFailover = failover.filter((_, i) => i !== index);
    onChange(newFailover);
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newFailover = [...failover];
    [newFailover[index - 1], newFailover[index]] = [newFailover[index], newFailover[index - 1]];
    onChange(newFailover);
  };

  const handleMoveDown = (index: number) => {
    if (index === failover.length - 1) return;
    const newFailover = [...failover];
    [newFailover[index], newFailover[index + 1]] = [newFailover[index + 1], newFailover[index]];
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

  return (
    <div className="space-y-3">
      <Label>{t("router.failover_instances")}</Label>
      <p className="text-sm text-gray-500">{t("router.failover_description")}</p>
      
      {failover.length > 0 ? (
        <div className="space-y-2">
          {failover.map((instance, index) => (
            <div key={index} className="flex items-center gap-2 border rounded-md p-2">
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleMoveUp(index)}
                  disabled={index === 0}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleMoveDown(index)}
                  disabled={index === failover.length - 1}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
              
              <div className="flex-1">
                <Badge variant="outline" className="font-normal">
                  {instance.provider}, {instance.model}
                </Badge>
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-red-500 hover:text-red-700"
                onClick={() => handleRemoveInstance(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-500 italic">{t("router.no_failover_instances")}</div>
      )}
      
      <div className="flex gap-2">
        <div className="flex-1">
          <Combobox
            options={modelOptions}
            value=""
            onChange={handleAddInstance}
            placeholder={t("router.add_failover_instance")}
            searchPlaceholder={t("router.search_model")}
            emptyPlaceholder={t("router.no_model_found")}
          />
        </div>
        <Button variant="outline" disabled>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
