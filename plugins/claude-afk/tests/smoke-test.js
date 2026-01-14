#!/usr/bin/env node
/**
 * Smoke test for Claude AFK daemon
 * Verifies daemon is running and IPC communication works
 *
 * Usage: node tests/smoke-test.js
 */

const { createIPCClient, getDefaultPipePath } = require('../scripts/daemon/ipc');
const crypto = require('crypto');

async function runSmokeTest() {
  console.log('Claude AFK Smoke Test');
  console.log('=====================\n');

  const results = [];

  // Test 1: Daemon connectivity
  console.log('Test 1: Daemon connectivity...');
  try {
    const client = await createIPCClient(getDefaultPipePath(), { timeout: 5000 });

    const response = await client.sendAndWait({
      type: 'status',
      request_id: crypto.randomUUID()
    });

    await client.close();

    if (response.status === 'status_response' && response.daemon_running) {
      console.log('  ✓ Daemon is running');
      console.log(`  ✓ Telegram configured: ${response.telegram_configured}`);
      console.log(`  ✓ Chat ID configured: ${response.chat_id_configured}`);
      console.log(`  ✓ AFK sessions: ${response.afk_sessions?.length || 0}`);
      console.log(`  ✓ Pending requests: ${response.pending_requests || 0}`);
      results.push({ test: 'Daemon connectivity', passed: true });
    } else {
      console.log('  ✗ Unexpected response:', response);
      results.push({ test: 'Daemon connectivity', passed: false });
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    if (err.message.includes('ENOENT') || err.message.includes('ECONNREFUSED')) {
      console.log('  → Daemon is not running. Start it with: node scripts/daemon/index.js');
    }
    results.push({ test: 'Daemon connectivity', passed: false });
  }

  // Test 2: Telegram token check
  console.log('\nTest 2: Telegram token...');
  const token = process.env.CLAUDE_AFK_TELEGRAM_TOKEN;
  if (token) {
    console.log(`  ✓ Token is set (${token.substring(0, 10)}...)`);
    results.push({ test: 'Telegram token', passed: true });
  } else {
    console.log('  ✗ No Telegram token found');
    console.log('  → Set CLAUDE_AFK_TELEGRAM_TOKEN environment variable');
    results.push({ test: 'Telegram token', passed: false });
  }

  // Test 3: Hook scripts exist
  console.log('\nTest 3: Hook scripts...');
  const fs = require('fs');
  const path = require('path');
  const scriptsDir = path.join(__dirname, '..', 'scripts');

  const requiredScripts = [
    'permission-handler.js',
    'stop-handler.js',
    'cli.js'
  ];

  let allScriptsExist = true;
  for (const script of requiredScripts) {
    const scriptPath = path.join(scriptsDir, script);
    if (fs.existsSync(scriptPath)) {
      console.log(`  ✓ ${script} exists`);
    } else {
      console.log(`  ✗ ${script} missing`);
      allScriptsExist = false;
    }
  }
  results.push({ test: 'Hook scripts', passed: allScriptsExist });

  // Summary
  console.log('\n=====================');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('\n✓ All smoke tests passed!');
    process.exit(0);
  } else {
    console.log('\n✗ Some tests failed');
    process.exit(1);
  }
}

runSmokeTest().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
