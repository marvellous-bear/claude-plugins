// Session registry for daemon
// Manages session_id ↔ token mapping and AFK state
//
// PRD Reference (lines 729-762):
// - Session registry (session_id ↔ short_token mapping)
// - Token format: {project-slug}-{4-char-random} (e.g., my-app-a3f8)
// - Track pending requests with message IDs

const crypto = require('crypto');

/**
 * Slugify a project name for token generation
 *
 * @param {string} name - Project name
 * @returns {string} Slugified name
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with dashes
    .replace(/^-+|-+$/g, '')       // Remove leading/trailing dashes
    .replace(/-+/g, '-');          // Collapse multiple dashes
}

/**
 * Generate a random 4-character hex string
 *
 * @returns {string} 4-character hex string
 */
function generateRandomSuffix() {
  return crypto.randomBytes(2).toString('hex');
}

/**
 * Create a session registry
 *
 * @returns {Object} Registry object with methods for session management
 */
function createSessionRegistry() {
  // session_id -> { token, projectSlug, registeredAt }
  const sessionsBySessionId = new Map();

  // token -> session_id
  const sessionsByToken = new Map();

  // Set of AFK-enabled session_ids
  const afkEnabledSessions = new Set();

  // message_id -> { sessionId, tool, command, retryCount, requestId, firstRequestAt }
  const pendingByMessageId = new Map();

  // "session_id:tool:command" -> message_id (for lookup by session/tool/command)
  const pendingKeyToMessageId = new Map();

  /**
   * Generate pending request key
   */
  function makePendingKey(sessionId, tool, command) {
    return `${sessionId}:${tool}:${command}`;
  }

  return {
    /**
     * Register a session and generate a token
     *
     * @param {string} sessionId - Claude session ID
     * @param {string} projectName - Project name for token prefix
     * @returns {string} Generated token
     */
    register(sessionId, projectName) {
      // If already registered, return existing token
      if (sessionsBySessionId.has(sessionId)) {
        return sessionsBySessionId.get(sessionId).token;
      }

      const projectSlug = slugify(projectName);
      const suffix = generateRandomSuffix();
      const token = `${projectSlug}-${suffix}`;

      const sessionData = {
        token,
        projectSlug,
        registeredAt: Date.now()
      };

      sessionsBySessionId.set(sessionId, sessionData);
      sessionsByToken.set(token, sessionId);

      return token;
    },

    /**
     * Unregister a session
     *
     * @param {string} sessionId - Session to unregister
     */
    unregister(sessionId) {
      const session = sessionsBySessionId.get(sessionId);
      if (session) {
        sessionsByToken.delete(session.token);
        sessionsBySessionId.delete(sessionId);
        afkEnabledSessions.delete(sessionId);

        // Remove any pending requests for this session
        for (const [messageId, pending] of pendingByMessageId) {
          if (pending.sessionId === sessionId) {
            pendingByMessageId.delete(messageId);
          }
        }

        // Clean up pending keys
        for (const [key, msgId] of pendingKeyToMessageId) {
          if (key.startsWith(sessionId + ':')) {
            pendingKeyToMessageId.delete(key);
          }
        }
      }
    },

    /**
     * Get session by token
     *
     * @param {string} token - Token to look up
     * @returns {Object|null} Session data or null
     */
    getByToken(token) {
      const sessionId = sessionsByToken.get(token);
      if (!sessionId) return null;

      const session = sessionsBySessionId.get(sessionId);
      if (!session) return null;

      return {
        sessionId,
        token: session.token,
        projectSlug: session.projectSlug,
        registeredAt: session.registeredAt
      };
    },

    /**
     * Get session by session_id
     *
     * @param {string} sessionId - Session ID to look up
     * @returns {Object|null} Session data or null
     */
    getBySessionId(sessionId) {
      const session = sessionsBySessionId.get(sessionId);
      if (!session) return null;

      return {
        sessionId,
        token: session.token,
        projectSlug: session.projectSlug,
        registeredAt: session.registeredAt
      };
    },

    /**
     * Enable AFK mode for a session
     *
     * @param {string} sessionId - Session to enable
     */
    enableAfk(sessionId) {
      afkEnabledSessions.add(sessionId);
    },

    /**
     * Disable AFK mode for a session
     *
     * @param {string} sessionId - Session to disable
     */
    disableAfk(sessionId) {
      afkEnabledSessions.delete(sessionId);
    },

    /**
     * Check if AFK mode is enabled for a session
     *
     * @param {string} sessionId - Session to check
     * @returns {boolean} True if AFK enabled
     */
    isAfkEnabled(sessionId) {
      return afkEnabledSessions.has(sessionId);
    },

    /**
     * Get all AFK-enabled session IDs
     *
     * @returns {string[]} Array of session IDs
     */
    getAfkEnabledSessions() {
      return Array.from(afkEnabledSessions);
    },

    /**
     * Add a pending request
     *
     * @param {string} sessionId - Session that made the request
     * @param {Object} request - Request data
     * @param {number} request.messageId - Telegram message ID
     * @param {string} request.tool - Tool name (e.g., 'Bash')
     * @param {string} request.command - Command text
     * @param {string} request.requestId - IPC request ID
     * @param {number} request.retryCount - Retry count (default 0)
     */
    addPendingRequest(sessionId, request) {
      const pending = {
        sessionId,
        messageId: request.messageId,
        tool: request.tool,
        command: request.command || '',
        requestId: request.requestId,
        retryCount: request.retryCount || 0,
        firstRequestAt: request.firstRequestAt || new Date().toISOString()
      };

      pendingByMessageId.set(request.messageId, pending);

      // Also index by session/tool/command for retry lookup
      const key = makePendingKey(sessionId, request.tool, request.command || '');
      pendingKeyToMessageId.set(key, request.messageId);
    },

    /**
     * Get pending request by Telegram message ID
     *
     * @param {number} messageId - Telegram message ID
     * @returns {Object|null} Pending request or null
     */
    getPendingByMessageId(messageId) {
      return pendingByMessageId.get(messageId) || null;
    },

    /**
     * Get pending request by session, tool, and command
     *
     * @param {string} sessionId - Session ID
     * @param {string} tool - Tool name
     * @param {string} command - Command text
     * @returns {Object|null} Pending request or null
     */
    getPendingBySessionAndTool(sessionId, tool, command) {
      const key = makePendingKey(sessionId, tool, command || '');
      const messageId = pendingKeyToMessageId.get(key);
      if (messageId === undefined) return null;
      return pendingByMessageId.get(messageId) || null;
    },

    /**
     * Increment retry count for a pending request
     *
     * @param {string} sessionId - Session ID
     * @param {string} tool - Tool name
     * @param {string} command - Command text
     */
    incrementRetryCount(sessionId, tool, command) {
      const key = makePendingKey(sessionId, tool, command || '');
      const messageId = pendingKeyToMessageId.get(key);
      if (messageId !== undefined) {
        const pending = pendingByMessageId.get(messageId);
        if (pending) {
          pending.retryCount++;
        }
      }
    },

    /**
     * Remove pending request by message ID
     *
     * @param {number} messageId - Telegram message ID
     */
    removePendingByMessageId(messageId) {
      const pending = pendingByMessageId.get(messageId);
      if (pending) {
        const key = makePendingKey(pending.sessionId, pending.tool, pending.command || '');
        pendingKeyToMessageId.delete(key);
        pendingByMessageId.delete(messageId);
      }
    },

    /**
     * Get count of pending requests
     *
     * @returns {number} Number of pending requests
     */
    getPendingCount() {
      return pendingByMessageId.size;
    },

    /**
     * Export state for persistence
     *
     * @returns {Object} State object
     */
    exportState() {
      const pendingRequests = {};

      for (const [messageId, pending] of pendingByMessageId) {
        if (!pendingRequests[pending.sessionId]) {
          pendingRequests[pending.sessionId] = {};
        }
        pendingRequests[pending.sessionId] = {
          messageId: pending.messageId,
          tool: pending.tool,
          command: pending.command,
          retryCount: pending.retryCount,
          firstRequestAt: pending.firstRequestAt
        };
      }

      return {
        afkSessions: Array.from(afkEnabledSessions),
        pendingRequests
      };
    },

    /**
     * Import state from persistence
     *
     * @param {Object} state - State to import
     */
    importState(state) {
      // Import AFK sessions
      if (state.afkSessions) {
        for (const sessionId of state.afkSessions) {
          afkEnabledSessions.add(sessionId);
        }
      }

      // Note: pending requests are imported but the session mappings
      // need to be re-established when sessions reconnect
      // The daemon startup handler will deal with orphaned requests
    }
  };
}

module.exports = {
  createSessionRegistry,
  slugify
};
