/**
 * web/views/config-form.js 的类型声明（供 TS 测试 import；权威运行时行为见 config-form.js）。
 */
export const SECRET_KIND: string;

export function isMaskedValue(value: unknown): boolean;
export function assertNotMasked(value: string, field: string): void;

export interface SecretWriteBody {
  kind: string;
  value: string;
  label: string;
}
export function buildSecretWriteBody(form: {
  label: string;
  value: string;
  kind?: string;
}): SecretWriteBody;

export function buildSecretRenameBody(form: { label: string }): { label: string };

export interface PresetPayload {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  secretKind: string;
  secretId?: string;
  jsonMode?: boolean;
  reasoningEffort?: string;
}
export function buildPresetPayload(form: {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  secretKind?: string;
  secretId?: string;
  jsonMode?: string | boolean;
  reasoningEffort?: string;
}): PresetPayload;

export interface AgentPresetsPatch {
  agentPresets: { character?: string; gm?: string; prose?: string };
}
export function buildAgentPresetsPatch(selected: {
  character?: string;
  gm?: string;
  prose?: string;
}): AgentPresetsPatch;

export interface SettingsPatch {
  proseWindowTurns?: number;
  gmIntervalCycles?: number;
}
export function buildSettingsPatch(form: {
  proseWindowTurns?: string;
  gmIntervalCycles?: string;
}): SettingsPatch;
