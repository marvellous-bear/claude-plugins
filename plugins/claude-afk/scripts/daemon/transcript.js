// Transcript parser for claude-afk
// Extracts the last Claude message from a transcript for notification context
//
// IMPORTANT: The transcript JSONL format is an internal implementation detail
// of Claude Code, not a public API. It may change without warning.
// This parser MUST be resilient (Safe Mode).

const fs = require('fs/promises');
const path = require('path');

/**
 * Get the last Claude (assistant) message with actual text content from a transcript file
 * Searches backwards through messages to find one with text (not just tool_use blocks)
 *
 * @param {string} transcriptPath - Path to the transcript.jsonl file
 * @param {Object} options - Optional configuration
 * @param {number} options.maxLength - Maximum length of returned message (default: no limit)
 * @returns {Promise<string|null>} The last assistant message text, or null if not found/error
 */
async function getLastClaudeMessage(transcriptPath, options = {}) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      return null;
    }

    // Search backwards through lines to find an assistant message with text
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        if (entry.type === 'assistant' && entry.message?.content) {
          const messageContent = entry.message.content;
          let text = null;

          if (typeof messageContent === 'string') {
            text = messageContent;
          } else if (Array.isArray(messageContent)) {
            // Filter for text blocks and join them
            const textBlocks = messageContent
              .filter(block => block.type === 'text')
              .map(block => block.text);

            if (textBlocks.length > 0) {
              text = textBlocks.join('\n');
            }
          }

          // If we found text content, return it
          if (text && text.trim()) {
            // Apply length limit if specified
            if (options.maxLength && text.length > options.maxLength) {
              text = text.substring(0, options.maxLength - 3) + '...';
            }
            return text;
          }
          // Otherwise continue searching backwards for a message with text
        }
      } catch (parseError) {
        // Skip malformed lines - continue processing
        continue;
      }
    }

    return null;

  } catch (error) {
    // Safe Mode: transcript parsing failed (format changed, file missing, etc.)
    return null;
  }
}

/**
 * Get the last user message from a transcript file
 * Useful as fallback context when no assistant text is available
 *
 * @param {string} transcriptPath - Path to the transcript.jsonl file
 * @param {Object} options - Optional configuration
 * @param {number} options.maxLength - Maximum length of returned message (default: no limit)
 * @returns {Promise<string|null>} The last user message text, or null if not found/error
 */
async function getLastUserMessage(transcriptPath, options = {}) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Search backwards for user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        if (entry.type === 'user' && entry.message?.content) {
          const messageContent = entry.message.content;
          let text = null;

          if (typeof messageContent === 'string') {
            text = messageContent;
          } else if (Array.isArray(messageContent)) {
            const textBlocks = messageContent
              .filter(block => block.type === 'text')
              .map(block => block.text);

            if (textBlocks.length > 0) {
              text = textBlocks.join('\n');
            }
          }

          if (text && text.trim()) {
            if (options.maxLength && text.length > options.maxLength) {
              text = text.substring(0, options.maxLength - 3) + '...';
            }
            return text;
          }
        }
      } catch (parseError) {
        continue;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Get the last pending tool use from a transcript file
 * This extracts the tool_use block that's awaiting permission
 *
 * @param {string} transcriptPath - Path to the transcript.jsonl file
 * @returns {Promise<{tool: string, input: Object}|null>} Tool use info or null
 */
async function getLastToolUse(transcriptPath) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      return null;
    }

    // Find the last assistant message with tool_use blocks
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        if (entry.type === 'assistant' && entry.message?.content) {
          const content = entry.message.content;

          if (Array.isArray(content)) {
            // Find tool_use blocks (search from end to get last one)
            for (let j = content.length - 1; j >= 0; j--) {
              const block = content[j];
              if (block.type === 'tool_use') {
                return {
                  id: block.id,
                  tool: block.name,
                  input: block.input || {}
                };
              }
            }
          }
        }
      } catch (parseError) {
        continue;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Get the line count of a transcript file
 * Used to determine current offset for stop requests
 *
 * @param {string} transcriptPath - Path to the transcript.jsonl file
 * @returns {Promise<number>} Number of non-empty lines, or 0 on error
 */
async function getLineCount(transcriptPath) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    return lines.length;
  } catch (error) {
    // Safe Mode: return 0 on any error
    return 0;
  }
}

/**
 * Find tool_result for a specific tool_use_id
 * Used to detect when permission requests are resolved locally
 *
 * @param {string} transcriptPath - Path to transcript file
 * @param {string} toolUseId - The tool_use.id to find result for
 * @param {number} afterOffset - Only look at lines after this line number (0-indexed)
 * @returns {Promise<{found: boolean, isError: boolean, offset: number}|null>}
 */
async function findToolResult(transcriptPath, toolUseId, afterOffset = 0) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Search from afterOffset forward
    for (let i = afterOffset; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);

        // Look for user messages with tool_result blocks
        if (entry.type === 'user' && entry.message?.content) {
          const messageContent = entry.message.content;

          if (Array.isArray(messageContent)) {
            // Search for tool_result blocks
            for (const block of messageContent) {
              if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
                return {
                  found: true,
                  isError: block.is_error === true,
                  offset: i + 1 // Return next line to check
                };
              }
            }
          }
        }
      } catch (parseError) {
        // Skip malformed lines - Safe Mode
        continue;
      }
    }

    // Not found - return offset at end of file for next poll
    return {
      found: false,
      isError: false,
      offset: lines.length
    };

  } catch (error) {
    // Safe Mode: file errors return null
    return null;
  }
}

/**
 * Find new user message after a specific offset
 * Used to detect when stop notifications are resolved locally
 *
 * @param {string} transcriptPath - Path to transcript file
 * @param {number} afterOffset - Only look at lines after this line number (0-indexed)
 * @returns {Promise<{found: boolean, content: string, offset: number}|null>}
 */
async function findUserMessage(transcriptPath, afterOffset = 0) {
  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Search from afterOffset forward
    for (let i = afterOffset; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);

        if (entry.type === 'user' && entry.message?.content) {
          const messageContent = entry.message.content;

          // Only match STRING content (not tool_result arrays)
          if (typeof messageContent === 'string' && messageContent.trim()) {
            return {
              found: true,
              content: messageContent,
              offset: i + 1 // Return next line to check
            };
          }
        }
      } catch (parseError) {
        // Skip malformed lines - Safe Mode
        continue;
      }
    }

    // Not found - return offset at end of file for next poll
    return {
      found: false,
      content: '',
      offset: lines.length
    };

  } catch (error) {
    // Safe Mode: file errors return null
    return null;
  }
}

/**
 * Get file modification time
 * Used for mtime-based optimization to skip unchanged files
 *
 * @param {string} filePath - Path to check
 * @returns {Promise<number|null>} mtime in ms or null if error
 */
async function getFileMtime(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtimeMs;
  } catch (error) {
    // Safe Mode: return null on error
    return null;
  }
}

/**
 * Find subagent transcript files for a project
 * Used to detect permission resolutions in subagent transcripts
 *
 * @param {string} transcriptPath - Path to main transcript (we'll find siblings)
 * @returns {Promise<string[]>} Array of agent-*.jsonl paths
 */
async function findSubagentTranscripts(transcriptPath) {
  try {
    // Get directory containing the transcript
    const projectDir = path.dirname(transcriptPath);

    // Read all files in the directory
    const files = await fs.readdir(projectDir);

    // Filter for agent-*.jsonl files
    const agentFiles = files
      .filter(file => file.startsWith('agent-') && file.endsWith('.jsonl'))
      .map(file => path.join(projectDir, file));

    return agentFiles;
  } catch (error) {
    // Safe Mode: return empty array on error
    return [];
  }
}

/**
 * Format tool input for display in notification
 *
 * @param {string} toolName - Name of the tool
 * @param {Object} toolInput - Tool input object
 * @returns {string} Human-readable description
 */
function formatToolInput(toolName, toolInput) {
  if (!toolInput) return '(no details)';

  switch (toolName) {
    case 'Bash':
      return toolInput.command || '(unknown command)';

    case 'Write':
      return `Write to ${toolInput.file_path || '(unknown file)'}`;

    case 'Edit':
      return `Edit ${toolInput.file_path || '(unknown file)'}`;

    case 'Read':
      return toolInput.file_path || '(unknown file)';

    case 'Glob':
      return `Pattern: ${toolInput.pattern || '(unknown)'}`;

    case 'Grep':
      return `Search: ${toolInput.pattern || '(unknown)'}`;

    case 'WebFetch':
      return toolInput.url || '(unknown URL)';

    case 'WebSearch':
      return toolInput.query || '(unknown query)';

    default:
      // For unknown tools, try to extract meaningful info
      const keys = Object.keys(toolInput);
      if (keys.length === 0) return '(no details)';

      // Return first non-empty string value
      for (const key of keys) {
        const val = toolInput[key];
        if (typeof val === 'string' && val.trim()) {
          return val.length > 100 ? val.substring(0, 97) + '...' : val;
        }
      }

      return JSON.stringify(toolInput).substring(0, 100);
  }
}

module.exports = {
  getLastClaudeMessage,
  getLastUserMessage,
  getLastToolUse,
  formatToolInput,
  getLineCount,
  findToolResult,
  findUserMessage,
  getFileMtime,
  findSubagentTranscripts
};
