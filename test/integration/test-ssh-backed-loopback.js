// Opt-in integration test. Uses a temporary loopback-only sshd and keys.
// No cloud registration, existing SSH credentials, production nodes or sudo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SshBackend, quotePosix } from '../../dist/remote-device/ssh-backend.js';
import { parseProfile } from '../../dist/remote-device/ssh-profile-config.js';
const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const configQuote = value => '"' + value.replace(/[\\"]/g, '\\$&') + '"';
async function processStamp(pid) {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] === 'Z' ? null : fields[19];
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
test('real OpenSSH loopback forwards tools to an isolated ordinary backend', { timeout: 60000 }, async t => {
    if (process.platform !== 'linux') { t.skip('Linux-only integration fixture'); return; }
    const sshd = process.env.RDC_TEST_SSHD || '/usr/sbin/sshd';
    try { await fs.access(sshd); }
    catch { t.skip('OpenSSH server is not installed; no system packages are installed by this test'); return; }
    const browsers = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium'];
    if (!(await Promise.all(browsers.map(p => fs.access(p).then(() => true, () => false)))).some(Boolean)) {
        t.skip('A preinstalled browser is required to avoid upstream automatic downloads'); return;
    }
    // Keep StrictModes enabled. /tmp is intentionally world-writable and is not
    // a suitable ancestor for this sshd's AuthorizedKeysFile.
    const actualHome = os.userInfo().homedir;
    const homeMode = await fs.stat(actualHome);
    assert.equal(homeMode.mode & 0o022, 0, 'Fixture needs a non-group/world-writable account home');
    const root = await fs.mkdtemp(path.join(actualHome, '.dc-ssh-loopback-test-'));
    const home = path.join(root, 'backend-home'), workspace = path.join(root, 'backend-work');
    await fs.mkdir(home); await fs.mkdir(workspace);
    let daemon, backend, nodePid, nodeStamp, daemonLog = '';
    t.after(async () => {
        try {
            await backend?.shutdown().catch(() => {});
            if (!nodePid) {
                const stat = await fs.readFile(path.join(root, 'backend.stat'), 'utf8').catch(() => '');
                if (stat) {
                    nodePid = Number(stat.split(' ')[0]);
                    nodeStamp = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
                }
            }
            if (nodePid && nodeStamp && await processStamp(nodePid) === nodeStamp) {
                const env = await fs.readFile(`/proc/${nodePid}/environ`).catch(() => Buffer.alloc(0));
                if (env.includes(Buffer.from(`HOME=${home}\0`))) {
                    process.kill(nodePid, 'SIGTERM'); await delay(300);
                    if (await processStamp(nodePid) === nodeStamp) process.kill(nodePid, 'SIGKILL');
                }
            }
            if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
                daemon.kill('SIGTERM'); await delay(300);
                if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
            }
            if (process.env.RDC_SSH_TEST_EVIDENCE)
                await fs.writeFile(process.env.RDC_SSH_TEST_EVIDENCE, daemonLog, { mode: 0o600 });
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'host-key')]);
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'client-key')]);
    await fs.copyFile(path.join(root, 'client-key.pub'), path.join(root, 'authorized_keys'));
    const port = await new Promise((resolve, reject) => {
        const socket = net.createServer(); socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
    });
    const user = (await exec('id', ['-un'])).stdout.trim();
    const daemonConfig = path.join(root, 'sshd_config');
    await fs.writeFile(daemonConfig, [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${configQuote(path.join(root, 'host-key'))}`,
        `PidFile ${configQuote(path.join(root, 'sshd.pid'))}`,
        `AuthorizedKeysFile ${configQuote(path.join(root, 'authorized_keys'))}`,
        'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
        'UsePAM no', 'StrictModes yes', 'PermitRootLogin no', 'AllowAgentForwarding no',
        'AllowTcpForwarding no', 'PermitUserEnvironment no', 'LogLevel VERBOSE',
    ].join('\n') + '\n');
    await exec(sshd, ['-t', '-f', daemonConfig]);
    daemon = spawn(sshd, ['-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr.on('data', chunk => { daemonLog = (daemonLog + chunk.toString()).slice(-65536); });
    await delay(300);
    assert.equal(daemon.exitCode, null, daemonLog);
    const publicKey = (await fs.readFile(path.join(root, 'host-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    await fs.writeFile(path.join(root, 'known_hosts'), `[127.0.0.1]:${port} ${publicKey}\n`);
    const clientConfig = path.join(root, 'ssh_config');
    await fs.writeFile(clientConfig, [
        'Host rdc-loopback', '    HostName 127.0.0.1', `    Port ${port}`, `    User ${configQuote(user)}`,
        `    IdentityFile ${configQuote(path.join(root, 'client-key'))}`, '    IdentitiesOnly yes', '    IdentityAgent none',
        `    UserKnownHostsFile ${configQuote(path.join(root, 'known_hosts'))}`, '    GlobalKnownHostsFile /dev/null',
        '    StrictHostKeyChecking yes', '    BatchMode yes',
    ].join('\n') + '\n');
    const launcher = path.join(root, 'backend-launcher');
    await fs.writeFile(launcher, [
        '#!/bin/sh', 'set -eu', 'umask 077', `export HOME=${quotePosix(home)}`,
        `export XDG_CONFIG_HOME=${quotePosix(path.join(home, '.config'))}`,
        'export DC_REMOTE_DEVICE=true', 'export DESKTOP_COMMANDER_DISABLE_TELEMETRY=1',
        `export PATH=${quotePosix(path.dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin')}`,
        `cat /proc/$$/stat > ${quotePosix(path.join(root, 'backend.stat'))}`,
        `cd ${quotePosix(workspace)}`,
        `exec ${quotePosix(process.execPath)} ${quotePosix(path.join(ROOT, 'dist/index.js'))} --no-onboarding`,
    ].join('\n') + '\n', { mode: 0o700 });
    const config = parseProfile({ schemaVersion: 1, profile: 'loopback', deviceName: 'Isolated loopback test',
        backend: { type: 'ssh', sshExecutable: '/usr/bin/ssh', sshConfigFile: clientConfig,
            hostAlias: 'rdc-loopback', remoteLauncher: launcher },
        verification: { expectedHostname: os.hostname(), expectedUser: user },
        lifecycle: { initializeTimeoutMs: 20000 } });
    backend = new SshBackend(config);
    await backend.initialize();
    const details = await backend.callClientTool('get_config', {});
    nodePid = details.structuredContent?.config?.systemInfo?.processInfo?.pid;
    assert.equal(typeof nodePid, 'number'); nodeStamp = await processStamp(nodePid);
    const remoteEnvironment = await fs.readFile(`/proc/${nodePid}/environ`);
    assert.ok(remoteEnvironment.includes(Buffer.from(`HOME=${home}\0`)));
    const filename = path.join(workspace, 'roundtrip.txt');
    const payload = 'SSH-backed Desktop Commander\n中文与引号 \' "; $()\n';
    const written = await backend.callClientTool('write_file', { path: filename, content: payload, mode: 'rewrite' });
    assert.ok(!written.isError, JSON.stringify(written));
    assert.equal(await fs.readFile(filename, 'utf8'), payload);
    const read = await backend.callClientTool('read_file', { path: filename });
    assert.match(JSON.stringify(read), /SSH-backed Desktop Commander/);
    const command = await backend.callClientTool('start_process',
        { command: 'printf RDC_LOOPBACK_COMMAND_OK; pwd', shell: '/bin/sh', timeout_ms: 1000 });
    assert.match(JSON.stringify(command), /RDC_LOOPBACK_COMMAND_OK/);
    const pinned = await fs.readFile(path.join(root, 'known_hosts'), 'utf8');
    const wrongKey = (await fs.readFile(path.join(root, 'client-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    await fs.writeFile(path.join(root, 'known_hosts'), `[127.0.0.1]:${port} ${wrongKey}\n`);
    const rejectedBackend = new SshBackend(config);
    try { await assert.rejects(rejectedBackend.initialize(), { code: 'SSH_HOST_KEY_MISMATCH' }); }
    finally {
        await rejectedBackend.shutdown();
        await fs.writeFile(path.join(root, 'known_hosts'), pinned);
    }
    const firstSchema = backend.identity.schemaHash;
    await backend.invalidate('integration reconnection test');
    for (let i = 0; i < 50 && await processStamp(nodePid); i++) await delay(100);
    assert.equal(await processStamp(nodePid), null, 'Old backend remained alive after reconnection cleanup');
    await backend.initialize();
    assert.equal(backend.identity.schemaHash, firstSchema, 'Normal backend restart must preserve the callable schema');
    const reconnected = await backend.callClientTool('get_config', {});
    nodePid = reconnected.structuredContent?.config?.systemInfo?.processInfo?.pid;
    assert.equal(typeof nodePid, 'number'); nodeStamp = await processStamp(nodePid);
    const reread = await backend.callClientTool('read_file', { path: filename });
    assert.match(JSON.stringify(reread), /SSH-backed Desktop Commander/);
    await backend.shutdown();
    for (let i = 0; i < 50 && await processStamp(nodePid); i++) await delay(100);
    assert.equal(await processStamp(nodePid), null, 'Ordinary backend remained alive after bridge shutdown');
    console.log(JSON.stringify({ status: 'PASS', transport: 'real OpenSSH loopback',
        backend: backend.identity, toolCount: 'verified via MCP', fileRoundtrip: true,
        commandExecution: true, hostKeyRejection: true, reconnectRoundtrip: true, backendExited: true, cloudEnrollmentTested: false }));
});
