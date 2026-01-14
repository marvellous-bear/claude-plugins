// Singleton lock tests - TDD approach
// These tests define the contract for singleton.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { acquireLock, isLocked } = require('./singleton.js');

describe('singleton lock', () => {
  let tempDir;
  let lockPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singleton-test-'));
    lockPath = path.join(tempDir, 'daemon.lock');
  });

  afterEach(async () => {
    // Clean up any locks
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('acquires lock when none exists', async () => {
    const result = await acquireLock(lockPath);

    assert.strictEqual(result.acquired, true);
    assert.ok(typeof result.release === 'function');

    await result.release();
  });

  it('fails to acquire when lock already held', async () => {
    const first = await acquireLock(lockPath);
    assert.strictEqual(first.acquired, true);

    const second = await acquireLock(lockPath);
    assert.strictEqual(second.acquired, false);
    assert.strictEqual(second.release, null);

    await first.release();
  });

  it('can acquire lock after previous holder releases', async () => {
    const first = await acquireLock(lockPath);
    assert.strictEqual(first.acquired, true);

    await first.release();

    const second = await acquireLock(lockPath);
    assert.strictEqual(second.acquired, true);

    await second.release();
  });

  it('isLocked returns true when lock is held', async () => {
    const result = await acquireLock(lockPath);
    assert.strictEqual(result.acquired, true);

    const locked = await isLocked(lockPath);
    assert.strictEqual(locked, true);

    await result.release();
  });

  it('isLocked returns false when no lock exists', async () => {
    const locked = await isLocked(lockPath);
    assert.strictEqual(locked, false);
  });

  it('isLocked returns false after lock is released', async () => {
    const result = await acquireLock(lockPath);
    await result.release();

    const locked = await isLocked(lockPath);
    assert.strictEqual(locked, false);
  });

  it('creates parent directory if it does not exist', async () => {
    const deepPath = path.join(tempDir, 'deep', 'nested', 'daemon.lock');

    const result = await acquireLock(deepPath);
    assert.strictEqual(result.acquired, true);

    // Verify directory was created
    assert.ok(fs.existsSync(path.dirname(deepPath)));

    await result.release();
  });

  it('handles lock with stale option', async () => {
    // This test verifies the stale option is passed correctly
    // The actual stale detection is handled by proper-lockfile
    const result = await acquireLock(lockPath, { stale: 1000 });
    assert.strictEqual(result.acquired, true);

    await result.release();
  });
});
