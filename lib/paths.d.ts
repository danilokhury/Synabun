export interface DataHomeOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  os?: NodeJS.Platform;
}

export interface DataHomeDiagnostics {
  dataHome: string;
  packageRoot: string;
  explicitOverride: boolean;
  dataHomeInsidePackage: boolean;
  recommendedDataHome: string;
}

export const PACKAGE_ROOT: string;
export function isGlobalInstall(): boolean;
export function getPlatformDataHome(options?: DataHomeOptions): string;
export function getDataHome(options?: DataHomeOptions): string;
export function pathIsInside(candidate: string, parent: string): boolean;
export function getDataHomeDiagnostics(dataHome?: string, packageRoot?: string, options?: DataHomeOptions): DataHomeDiagnostics;
export function ensureDataDirs(dataHome: string): void;
