/**
 * Session Chunker — Pure function that splits parsed JSONL lines into task-boundary chunks.
 * No I/O, no external dependencies. Fully testable.
 */

const TASK_BOUNDARY_GAP_MS = 120_000; // 2 minutes between human turns = new task
const MAX_CONTENT_CHARS = 8000;       // Max synthesized content per chunk
const MAX_USER_MESSAGES = 5;          // Max user messages to include in synthesis
const MAX_USER_MSG_CHARS = 200;       // Max chars per user message in synthesis
const MAX_ASSISTANT_CHARS = 500;      // Max chars for assistant text per chunk

/**
 * @typedef {Object} ParsedLine
 * @property {string} type - queue-operation | file-history-snapshot | progress | user | assistant
 * @property {string} [sessionId]
 * @property {string} [cwd]
 * @property {string} [gitBranch]
 * @property {string} [timestamp]
 * @property {string} [uuid]
 * @property {boolean} [isMeta]
 * @property {boolean} [isSidechain]
 * @property {Object} [message]
 * @property {Object} [toolUseResult]
 * @property {string} [sourceToolAssistantUUID]
 */

/**
 * @typedef {Object} RawChunk
 * @property {number} chunkIndex
 * @property {string} startTimestamp
 * @property {string} endTimestamp
 * @property {string[]} userMessages - Cleaned human prompts
 * @property {string[]} assistantTexts - Assistant response snippets
 * @property {string[]} toolsUsed
 * @property {string[]} filesModified
 * @property {string[]} filesRead
 * @property {number} turnCount - Human turns in this chunk
 * @property {string} content - Synthesized text for embedding
 * @property {string} summary - One-line human-readable summary
 * @property {number} startLineIndex
 * @property {number} endLineIndex
 */

/**
 * Check if a user message is a real human prompt (not a tool result or meta).
 */
function isHumanMessage(line) {
  if (line.type !== 'user') return false;
  if (line.isMeta) return false;
  if (line.toolUseResult || line.sourceToolAssistantUUID) return false;
  // Check content for actual text (not just tool results)
  const content = line.message?.content;
  if (!content) return false;
  if (Array.isArray(content)) {
    return content.some(block =>
      block.type === 'text' && block.text && block.text.length > 5
    );
  }
  return typeof content === 'string' && content.length > 5;
}

/**
 * Extract clean text from a user message, stripping IDE/system tags.
 */
function extractUserText(line) {
  const content = line.message?.content;
  if (!content) return '';
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const texts = [];
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue;
    // Strip system-reminder, ide_opened_file, and antml tags
    let text = block.text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
      .replace(/<[\s\S]*?<\/antml:[^>]+>/g, '')
      .trim();
    if (text.length > 5) texts.push(text);
  }
  return texts.join(' ').trim();
}

/**
 * Extract assistant text blocks from an assistant message.
 */
function extractAssistantText(line) {
  const content = line.message?.content;
  if (!content || !Array.isArray(content)) return '';
  const texts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    }
    // Skip 'thinking' blocks — internal reasoning
  }
  return texts.join(' ').trim();
}

/**
 * Extract tool use info from an assistant message.
 */
function extractToolUses(line) {
  const content = line.message?.content;
  if (!content || !Array.isArray(content)) return [];
  const tools = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const tool = { name: block.name, input: block.input || {} };
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * Extract file paths from tool use inputs.
 */
function extractFilesFromToolUse(toolUse) {
  const modified = [];
  const read = [];
  const name = toolUse.name;
  const input = toolUse.input || {};

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = input.file_path || input.notebook_path;
    if (fp) modified.push(normalizePath(fp));
  } else if (name === 'Read') {
    const fp = input.file_path;
    if (fp) read.push(normalizePath(fp));
  } else if (name === 'Grep' || name === 'Glob') {
    // These search but don't read specific files
  }

  return { modified, read };
}

/**
 * Normalize a file path for display (strip drive letter prefix, use forward slashes).
 */
function normalizePath(fp) {
  return fp.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
}

/**
 * Normalize tool name (strip mcp__ prefix for display).
 */
function normalizeToolName(name) {
  return name.replace(/^mcp__\w+__/, '');
}

/**
 * Parse a single JSONL line safely.
 */
export function parseLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Main chunking function.
 * @param {ParsedLine[]} lines - Parsed JSONL objects (already JSON.parse'd)
 * @param {Object} sessionMeta - { sessionId, project, gitBranch, cwd }
 * @returns {RawChunk[]}
 */
export function chunkSession(lines, sessionMeta) {
  const chunks = [];
  let current = createEmptyChunk(0);
  let lastTimestamp = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Skip non-content types
    if (line.type === 'queue-operation' || line.type === 'file-history-snapshot' || line.type === 'progress') {
      continue;
    }

    // Skip sidechains (subagent messages logged in main transcript)
    if (line.isSidechain) continue;

    const ts = line.timestamp;

    if (isHumanMessage(line)) {
      // Check for task boundary: time gap > threshold
      if (lastTimestamp && ts) {
        const gap = new Date(ts).getTime() - new Date(lastTimestamp).getTime();
        if (gap > TASK_BOUNDARY_GAP_MS && current.turnCount > 0) {
          chunks.push(finalizeChunk(current, sessionMeta));
          current = createEmptyChunk(chunks.length);
        }
      }

      // Check for interruption pattern in content
      const userText = extractUserText(line);
      if (userText) {
        current.userMessages.push(userText.slice(0, MAX_USER_MSG_CHARS));
        current.turnCount++;
      }
      if (ts && !current.startTimestamp) current.startTimestamp = ts;
      if (ts) current.endTimestamp = ts;
      current.startLineIndex = Math.min(current.startLineIndex, i);
      current.endLineIndex = i;

    } else if (line.type === 'user' && line.isMeta) {
      // Skip meta messages
      continue;

    } else if (line.type === 'user' && (line.toolUseResult || line.sourceToolAssistantUUID)) {
      // Tool result — extract file info from toolUseResult
      if (ts) current.endTimestamp = ts;
      current.endLineIndex = i;

    } else if (line.type === 'assistant') {
      // Extract assistant text
      const assistantText = extractAssistantText(line);
      if (assistantText) {
        current.assistantTexts.push(assistantText);
      }

      // Extract tool uses
      const toolUses = extractToolUses(line);
      for (const tu of toolUses) {
        const toolName = normalizeToolName(tu.name);
        if (!current._toolCounts[toolName]) current._toolCounts[toolName] = 0;
        current._toolCounts[toolName]++;

        const files = extractFilesFromToolUse(tu);
        for (const f of files.modified) {
          if (!current.filesModified.includes(f)) current.filesModified.push(f);
        }
        for (const f of files.read) {
          if (!current.filesRead.includes(f)) current.filesRead.push(f);
        }
      }

      if (ts && !current.startTimestamp) current.startTimestamp = ts;
      if (ts) {
        current.endTimestamp = ts;
        lastTimestamp = ts;
      }
      current.endLineIndex = i;
    }
  }

  // Finalize last chunk if it has content
  if (current.turnCount > 0) {
    chunks.push(finalizeChunk(current, sessionMeta));
  }

  // Post-process: split oversized chunks
  const result = [];
  for (const chunk of chunks) {
    if (chunk.content.length > MAX_CONTENT_CHARS) {
      // For now, just truncate — splitting at tool boundaries is complex
      chunk.content = chunk.content.slice(0, MAX_CONTENT_CHARS);
    }
    result.push(chunk);
  }

  return result;
}

function createEmptyChunk(index) {
  return {
    chunkIndex: index,
    startTimestamp: '',
    endTimestamp: '',
    userMessages: [],
    assistantTexts: [],
    toolsUsed: [],
    filesModified: [],
    filesRead: [],
    turnCount: 0,
    content: '',
    summary: '',
    startLineIndex: Infinity,
    endLineIndex: 0,
    _toolCounts: {}, // internal, removed during finalize
  };
}

function finalizeChunk(chunk, sessionMeta) {
  // Build tools_used from counts
  chunk.toolsUsed = Object.entries(chunk._toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name);

  // Build tool counts string for synthesis
  const toolCountStr = Object.entries(chunk._toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}(${count})`)
    .join(', ');

  // Build synthesized content for embedding
  const parts = [];

  // Header
  const date = chunk.startTimestamp ? new Date(chunk.startTimestamp).toISOString().split('T')[0] : 'unknown';
  parts.push(`[Project: ${sessionMeta.project || 'unknown'} | Branch: ${sessionMeta.gitBranch || 'unknown'} | ${date}]`);

  // User messages (max 5)
  const userMsgs = chunk.userMessages.slice(0, MAX_USER_MESSAGES);
  for (const msg of userMsgs) {
    parts.push(`USER: "${msg}"`);
  }

  // Assistant summary (combine and truncate)
  const fullAssistant = chunk.assistantTexts.join(' ');
  if (fullAssistant) {
    const truncated = fullAssistant.slice(0, MAX_ASSISTANT_CHARS);
    parts.push(`ASSISTANT: ${truncated}`);
  }

  // Tools and files
  if (toolCountStr) {
    parts.push(`TOOLS: ${toolCountStr}`);
  }
  if (chunk.filesModified.length > 0) {
    parts.push(`FILES MODIFIED: ${chunk.filesModified.slice(0, 10).join(', ')}`);
  }
  if (chunk.filesRead.length > 0) {
    parts.push(`FILES READ: ${chunk.filesRead.slice(0, 10).join(', ')}`);
  }

  chunk.content = parts.join('\n');

  // Build summary (first user message, truncated)
  chunk.summary = userMsgs[0]
    ? userMsgs[0].slice(0, 100)
    : (fullAssistant ? fullAssistant.slice(0, 100) : 'No content');

  // Clean up internals
  delete chunk._toolCounts;

  // Limit user messages for storage
  chunk.userMessages = userMsgs;

  return chunk;
}
