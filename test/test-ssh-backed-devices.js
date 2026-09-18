import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseProfile, parseRemoteArguments, ProfileError, digest, bindingDigest } from '../dist/remote-device/ssh-profile-config.js';
import { SshBackend, makeSshParameters, quotePosix, toolSchemaDigest, extractIdentityFrame } from '../dist/remote-device/ssh-backend.js';
import { ProfileState } from '../dist/remote-device/profile-state.js';
import { CallJournal } from '../dist/remote-device/call-journal.js';
import { ProfileDispatcher } from '../dist/remote-device/profile-dispatcher.js';
import { BackendSupervisor } from '../dist/remote-device/backend-supervisor.js';
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { DeviceAuthenticator } = await import('../dist/remote-device/device-authenticator.js');
const { SshProfileDevice } = await import('../dist/remote-device/ssh-profile-device.js');
const DEVICE = '11111111-1111-4111-8111-111111111111';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 4000) {
    const start = performance.now();
    while (!predicate()) {
        if (performance.now() - start > timeout) throw new Error('Condition did not become true');
        await delay(10);
    }
}
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-ssh-test-'));
    const cleanups = [];
    t.after(async () => {
        try { for (const close of cleanups.reverse()) await close(); }
        finally { await fs.rm(root, { recursive: true, force: true }); }
    });
    return { root, cleanups };
}
function profile(root, overrides = {}) {
    return parseProfile({ schemaVersion: 1, profile: 'test-node', deviceName: 'Node B via A',
        backend: { type: 'ssh', sshExecutable: path.join(root, 'fake-ssh'),
            sshConfigFile: path.join(root, 'ssh.json'), hostAlias: 'fixture-node', remoteLauncher: '/fixture/stdio' },
        verification: { expectedHostname: 'fixture-node', expectedUser: 'fixture-user' },
        ...overrides });
}
async function fixture(t, mode = 'normal', overrides = {}) {
    const resource = await temporary(t), { root, cleanups } = resource;
    const config = profile(root, overrides);
    await fs.writeFile(config.backend.sshConfigFile, JSON.stringify({ root, mode }));
    await fs.writeFile(config.backend.sshExecutable,
        `#!/bin/sh\nexec ${quotePosix(process.execPath)} ${quotePosix(path.join(ROOT, 'test/fixtures/ssh-profile-mcp.js'))} "$@"\n`, { mode: 0o700 });
    const backend = new SshBackend(config);
    cleanups.push(() => backend.shutdown());
    return { ...resource, backend, config };
}
test('CLI rejects typos, missing profiles and conflicting actions before local fallback', () => {
    for (const args of [['--profle', 'b'], ['--profile', '../b'], ['--config', '/tmp/x'],
        ['--profile', 'b'], ['--profile', 'b', '--config', '/tmp/x', '--doctor', '--enroll'],
        ['--profile', 'b', '--config', '/tmp/x', '--no-persist-session']])
        assert.throws(() => parseRemoteArguments(args), { code: 'PROFILE_INVALID' });
    assert.equal(parseRemoteArguments(['--profile=b', '--config=/tmp/x', '--doctor']).doctor, true);
    assert.equal(parseRemoteArguments(['--logout']).profile, undefined);
    assert.equal(parseRemoteArguments(['--profile', 'b', '--logout']).profile, 'b');
});
test('SSH schema is strict and shell quoting preserves malicious-looking literal paths', () => {
    const config = profile('/tmp/fixture');
    assert.throws(() => parseProfile({ ...config, surprise: true }), { code: 'PROFILE_INVALID' });
    assert.throws(() => parseProfile(config, 'other'), { code: 'PROFILE_INVALID' });
    assert.throws(() => makeSshParameters({ ...config.backend, hostAlias: '-oProxyCommand=bad' }), { code: 'PROFILE_INVALID' });
    const literal = "/tmp/a b'; printf INJECTED; # $(printf bad)";
    const printed = spawnSync('/bin/sh', ['-c', `printf '%s' ${quotePosix(literal)}`], { encoding: 'utf8' });
    assert.equal(printed.status, 0); assert.equal(printed.stdout, literal);
    const parameters = makeSshParameters({ ...config.backend, remoteLauncher: literal });
    assert.equal(parameters.args.at(-1), `exec ${quotePosix(literal)}`);
    for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'ControlPath=none'])
        assert.ok(parameters.args.includes(option));
    assert.equal(parameters.env.GITHUB_TOKEN, undefined);
    assert.equal(parameters.env.MCP_SERVER_URL, undefined);
    assert.throws(() => quotePosix('/tmp/x\ncommand'), { code: 'PROFILE_INVALID' });
});
test('profiles isolate credentials, serialize rotations and preserve legacy state', async t => {
    const { root, cleanups } = await temporary(t);
    const legacy = path.join(root, '.desktop-commander-device');
    await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'device.json'), 'legacy-sentinel');
    const a = new ProfileState('node-a', root), b = new ProfileState('node-b', root);
    await a.acquire(); cleanups.push(() => a.release());
    await b.acquire(); cleanups.push(() => b.release());
    const value = { schemaVersion: 1, deviceId: DEVICE, bindingDigest: 'a'.repeat(64),
        session: { access_token: 'test-access', refresh_token: 'first' } };
    await Promise.all(['first', 'second', 'third'].map(refresh_token => a.saveCredentials({ ...value,
        session: { ...value.session, refresh_token } })));
    assert.equal((await a.loadCredentials()).session.refresh_token, 'third');
    assert.equal(await b.loadCredentials(), null);
    assert.equal(await fs.readFile(path.join(legacy, 'device.json'), 'utf8'), 'legacy-sentinel');
    assert.equal((await fs.stat(path.join(a.directory, 'device.json'))).mode & 0o777, 0o600);
    await assert.rejects(new ProfileState('node-a', root).acquire(), { code: 'PROFILE_ALREADY_RUNNING' });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {ProfileState} from ${JSON.stringify(new URL('../dist/remote-device/profile-state.js', import.meta.url).href)};
         try { await new ProfileState('node-a', ${JSON.stringify(root)}).acquire(); process.exit(2); }
         catch(e) { process.exit(e.code === 'PROFILE_ALREADY_RUNNING' ? 0 : 3); }`], { timeout: 5000 });
    assert.equal(child.status, 0, String(child.stderr));
    await a.logout(); assert.equal(await a.loadCredentials(), null);
    assert.equal(await fs.readFile(path.join(legacy, 'device.json'), 'utf8'), 'legacy-sentinel');
});
test('corrupt state, symlinks and target drift fail closed', async t => {
    const { root, cleanups } = await temporary(t);
    const state = new ProfileState('node', root); await state.acquire(); cleanups.push(() => state.release());
    const credentials = path.join(state.directory, 'device.json');
    await fs.writeFile(credentials, 'null');
    await assert.rejects(state.loadCredentials(), { code: 'STATE_CORRUPT' });
    await fs.rm(credentials); await fs.symlink('/nonexistent/rdc-test', credentials);
    await assert.rejects(state.loadCredentials(), { code: 'STATE_CORRUPT' });
    await fs.rm(credentials);
    await assert.rejects(state.checkBinding('a'.repeat(64), undefined, false, true), { code: 'STATE_CORRUPT' });
    const identity = { hostname: 'b', user: 'u', platform: 'linux', arch: 'x86_64', serverName: 'dc', serverVersion: '1', schemaHash: 'x' };
    await state.checkBinding('a'.repeat(64), identity, true);
    await assert.rejects(state.checkBinding('b'.repeat(64), identity), { code: 'TARGET_BINDING_MISMATCH' });
    await assert.rejects(state.checkBinding('a'.repeat(64), { ...identity, hostname: 'a' }), { code: 'TARGET_BINDING_MISMATCH' });
});
test('SSH backend verifies identity, paginates tools and forwards original arguments', async t => {
    const { backend, root } = await fixture(t);
    await backend.initialize(); assert.equal(backend.ready, true);
    assert.equal(backend.identity.hostname, 'fixture-node');
    assert.equal(backend.listClientTools().tools.length, 6);
    const args = { path: '/node/file', content: "中文\n'; $(printf no)\n", mode: 'rewrite' };
    const result = await backend.callClientTool('write_file', args, { remote: false, client: 'test' });
    assert.deepEqual(result.structuredContent.args, args);
    assert.equal(result.structuredContent.metadata.remote, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'payload'), 'utf8')), args);
});
for (const [mode, code] of [['wrong-host', 'TARGET_IDENTITY_MISMATCH'], ['missing-tools', 'BACKEND_INIT_FAILED'], ['deny', 'SSH_CONFIGURATION_ERROR']]) {
    test(`SSH initialization rejects ${mode} without any local fallback`, async t => {
        const { backend } = await fixture(t, mode);
        await assert.rejects(backend.initialize(), { code });
        assert.equal(backend.ready, false);
        await assert.rejects(backend.callClientTool('write_file', {}), { code: 'BACKEND_UNAVAILABLE' });
    });
}
test('handshake timeout closes its child and does not leave an apparently ready backend', async t => {
    const { backend, root } = await fixture(t, 'hang-init', { lifecycle: { initializeTimeoutMs: 500 } });
    const start = performance.now();
    await assert.rejects(backend.initialize());
    assert.ok(performance.now() - start < 5000); assert.equal(backend.ready, false);
    const pids = (await fs.readFile(path.join(root, 'starts'), 'utf8')).trim().split('\n').map(Number);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('a connection lost mid-write returns unknown and never silently repeats the write', async t => {
    const { backend, root } = await fixture(t, 'drop-mid-write');
    await backend.initialize();
    await assert.rejects(backend.callClientTool('write_file', { content: 'once' }), { code: 'REMOTE_RESULT_UNKNOWN' });
    assert.equal(await fs.readFile(path.join(root, 'writes'), 'utf8'), 'write\n');
    assert.equal(backend.ready, false);
});
test('known process and search handles are rejected after backend replacement', async t => {
    const { backend } = await fixture(t);
    await backend.initialize();
    await backend.callClientTool('start_process', { command: 'fixture' });
    await backend.callClientTool('start_search', { path: '/fixture', pattern: 'x' });
    await backend.invalidate('test reconnect'); await backend.initialize();
    await assert.rejects(backend.callClientTool('read_process_output', { pid: 990002 }), { code: 'SESSION_CONTEXT_LOST' });
    await assert.rejects(backend.callClientTool('get_more_search_results', { sessionId: 'search_1_12345' }), { code: 'SESSION_CONTEXT_LOST' });
});
test('supervisor retries without tool calls and stops reconnecting after shutdown', async t => {
    let ready = false, attempts = 0, disconnect;
    const states = [], fatals = [];
    const fake = { get ready() { return ready; }, onDisconnect(cb) { disconnect = cb; },
        async initialize() { if (++attempts < 3) throw new ProfileError('SSH_CONNECT_FAILED', 'fixture', true); ready = true; },
        async ping() {}, async invalidate() { ready = false; disconnect(); }, async shutdown() { ready = false; } };
    const cfg = profile('/tmp/fixture', { lifecycle: { reconnectMaxDelayMs: 100, healthIntervalMs: 1000 } });
    const supervisor = new BackendSupervisor(fake, cfg.lifecycle, async () => {}, value => states.push(value), error => fatals.push(error));
    t.after(() => supervisor.stop());
    await supervisor.start(); assert.equal(attempts, 3);
    ready = false; disconnect(); await until(() => attempts === 4 && ready);
    await supervisor.stop(); const stoppedAt = attempts; await delay(150);
    assert.equal(attempts, stoppedAt); assert.equal(states.at(-1), false); assert.deepEqual(fatals, []);
});
async function dispatchFixture(t, maxEntries = 100) {
    const { root } = await temporary(t);
    const journal = new CallJournal(root, maxEntries); await journal.initialize();
    const calls = [], reports = [], fatals = [];
    const runtime = { deviceId: DEVICE, binding: 'test-binding',
        backend: { ready: true, async ping() {}, async callClientTool(name, args) { calls.push({ name, args }); return { content: [{ type: 'text', text: 'saved' }] }; } },
        channel: { async markCallExecuting() { return true; }, async updateCallResult(...args) { reports.push(args); } },
        async verifyAuthorization() {}, onShutdown() {}, onFatal(error) { fatals.push(error); } };
    return { root, journal, runtime, calls, reports, fatals, dispatcher: new ProfileDispatcher(runtime, journal) };
}
const request = (id = 'call-1', content = 'PRIVATE_PAYLOAD') => ({ new: { id, device_id: DEVICE,
    tool_name: 'write_file', tool_args: { path: '/node/file', content } } });
test('duplicate deliveries and result-upload retries do not re-execute tools', async t => {
    const f = await dispatchFixture(t);
    let uploads = 0;
    f.runtime.channel.updateCallResult = async (...args) => { if (++uploads === 1) throw new Error('network'); f.reports.push(args); };
    await Promise.all([f.dispatcher.handle(request()), f.dispatcher.handle(request())]);
    assert.equal(f.calls.length, 1); assert.equal(f.journal.pending(DEVICE).length, 1);
    await f.dispatcher.handle(request());
    assert.equal(f.calls.length, 1); assert.equal(f.journal.pending(DEVICE).length, 0);
    await f.dispatcher.handle(request('call-1', 'DIFFERENT'));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.fatals, []);
    for (const file of await fs.readdir(f.journal.directory))
        assert.ok(!(await fs.readFile(path.join(f.journal.directory, file), 'utf8')).includes('PRIVATE_PAYLOAD'));
});
test('interrupted durable intents become unknown after restart and are never replayed', async t => {
    const f = await dispatchFixture(t), payload = request();
    const fingerprint = digest({ binding: f.runtime.binding, name: payload.new.tool_name,
        args: payload.new.tool_args, metadata: {} });
    await f.journal.reserve(DEVICE, payload.new.id, fingerprint);
    const restarted = new CallJournal(f.root); await restarted.initialize(); await restarted.recoverInterrupted();
    const dispatcher = new ProfileDispatcher(f.runtime, restarted);
    await dispatcher.handle(payload);
    assert.equal(f.calls.length, 0);
    assert.match(f.reports[0][3], /REMOTE_RESULT_UNKNOWN/);
});
test('missing authorization and full journals stop execution', async t => {
    const f = await dispatchFixture(t);
    f.runtime.verifyAuthorization = async () => { throw new ProfileError('AUTH_CHECK_FAILED', 'fixture', true); };
    await f.dispatcher.handle(request());
    assert.equal(f.calls.length, 0); assert.match(f.reports[0][3], /AUTH_CHECK_FAILED/);
    const full = await dispatchFixture(t, 0);
    await full.dispatcher.handle(request());
    assert.equal(full.calls.length, 0); assert.equal(full.fatals[0].code, 'JOURNAL_FULL');
});
test('calls for other devices are ignored without writing dispatch records', async t => {
    const f = await dispatchFixture(t), payload = request(); payload.new.device_id = 'other';
    await f.dispatcher.handle(payload);
    assert.equal(f.calls.length, 0); assert.equal((await fs.readdir(f.journal.directory)).length, 0);
});
function fakeChannel(error = null) {
    const writes = [], presence = [];
    const channel = new RemoteChannel();
    channel.deviceId = DEVICE; channel._user = { id: 'test-user' }; channel.onToolCall = () => {};
    channel.client = { from(table) {
        let payload;
        const query = { update(value) { payload = value; return query; }, eq() { return query; },
            select() { return query; }, abortSignal() { return query; },
            then(resolve, reject) { writes.push({ table, payload }); return Promise.resolve({ data: [{ id: DEVICE }], error }).then(resolve, reject); } };
        return query;
    } };
    channel.channel = { state: 'joined', async track(value) { presence.push(['track', value]); return 'ok'; },
        async untrack() { presence.push(['untrack']); return 'ok'; } };
    return { channel, writes, presence };
}
test('offline backend cannot be advertised online by heartbeat or presence recovery', async () => {
    const { channel, writes, presence } = fakeChannel();
    await channel.setBackendAvailability(true, 'linux');
    await channel.setBackendAvailability(false);
    const tracks = presence.filter(p => p[0] === 'track').length;
    await channel.updateHeartbeat(DEVICE); await channel.trackPresenceWithRetry(0, 1);
    await channel.setOnlineStatus(DEVICE, 'online');
    assert.equal(writes.filter(w => w.payload?.status).at(-1).payload.status, 'offline');
    assert.equal(presence.filter(p => p[0] === 'track').length, tracks);
    assert.equal(presence.at(-1)[0], 'untrack');
});
test('a late successful presence publish cannot resurrect a failed backend', async () => {
    const { channel, presence } = fakeChannel();
    let release, started = false;
    channel.channel.track = async () => { started = true; await new Promise(resolve => { release = resolve; }); return 'ok'; };
    const online = channel.setBackendAvailability(true);
    await until(() => started);
    const offline = channel.setBackendAvailability(false);
    release(); await Promise.all([online, offline]);
    assert.equal(channel.presenceTracked, false); assert.equal(presence.at(-1)[0], 'untrack');
});
test('strict cloud claims and result writes surface errors rather than failing open', async () => {
    const { channel, writes } = fakeChannel({ message: 'transient fixture failure' });
    await assert.rejects(channel.markCallExecuting('call', true), /CALL_CLAIM_FAILED/);
    await assert.rejects(channel.updateCallResult('call', 'completed', { ok: true }, null, true), /RESULT_UPLOAD_FAILED/);
    assert.equal(writes.length, 2);
});
test('authorization uses the explicitly configured node name', async t => {
    const original = globalThis.fetch; let body;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ device_code: 'fixture', expires_in: 1 }), { status: 200 });
    };
    const auth = new DeviceAuthenticator('https://example.invalid', { deviceName: 'Node B', openBrowser: false });
    await auth.requestDeviceCode('challenge'); assert.equal(body.device_name, 'Node B');
});
test('startup stdout pollution is rejected as a protocol error', async t => {
    const { backend } = await fixture(t, 'stdout-noise');
    await assert.rejects(backend.initialize(), { code: 'BACKEND_PROTOCOL_ERROR' });
    assert.equal(backend.ready, false);
});
test('CLI doctor does not enroll; normal service without credentials does not open SSH', async t => {
    const { root, config } = await fixture(t);
    const filename = path.join(root, 'profile.json');
    await fs.writeFile(filename, JSON.stringify(config));
    const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_REMOTE_DEVICE: 'true' };
    const args = [path.join(ROOT, 'dist/index.js'), 'remote', '--profile', config.profile, '--config', filename];
    const missing = spawnSync(process.execPath, [...args, '--non-interactive'], { env, timeout: 15000, encoding: 'utf8' });
    assert.equal(missing.status, 77, missing.stdout + missing.stderr);
    await assert.rejects(fs.access(path.join(root, 'starts')), { code: 'ENOENT' });
    const doctor = spawnSync(process.execPath, [...args, '--doctor'], { env, timeout: 15000, encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /BACKEND_VERIFIED/);
    const credentials = path.join(env.HOME, '.desktop-commander-device/profiles', config.profile, 'device.json');
    await assert.rejects(fs.access(credentials), { code: 'ENOENT' });
});
test('a backend generation cannot dispatch until its binding/schema check is approved', async t => {
    const { root } = await temporary(t);
    const device = new SshProfileDevice(profile(root), new ProfileState('test-node', root));
    let executed = 0;
    device.backend = { ready: true, epoch: 2, async ping() {}, async callClientTool() { executed++; return {}; } };
    device.approvedEpoch = 1;
    const guarded = device.createDispatchBackend();
    assert.equal(guarded.ready, false);
    await assert.rejects(guarded.callClientTool('write_file', {}), { code: 'BACKEND_UNAVAILABLE' });
    device.approvedEpoch = 2; await guarded.callClientTool('write_file', {});
    assert.equal(executed, 1);
    device.backend.epoch = 3;
    await assert.rejects(guarded.ping(), { code: 'BACKEND_UNAVAILABLE' });
    device.stopped = true; device.approvedEpoch = 3; assert.equal(guarded.ready, false);
});
test('a clock correction cannot cause a live profile lock to be stolen', async t => {
    const { root, cleanups } = await temporary(t);
    const first = new ProfileState('clock-test', root); await first.acquire(); cleanups.push(() => first.release());
    const second = new ProfileState('clock-test', root); const originalNow = Date.now;
    try {
        Date.now = () => originalNow() + 120000;
        await assert.rejects(second.acquire(), { code: 'PROFILE_ALREADY_RUNNING' });
    } finally { Date.now = originalNow; }
});
test('binding includes the profile identity and blocks unreviewed schema changes', async t => {
    const { config, root, cleanups } = await fixture(t);
    const first = await bindingDigest(config);
    assert.notEqual(await bindingDigest({ ...config, profile: 'another-profile' }), first);
    assert.equal(await bindingDigest({ ...config, deviceName: 'Renamed device' }), first);
    const state = new ProfileState('binding-test', root); await state.acquire(); cleanups.push(() => state.release());
    const identity = { hostname: 'b', user: 'u', platform: 'linux', arch: 'x86_64', serverName: 'dc', serverVersion: '1', schemaHash: 'old' };
    await state.checkBinding(first, identity, true);
    await assert.rejects(state.checkBinding(first, { ...identity, schemaHash: 'new' }), { code: 'SCHEMA_MISMATCH' });
});
test('supervisor restarts an unresponsive backend after the configured failure threshold', async t => {
    let ready = false, starts = 0, pings = 0, disconnect;
    const fake = { get ready() { return ready; }, onDisconnect(cb) { disconnect = cb; },
        async initialize() { starts++; ready = true; },
        async ping() { pings++; throw new Error('unresponsive'); },
        async invalidate() { ready = false; disconnect(); }, async shutdown() { ready = false; } };
    const cfg = profile('/tmp/fixture', { lifecycle: { healthIntervalMs: 100, healthFailureThreshold: 2 } });
    const supervisor = new BackendSupervisor(fake, cfg.lifecycle, async () => {}, () => {}, error => { throw error; });
    t.after(() => supervisor.stop());
    await supervisor.start(); await until(() => starts === 2);
    assert.equal(pings, 2); await supervisor.stop();
});
test('shutdown during a handshake cannot revive the backend later', async t => {
    const { backend } = await fixture(t, 'hang-init', { lifecycle: { initializeTimeoutMs: 5000 } });
    const outcome = backend.initialize().then(() => null, error => error);
    await delay(350); await backend.shutdown();
    assert.ok(await outcome); assert.equal(backend.ready, false);
    await delay(100); assert.equal(backend.ready, false);
});
test('oversized results become an explicit failure and corrupt journals are rejected', async t => {
    const { root } = await temporary(t);
    const journal = new CallJournal(root, 10, 1024 * 1024, 64); await journal.initialize();
    await journal.reserve(DEVICE, 'bounded', 'a'.repeat(64));
    await journal.complete(DEVICE, 'bounded', { status: 'completed', result: 'x'.repeat(1024), error: null });
    const report = journal.pending(DEVICE)[0].report;
    assert.equal(report.status, 'failed'); assert.match(report.error, /RESULT_CACHE_LIMIT/);
    await journal.markDelivered(DEVICE, 'bounded');
    const file = (await fs.readdir(journal.directory))[0];
    await fs.writeFile(path.join(journal.directory, file), '{incomplete');
    await assert.rejects(new CallJournal(root).initialize(), { code: 'STATE_CORRUPT' });
});
test('schema hashes ignore process-specific prose but detect callable contract changes', () => {
    const original = [{ name: 'start_process', description: 'Current PID: 123', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }];
    assert.equal(toolSchemaDigest(original), toolSchemaDigest([{ ...original[0], description: 'Current PID: 456' }]));
    assert.notEqual(toolSchemaDigest(original), toolSchemaDigest([{ ...original[0], inputSchema: { type: 'object', required: ['command'] } }]));
});

test('identity probe accepts a full re-read after partial initial output', async t => {
    const { backend } = await fixture(t, 'partial-identity');
    await backend.initialize();
    assert.equal(backend.ready, true);
    assert.equal(backend.identity.hostname, 'fixture-node');
    assert.equal(backend.identity.user, 'fixture-user');
});


test('identity snapshots tolerate overlap but reject missing, malformed or oversized frames', () => {
    const begin = '__RDC_ID_test__', end = '__RDC_END_test__';
    const frame = `${begin}\nnode\nuser\nLinux\nx86_64\n${end}\n`;
    const expected = ['node', 'user', 'Linux', 'x86_64'];
    assert.deepEqual(extractIdentityFrame(frame, begin, end), expected);
    assert.deepEqual(extractIdentityFrame(`${begin}\nnode\n[Reading 6 lines]\n${frame}`, begin, end), expected);
    assert.deepEqual(extractIdentityFrame(frame.replace(/\n/g, '\r\n'), begin, end), expected);
    for (const output of [frame.replace(end, ''), frame.replace('user\n', ''),
        frame.replace('user', ''), frame.replace('user', 'user\x00'), 'x'.repeat(65537)])
        assert.equal(extractIdentityFrame(output, begin, end), undefined);
});
