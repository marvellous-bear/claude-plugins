// Telegram Bot API client
// Handles sending messages and polling for updates
//
// PRD Reference (lines 230-240, 265-283):
// - sendMessage API for notifications
// - getUpdates with long polling
// - Stale update filtering (older than staleUpdateThreshold)
// - Retry with backoff on network failure

const DEFAULT_OPTIONS = {
  staleThreshold: 300,  // 5 minutes - discard older updates
  pollingTimeout: 30,   // Long polling timeout in seconds
  maxRetries: 3,        // Max retry attempts
  retryDelay: 1000      // Initial retry delay in ms
};

/**
 * Create a Telegram Bot API client
 *
 * @param {string|null} token - Bot token from @BotFather
 * @param {Object} options - Configuration options
 * @param {Function} options.fetch - Fetch implementation (for testing)
 * @param {number} options.staleThreshold - Max age of updates in seconds
 * @param {number} options.pollingTimeout - Long polling timeout in seconds
 * @param {number} options.maxRetries - Max retry attempts
 * @param {number} options.retryDelay - Initial retry delay in ms
 * @returns {Object} Client with sendMessage and getUpdates methods
 */
function createTelegramClient(token, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fetchFn = opts.fetch || fetch;

  const baseUrl = token ? `https://api.telegram.org/bot${token}` : null;

  /**
   * Make API request with retries
   */
  async function apiRequest(method, params = {}, retries = opts.maxRetries) {
    if (!baseUrl) {
      throw new Error('Telegram client not configured: missing bot token');
    }

    const url = new URL(`${baseUrl}/${method}`);

    // Add params to URL for GET requests (getUpdates)
    if (method === 'getUpdates') {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = method === 'getUpdates'
          ? await fetchFn(url.toString())
          : await fetchFn(url.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(params)
            });

        const data = await response.json();

        if (!data.ok) {
          throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
        }

        return data.result;

      } catch (err) {
        lastError = err;

        // Don't retry on API errors (4xx responses)
        if (err.message.includes('Telegram API error')) {
          throw err;
        }

        // Retry on network errors
        if (attempt < retries) {
          const delay = opts.retryDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  return {
    /**
     * Check if client is configured with a token
     *
     * @returns {boolean} True if configured
     */
    isConfigured() {
      return !!token;
    },

    /**
     * Send a message to a chat
     *
     * @param {number} chatId - Telegram chat ID
     * @param {string} text - Message text
     * @param {Object} options - Optional parameters
     * @param {string} options.parse_mode - Parse mode ('Markdown' or 'HTML')
     * @returns {Promise<Object>} Sent message with message_id
     */
    async sendMessage(chatId, text, messageOptions = {}) {
      if (!token) {
        throw new Error('Telegram client not configured: missing bot token');
      }

      const params = {
        chat_id: chatId,
        text,
        parse_mode: messageOptions.parse_mode || 'Markdown',
        ...messageOptions
      };

      return apiRequest('sendMessage', params);
    },

    /**
     * Get updates (new messages) from Telegram
     * Uses long polling for efficiency
     *
     * @param {number} offset - Update offset (last update_id + 1)
     * @returns {Promise<Array>} Array of updates (filtered for staleness)
     */
    async getUpdates(offset = 0) {
      if (!token) {
        // Not configured - return empty array
        return [];
      }

      const params = {
        offset,
        timeout: opts.pollingTimeout,
        allowed_updates: ['message']
      };

      const updates = await apiRequest('getUpdates', params);

      // Filter out stale updates
      const now = Date.now() / 1000;
      const filtered = updates.filter(update => {
        if (!update.message || !update.message.date) {
          return true; // Keep updates without date (shouldn't happen)
        }

        const age = now - update.message.date;
        return age <= opts.staleThreshold;
      });

      return filtered;
    },

    /**
     * Get the highest update_id from an array of updates
     * Used to calculate next offset
     *
     * @param {Array} updates - Array of updates
     * @returns {number|null} Highest update_id or null
     */
    getMaxUpdateId(updates) {
      if (!updates || updates.length === 0) return null;
      return Math.max(...updates.map(u => u.update_id));
    },

    /**
     * Delete a message from a chat
     * Used to clean up stale permission request notifications
     *
     * @param {number} chatId - Telegram chat ID
     * @param {number} messageId - Message ID to delete
     * @returns {Promise<boolean>} True if deleted successfully
     */
    async deleteMessage(chatId, messageId) {
      if (!token) {
        throw new Error('Telegram client not configured: missing bot token');
      }

      try {
        await apiRequest('deleteMessage', {
          chat_id: chatId,
          message_id: messageId
        });
        return true;
      } catch (err) {
        // Message may already be deleted or too old (>48 hours)
        // Don't throw - just return false
        return false;
      }
    }
  };
}

/**
 * Get the bot token from environment
 *
 * @returns {string|null} Bot token or null
 */
function getBotToken() {
  return process.env.CLAUDE_AFK_TELEGRAM_TOKEN || null;
}

module.exports = {
  createTelegramClient,
  getBotToken,
  DEFAULT_OPTIONS
};
