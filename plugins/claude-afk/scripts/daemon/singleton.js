// Singleton daemon lock management
// Uses proper-lockfile for cross-platform file locking
//
// PRD Reference (lines 712-727):
// - Singleton acquisition: `proper-lockfile` (file lock at `~/.claude/claude-afk/daemon.lock`)
// - stale: 60000 (60 seconds) - Allows daemon time to handle heavy workloads
// - Heartbeat every 15 seconds - Updates lock file mtime to prove liveness

const lockfile = require('proper-lockfile');
const fs = require('fs');
const path = require('path');

// Default lock options per PRD
const DEFAULT_OPTIONS = {
  stale: 60000,      // 60 seconds - time before lock considered stale
  update: 15000,     // 15 seconds - heartbeat interval
  retries: 0         // Don't retry - just report if locked
};

/**
 * Attempt to acquire the daemon lock
 *
 * @param {string} lockPath - Path to lock file (e.g., ~/.claude/claude-afk/daemon.lock)
 * @param {Object} options - Optional lock options
 * @param {number} options.stale - Time in ms before lock is considered stale (default: 60000)
 * @param {number} options.update - Heartbeat interval in ms (default: 15000)
 * @returns {Promise<{acquired: boolean, release: Function|null}>}
 */
async function acquireLock(lockPath, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Ensure parent directory exists
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Create lock file if it doesn't exist (proper-lockfile needs a file to lock)
    if (!fs.existsSync(lockPath)) {
      fs.writeFileSync(lockPath, '');
    }

    // Attempt to acquire lock
    const release = await lockfile.lock(lockPath, {
      stale: opts.stale,
      update: opts.update,
      retries: opts.retries
    });

    return {
      acquired: true,
      release: async () => {
        try {
          await release();
        } catch (e) {
          // Lock may already be released or file deleted
        }
      }
    };

  } catch (err) {
    // Lock is already held by another process
    if (err.code === 'ELOCKED') {
      return {
        acquired: false,
        release: null
      };
    }

    // For other errors (e.g., permission issues), also return not acquired
    // This follows fail-open philosophy - don't crash, just report
    return {
      acquired: false,
      release: null
    };
  }
}

/**
 * Check if the lock is currently held
 *
 * @param {string} lockPath - Path to lock file
 * @returns {Promise<boolean>} - True if lock is held
 */
async function isLocked(lockPath) {
  try {
    // Check if lock file exists
    if (!fs.existsSync(lockPath)) {
      return false;
    }

    const locked = await lockfile.check(lockPath, {
      stale: DEFAULT_OPTIONS.stale
    });

    return locked;

  } catch (err) {
    // If we can't check, assume not locked
    return false;
  }
}

/**
 * Get the default lock path for the daemon
 *
 * @returns {string} - Path to daemon.lock
 */
function getDefaultLockPath() {
  const { getClaudeAfkDir } = require('../session-lookup');
  return path.join(getClaudeAfkDir(), 'daemon.lock');
}

module.exports = {
  acquireLock,
  isLocked,
  getDefaultLockPath,
  DEFAULT_OPTIONS
};
