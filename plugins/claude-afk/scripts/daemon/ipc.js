// IPC communication via named pipes
// Uses NDJSON (newline-delimited JSON) protocol with request correlation
//
// PRD Reference (lines 655-686):
// - Named pipe path: Unix: /tmp/claude-afk.sock, Windows: \\.\pipe\claude-afk
// - Each request includes unique request_id (UUID v4)
// - Daemon echoes request_id in response for routing

const net = require('net');
const xpipe = require('xpipe');
const crypto = require('crypto');

// Default timeout for client requests (5 minutes - matches permission timeout)
const DEFAULT_TIMEOUT = 300000;

/**
 * Create an IPC server that listens on a named pipe
 *
 * @param {string} pipePath - Path to the named pipe
 * @returns {Object} Server object with start/stop/onMessage methods
 */
function createIPCServer(pipePath) {
  let server = null;
  let messageHandler = null;
  let disconnectHandler = null;
  let running = false;
  const connections = new Set();

  return {
    /**
     * Register message handler
     * @param {Function} handler - (message, respond, socket) => void
     */
    onMessage(handler) {
      messageHandler = handler;
    },

    /**
     * Register disconnect handler
     * @param {Function} handler - (socket) => void
     */
    onDisconnect(handler) {
      disconnectHandler = handler;
    },

    /**
     * Start the server
     * @returns {Promise<void>}
     */
    start() {
      return new Promise((resolve, reject) => {
        const actualPath = xpipe.eq(pipePath);

        server = net.createServer((socket) => {
          connections.add(socket);

          let buffer = '';

          socket.on('data', (data) => {
            buffer += data.toString();

            // Process complete lines (NDJSON)
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);

              if (line.trim()) {
                try {
                  const message = JSON.parse(line);

                  if (messageHandler) {
                    messageHandler(message, (response) => {
                      // Send response as NDJSON
                      try {
                        socket.write(JSON.stringify(response) + '\n');
                      } catch (e) {
                        // Socket may be closed
                      }
                    }, socket);
                  }
                } catch (e) {
                  // Invalid JSON - ignore
                }
              }
            }
          });

          socket.on('close', () => {
            connections.delete(socket);
            if (disconnectHandler) {
              disconnectHandler(socket);
            }
          });

          socket.on('error', () => {
            connections.delete(socket);
            if (disconnectHandler) {
              disconnectHandler(socket);
            }
          });
        });

        server.on('error', (err) => {
          if (!running) {
            reject(err);
          }
        });

        server.listen(actualPath, () => {
          running = true;
          resolve();
        });
      });
    },

    /**
     * Stop the server
     * @returns {Promise<void>}
     */
    stop() {
      return new Promise((resolve) => {
        running = false;

        // Close all connections
        for (const socket of connections) {
          try {
            socket.destroy();
          } catch (e) {
            // Ignore
          }
        }
        connections.clear();

        if (server) {
          server.close(() => {
            server = null;
            resolve();
          });
        } else {
          resolve();
        }
      });
    },

    /**
     * Check if server is running
     * @returns {boolean}
     */
    isRunning() {
      return running;
    }
  };
}

/**
 * Create an IPC client that connects to a named pipe
 *
 * @param {string} pipePath - Path to the named pipe
 * @param {Object} options - Optional configuration
 * @param {number} options.timeout - Timeout for requests in ms (default: 300000)
 * @returns {Promise<Object>} Client object with send/sendAndWait/close methods
 */
function createIPCClient(pipePath, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const actualPath = xpipe.eq(pipePath);
    const socket = net.createConnection(actualPath);

    let buffer = '';
    const pendingRequests = new Map(); // request_id -> { resolve, reject, timer }

    socket.on('connect', () => {
      const client = {
        /**
         * Send a message without waiting for response
         * @param {Object} message - Message to send
         * @returns {Promise<void>}
         */
        send(message) {
          return new Promise((resolve, reject) => {
            try {
              socket.write(JSON.stringify(message) + '\n', (err) => {
                if (err) reject(err);
                else resolve();
              });
            } catch (e) {
              reject(e);
            }
          });
        },

        /**
         * Send a message and wait for response with matching request_id
         * @param {Object} message - Message to send (should include request_id)
         * @returns {Promise<Object>} Response from server
         */
        sendAndWait(message) {
          return new Promise((resolveRequest, rejectRequest) => {
            // Ensure message has request_id
            const requestId = message.request_id || crypto.randomUUID();
            const msgWithId = { ...message, request_id: requestId };

            // Set up timeout
            const timer = setTimeout(() => {
              pendingRequests.delete(requestId);
              rejectRequest(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);

            // Store pending request
            pendingRequests.set(requestId, {
              resolve: resolveRequest,
              reject: rejectRequest,
              timer
            });

            // Send message
            try {
              socket.write(JSON.stringify(msgWithId) + '\n');
            } catch (e) {
              clearTimeout(timer);
              pendingRequests.delete(requestId);
              rejectRequest(e);
            }
          });
        },

        /**
         * Close the connection
         * @returns {Promise<void>}
         */
        close() {
          return new Promise((resolve) => {
            // Reject all pending requests
            for (const [id, pending] of pendingRequests) {
              clearTimeout(pending.timer);
              pending.reject(new Error('Connection closed'));
            }
            pendingRequests.clear();

            socket.destroy();
            resolve();
          });
        }
      };

      resolve(client);
    });

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete lines (NDJSON)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          try {
            const response = JSON.parse(line);

            // Route to pending request by request_id
            if (response.request_id && pendingRequests.has(response.request_id)) {
              const pending = pendingRequests.get(response.request_id);
              clearTimeout(pending.timer);
              pendingRequests.delete(response.request_id);
              pending.resolve(response);
            }
          } catch (e) {
            // Invalid JSON - ignore
          }
        }
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get the default pipe path for the daemon
 *
 * @returns {string} - Platform-appropriate pipe path
 */
function getDefaultPipePath() {
  // Return Unix-style path - xpipe.eq() will convert to platform-appropriate format
  // On Windows: /claude-afk -> //./pipe/claude-afk
  // On Unix: /tmp/claude-afk.sock stays as-is
  if (process.platform === 'win32') {
    return '/claude-afk';
  } else {
    return '/tmp/claude-afk.sock';
  }
}

module.exports = {
  createIPCServer,
  createIPCClient,
  getDefaultPipePath,
  DEFAULT_TIMEOUT
};
