import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { AVAILABLE_MODELS, AVAILABLE_AGENTS } from '../../../shared/constants';
import type { ProjectSettings } from '../../../shared/types';

interface AgentConfigSectionProps {
  settings: ProjectSettings;
  onUpdateSettings: (updates: Partial<ProjectSettings>) => void;
}

export function AgentConfigSection({ settings, onUpdateSettings }: AgentConfigSectionProps) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Agent Configuration</h3>

      {/* Agent Backend Selector */}
      <div className="space-y-2">
        <Label htmlFor="agent" className="text-sm font-medium text-foreground">AI Agent</Label>
        <Select
          value={settings.defaultAgent || 'claude'}
          onValueChange={(value: 'claude' | 'gemini' | 'opencode') => onUpdateSettings({ defaultAgent: value })}
        >
          <SelectTrigger id="agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_AGENTS.map((agent) => (
              <SelectItem key={agent.value} value={agent.value}>
                <div className="flex flex-col">
                  <span>{agent.label}</span>
                  <span className="text-xs text-muted-foreground">{agent.description}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Select the AI agent backend to use for task execution. Gemini and OpenCode require their respective CLIs to be installed.
        </p>
      </div>

      {/* Model Selector */}
      <div className="space-y-2">
        <Label htmlFor="model" className="text-sm font-medium text-foreground">Default Model</Label>
        <Select
          value={settings.model}
          onValueChange={(value) => onUpdateSettings({ model: value })}
        >
          <SelectTrigger id="model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_MODELS.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
