import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installStdioExitHandler } from '../dist/utils/stdio-lifecycle.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('disabled lifecycle leaves legacy stdin and signal listeners untouched', () => {
    const input = new PassThrough(); const signals = new EventEmitter();
    const dispose = installStdioExitHandler({ enabled: false, input, signals, close: async () => {} });
    assert.equal(input.listenerCount('end'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    dispose();
});
test('EOF/close races trigger one close and one clean exit', async () => {
    const input = new PassThrough(); const signals = new EventEmitter();
    const exits = []; let closes = 0;
    installStdioExitHandler({ enabled: true, input, signals,
        close: async () => { closes++; }, exit: code => exits.push(code) });
    input.emit('end'); input.emit('close');
    await wait(10);
    assert.equal(closes, 1); assert.deepEqual(exits, [0]);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
});
test('a stalled close has a deadline and a late resolution cannot exit twice', async () => {
    const input = new PassThrough(); const signals = new EventEmitter();
    const exits = []; let resolveClose;
    installStdioExitHandler({ enabled: true, input, signals, graceMs: 10,
        close: () => new Promise(resolve => { resolveClose = resolve; }), exit: code => exits.push(code) });
    signals.emit('SIGTERM');
    await wait(30); assert.deepEqual(exits, [1]);
    resolveClose(); await wait(5); assert.deepEqual(exits, [1]);
});
test('cleanup failure produces a failure exit and removes signal handlers', async () => {
    const input = new PassThrough(); const signals = new EventEmitter(); const exits = [];
    installStdioExitHandler({ enabled: true, input, signals,
        close: async () => { throw new Error('fixture'); }, exit: code => exits.push(code) });
    signals.emit('SIGHUP'); await wait(5); assert.deepEqual(exits, [1]);
    assert.equal(input.listenerCount('end'), 0);
});
test('a real stdio child exits on EOF despite unrelated live timers', { timeout: 5000 }, async () => {
    const module = new URL('../dist/utils/stdio-lifecycle.js', import.meta.url).href;
    const code = `import { installStdioExitHandler } from ${JSON.stringify(module)};
        installStdioExitHandler({ enabled: true, close: async () => {} });
        setInterval(() => {}, 10000); process.stdin.resume(); console.log('READY');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
        await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Child exited before readiness'); })]);
        child.stdin.end();
        const [status, signal] = await exited; assert.equal(status, 0); assert.equal(signal, null);
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
