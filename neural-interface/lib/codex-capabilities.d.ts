export interface CodexRuntime {
  cliVersion?: string | null;
  sdkVersion?: string | null;
  codexBin?: string;
  codexBinSource?: string;
  accountId?: string;
  codexHome?: string;
  protocolBaseline: string;
  experimentalApi: boolean;
  serverInfo?: Record<string, unknown>;
}
export interface CodexCapability {
  method: string;
  supported: boolean;
  experimental: boolean;
  reason: string | null;
}
export interface CodexCapabilityPacket {
  type: 'capabilities';
  requestId?: string | null;
  capabilities: Record<string, CodexCapability>;
  runtime: CodexRuntime;
  sessionId?: string;
  connectionEpoch?: string;
}
export const CODEX_PROTOCOL_BASELINE: '0.160.0';
export const CODEX_CAPABILITY_METHODS: Readonly<Record<string, { method: string; experimental: boolean; unavailable?: string }>>;
export function parseCodexVersion(value: unknown): string | null;
export function isCodexUnsupportedMethod(error: unknown): boolean;
export function classifyCodexRpcError(error: unknown, methodName?: string): { code: string | number | null; category: 'unsupported' | 'invalid_request' | 'authentication' | 'restricted' | 'transient' | 'runtime'; message: string };
export function validateCodexConfigRequirements<T extends Record<string, unknown>>(config: T, requirements: unknown): T;
export class CodexCapabilityRegistry {
  constructor(runtime?: Partial<CodexRuntime>);
  runtime: CodexRuntime;
  requirements: Record<string, unknown> | null;
  reset(runtime?: Partial<CodexRuntime>): void;
  updateRequirements(result: unknown): void;
  observe(method: string, error?: unknown): boolean;
  snapshot(): Record<string, CodexCapability>;
  assertAvailable(name: string): void;
}
