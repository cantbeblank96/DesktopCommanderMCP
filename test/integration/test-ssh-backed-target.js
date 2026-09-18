import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProfile } from '../../dist/remote-device/ssh-profile-config.js';
import { SshBackend, makeSshParameters, quotePosix } from '../../dist/remote-device/ssh-backend.js';

const execute = promisify(execFile);
const configPath = process.env.RDC_SSH_TEST_CONFIG;
const consent = process.env.RDC_SSH_TEST_ALLOW_REMOTE_WRITE === '1';
const skip = !configPath || !consent ? 'Explicit target config and remote test-write consent required' : false;
const text = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

test('explicit target: tools execute on the SSH node, reconnect and clean up', { skip, timeout: 120000 }, async () => {
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const config = await loadProfile(configPath, raw.profile);
    const backend = new SshBackend(config);
    const connection = makeSshParameters(config.backend);
    const ssh = async command => (await execute(connection.command,
        [...connection.args.slice(0, -1), command],
        { env: connection.env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
    const marker = `rdc-accept-${randomUUID()}`;
    const directory = `/tmp/${marker}`;
    const filename = `${directory}/roundtrip.txt`;
    let created = false;
    const pids = [];
    let toolCount = 0;
    const tool = async (name, args) => {
        const result = await backend.callClientTool(name, args);
        assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
        return result;
    };
    const rememberPid = async () => {
        const result = await tool('get_config', {});
        const pid = result.structuredContent?.config?.systemInfo?.processInfo?.pid;
        assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Backend must report its own PID');
        pids.push(pid);
        return pid;
    };
    const requireExited = async pid => {
        for (let n = 0; n < 10; n++) {
            if ((await ssh(`if test -d /proc/${pid}; then printf present; else printf absent; fi`)) === 'absent') return;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        assert.fail(`Backend PID ${pid} is still present; automatic remote cleanup was not confirmed`);
    };
    try {
        await backend.initialize();
        await backend.ping();
        toolCount = backend.listClientTools().tools.length;
        const firstIdentity = { ...backend.identity };
        await rememberPid();
        await ssh(`test ! -e ${quotePosix(directory)}`);
        await tool('create_directory', { path: directory });
        created = true;
        await tool('write_file', { path: filename, content: `${marker}\nphase=before\n`, mode: 'rewrite' });
        assert.match(text(await tool('read_file', { path: filename })), /phase=before/);
        await tool('edit_block', { file_path: filename, old_string: 'phase=before', new_string: 'phase=after' });
        assert.match(text(await tool('read_file', { path: filename })), /phase=after/);
        assert.equal(await ssh(`cat ${quotePosix(filename)}`), `${marker}\nphase=after\n`);
        await assert.rejects(fs.access(filename), /ENOENT/, 'Node test file must not exist on the bridge');
        const processResult = await tool('start_process', {
            command: `printf '%s\\n' '${marker}'; hostname; id -un`, shell: '/bin/sh', timeout_ms: 1000,
        });
        assert.ok(text(processResult).includes(config.verification.expectedHostname));
        const search = await tool('start_search', {
            path: directory, pattern: marker, searchType: 'content', literalSearch: true, timeout_ms: 1000,
        });
        const searchId = text(search).match(/search_\d+_\d+/)?.[0];
        assert.ok(searchId, 'Search returned a session ID');
        let matches = text(search);
        for (let i = 0; i < 10; i++) {
            const page = text(await tool('get_more_search_results', { sessionId: searchId, offset: 0, length: 50 }));
            matches += page;
            if (/COMPLETED|Search completed/.test(page)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(matches.includes('roundtrip.txt'), 'Search found the remote test file');
        await backend.invalidate('Controlled acceptance-test reconnect; no user tasks started');
        await requireExited(pids[0]);
        await backend.initialize();
        assert.equal(backend.identity.schemaHash, firstIdentity.schemaHash);
        assert.deepEqual(backend.identity, firstIdentity);
        await rememberPid();
        assert.notEqual(pids[1], pids[0], 'A new backend process was started');
        assert.match(text(await tool('read_file', { path: filename })), /phase=after/);
        assert.equal(await ssh(`cat ${quotePosix(filename)}`), `${marker}\nphase=after\n`);
        await backend.shutdown();
        await requireExited(pids[1]);
    } finally {
        await backend.shutdown();
        if (created) {
            // Remove only this test's two explicitly named paths. Never rm -rf a user directory.
            await ssh(`rm -f -- ${quotePosix(filename)} && rmdir -- ${quotePosix(directory)}`);
        }
    }
    console.log(JSON.stringify({ status: 'PASS', targetProfile: config.profile,
        backend: backend.identity, toolCount, fileRoundtrip: true, preciseEdit: true,
        independentSshReadback: true, absentOnBridge: true, commandExecution: true,
        contentSearch: true, reconnectRoundtrip: true, managedBackendsExited: pids.length,
        temporaryFilesRemoved: true, gpuTasksStarted: 0, cloudEnrollmentTested: false }));
});
