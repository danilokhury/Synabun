import { existsSync } from 'node:fs';

function assertSingleLine(value, label) {
  const text = String(value ?? '');
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error(`${label} must be a non-empty single-line value`);
  }
  return text;
}

function codexReasoningEffort(effort) {
  const value = String(effort || '').trim().toLowerCase();
  if (!value || value === 'off') return null;
  if (value === 'max') return 'xhigh';
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : null;
}

function codexConfigString(value) {
  return JSON.stringify(String(value));
}

/**
 * Split the configurable CLI command into an executable and fixed arguments.
 * Settings intentionally supports prefixes such as `wsl -d Ubuntu gemini`.
 * An existing path wins before tokenization so unquoted executable paths with
 * spaces keep working; quoted paths are handled by the tokenizer.
 */
export function parseConfiguredCommand(
  value,
  {
    platform = process.platform,
    exists = existsSync,
  } = {},
) {
  const text = assertSingleLine(value, 'CLI command').trim();
  if (exists(text)) return { command: text, args: [] };

  const tokens = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;
  const supportsSingleQuotes = platform !== 'win32';

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
      } else if (char === '\\' && text[index + 1] === quote) {
        token += quote;
        tokenStarted = true;
        index++;
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (char === '"' || (supportsSingleQuotes && char === "'")) {
      quote = char;
      tokenStarted = true;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) throw new Error('CLI command contains an unmatched quote');
  if (tokenStarted) tokens.push(token);
  if (!tokens[0]) throw new Error('CLI command must include an executable');
  return { command: tokens[0], args: tokens.slice(1) };
}

export function buildExecInvocation({
  profile,
  command,
  cwd,
  model,
  effort,
  mcpEnvOverrides = [],
  platform = process.platform,
  commandExists = existsSync,
} = {}) {
  const configured = parseConfiguredCommand(command || profile, {
    platform,
    exists: commandExists,
  });
  const executable = configured.command;
  const args = [...configured.args];

  switch (profile) {
    case 'codex': {
      args.push('exec', '--dangerously-bypass-approvals-and-sandbox');
      for (const [key, value] of mcpEnvOverrides) {
        args.push('-c', `mcp_servers.SynaBun.env.${key}=${codexConfigString(value)}`);
      }
      const normalizedEffort = codexReasoningEffort(effort);
      if (normalizedEffort) args.push('-c', `model_reasoning_effort=${codexConfigString(normalizedEffort)}`);
      if (model) args.push('--model', String(model));
      if (cwd) args.push('-C', String(cwd));
      args.push('-');
      break;
    }
    case 'gemini':
      if (model) args.push('--model', String(model));
      break;
    case 'opencode':
      args.push('run', '--dangerously-skip-permissions');
      if (model) args.push('--model', String(model));
      args.push('--format', 'default');
      break;
    default:
      break;
  }

  for (const arg of args) assertSingleLine(arg, 'CLI argument');
  return { command: executable, args };
}

export function posixShellQuote(value) {
  const text = assertSingleLine(value, 'Shell argument');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote one argv value for a Windows batch file. This follows the standard
 * CommandLineToArgvW backslash/quote rules and doubles percent signs so paths
 * such as "100% Ready" cannot be mistaken for batch variable expansion.
 * Delayed expansion is disabled in the generated wrapper, preserving '!'.
 */
export function windowsBatchQuote(value, expansionPasses = 1) {
  const percentEscape = '%'.repeat(2 ** Math.max(1, Number(expansionPasses) || 1));
  const text = assertSingleLine(value, 'Batch argument').replace(/%/g, percentEscape);
  let result = '"';
  let backslashes = 0;
  for (const char of text) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

export function execWrapperExtension(platform = process.platform) {
  return platform === 'win32' ? '.cmd' : '.sh';
}

export function renderExecWrapper({
  platform = process.platform,
  command,
  args = [],
  taskFile,
  sentinel,
} = {}) {
  const executable = assertSingleLine(command, 'CLI command');
  const inputPath = assertSingleLine(taskFile, 'Task file');
  const marker = assertSingleLine(sentinel, 'Iteration sentinel');
  if (!/^SYNABUN_ITER_DONE_\d+$/.test(marker)) {
    throw new Error(`Invalid iteration sentinel: ${marker}`);
  }

  if (platform === 'win32') {
    const needsCall = !/\.(?:exe|com)$/i.test(executable);
    // CALL reparses its command line. Escape percent signs for both the batch
    // file's initial expansion and CALL's second expansion.
    const quote = (value) => windowsBatchQuote(value, needsCall ? 2 : 1);
    const invocation = [quote(executable), ...args.map(quote)].join(' ');
    return [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `${needsCall ? 'call ' : ''}${invocation} < ${quote(inputPath)}`,
      'set "SYNABUN_RC=%ERRORLEVEL%"',
      `echo ${marker} rc=%SYNABUN_RC%`,
      'endlocal',
      'exit /b 0',
      '',
    ].join('\r\n');
  }

  const invocation = [posixShellQuote(executable), ...args.map(posixShellQuote)].join(' ');
  return [
    '#!/bin/sh',
    `${invocation} < ${posixShellQuote(inputPath)}`,
    'synabun_rc=$?',
    `printf '%s rc=%s\\n' ${posixShellQuote(marker)} "$synabun_rc"`,
    'exit 0',
    '',
  ].join('\n');
}

export function execWrapperLaunchCommand(wrapperFile, platform = process.platform) {
  const path = assertSingleLine(wrapperFile, 'Wrapper file');
  return platform === 'win32'
    ? `call ${windowsBatchQuote(path)}`
    : `sh ${posixShellQuote(path)}`;
}
