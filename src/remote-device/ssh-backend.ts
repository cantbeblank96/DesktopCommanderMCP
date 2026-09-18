import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ProfileError, digest, sshBackendSchema, type ProfileConfig, type SshBackendConfig } from './ssh-profile-config.js';
import type { BackendIdentity } from './profile-state.js';

export function quotePosix(value: string): string {
    if (/[\x00\r\n]/.test(value)) throw new ProfileError('PROFILE_INVALID', 'Invalid remote launcher path');
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function makeSshParameters(input: SshBackendConfig): StdioServerParameters {
    const result = sshBackendSchema.safeParse(input);
    if (!result.success) throw new ProfileError('PROFILE_INVALID', 'Invalid SSH parameters');
    const config = result.data;
    const env = getDefaultEnvironment();
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    return { command: config.sshExecutable, args: [
        '-F', config.sshConfigFile, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'PermitLocalCommand=no',
        '-o', 'SendEnv=-*', '-o', 'RemoteCommand=none', '-o', 'StdinNull=no',
        '-o', 'ForkAfterAuthentication=no', config.hostAlias, `exec ${quotePosix(config.remoteLauncher)}`,
    ], env, stderr: 'pipe' };
}

/** Tool prose contains live process IDs; only the callable contract is stable. */
export function toolSchemaDigest(tools: Tool[]): string {
    return digest([...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
        name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        annotations: tool.annotations,
    })));
}

export async function withTimeout<T>(operation: Promise<T>, ms: number, code: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([operation, new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new ProfileError(code, `Deadline exceeded (${ms} ms)`, true)), ms);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}
function textOf(result: any): string {
    return (result?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}
/** Read a complete nonce-framed identity from one output snapshot.
 * Process output can overlap the initial response; never concatenate wrappers
 * or partial snapshots and mistake a duplicated begin marker for host data.
 */
export function extractIdentityFrame(output: string, begin: string, end: string): string[] | undefined {
    if (Buffer.byteLength(output) > 65536) return undefined;
    const lines = output.replace(/\r/g, '').split('\n');
    const stop = lines.lastIndexOf(end);
    if (stop < 0) return undefined;
    const start = lines.lastIndexOf(begin, stop);
    if (start < 0 || stop !== start + 5) return undefined;
    const fields = lines.slice(start + 1, stop).map(line => line.trim());
    return fields.every(field => field.length > 0 && !/[\x00-\x1f\x7f]/.test(field)) ? fields : undefined;
}

export function classifySshFailure(error: any, stderr: string): ProfileError {
    if (error instanceof ProfileError && !error.retryable) return error;
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr))
        return new ProfileError('SSH_HOST_KEY_MISMATCH', 'Verify the SSH host key out of band; it was not changed automatically');
    if (/Permission denied.*publickey|no such identity|Bad configuration option|Could not open.*config/i.test(stderr))
        return new ProfileError('SSH_CONFIGURATION_ERROR', 'Check SSH authentication and configuration');
    if (/exec:.*not found|exec:.*No such file|exec:.*Permission denied/i.test(stderr))
        return new ProfileError('BACKEND_INIT_FAILED', 'Remote launcher is missing or not executable');
    return new ProfileError('SSH_CONNECT_FAILED', `SSH/MCP initialization failed (${error?.code ?? error?.name ?? 'unknown'}); run the configured SSH command manually for diagnostics`, true);
}
interface Connection {
    client: Client; transport: StdioClientTransport; epoch: number;
    stderr: string; closed: boolean; closing?: Promise<void>;
    requests: Set<AbortController>;
}

/** SSH-only backend: this class has no local executable-discovery path. */
export class SshBackend {
    private connection?: Connection;
    private initializing?: Promise<void>;
    private stopped = false;
    private generation = 0;
    private verified = false;
    private tools: Tool[] = [];
    private disconnectHandler?: (reason: ProfileError) => void;
    private knownPids = new Set<number>();
    private stalePids = new Set<number>();
    private knownSearches = new Set<string>();
    private staleSearches = new Set<string>();
    identity?: BackendIdentity;
    constructor(readonly config: ProfileConfig) {}
    get ready(): boolean { return this.verified && !!this.connection && !this.connection.closed && !this.stopped; }
    get epoch(): number { return this.generation; }
    onDisconnect(handler: (reason: ProfileError) => void): void { this.disconnectHandler = handler; }
    initialize(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (this.stopped) return Promise.reject(new ProfileError('BACKEND_UNAVAILABLE', 'Backend is stopping'));
        if (!this.initializing) this.initializing = this.connectOnce().finally(() => { this.initializing = undefined; });
        return this.initializing;
    }
    private async closeConnection(connection: Connection): Promise<void> {
        if (!connection.closing) {
            for (const request of connection.requests) request.abort(new Error('SSH backend closing'));
            connection.closing = connection.client.close();
        }
        await connection.closing;
    }
    /** Per-request abort signals also clear SDK 1.25 timers on transport loss. */
    private async request<T>(connection: Connection, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        connection.requests.add(controller);
        try { return await operation(controller.signal); }
        finally { connection.requests.delete(controller); }
    }
    private async connectOnce(): Promise<void> {
        const epoch = ++this.generation;
        const parameters = makeSshParameters(this.config.backend);
        try { await fs.access(parameters.command, constants.X_OK); await fs.access(this.config.backend.sshConfigFile); }
        catch { throw new ProfileError('PROFILE_INVALID', 'SSH executable/configuration is unavailable'); }
        if (this.stopped || epoch !== this.generation) throw new ProfileError('BACKEND_UNAVAILABLE', 'Initialization cancelled');
        const transport = new StdioClientTransport(parameters);
        const client = new Client({ name: 'desktop-commander-ssh-bridge', version: '1.0.0' }, { capabilities: {} });
        const c: Connection = { client, transport, epoch, stderr: '', closed: false, requests: new Set() };
        this.connection = c;
        transport.stderr?.on('data', (chunk: Buffer) => { if (!this.verified) c.stderr = (c.stderr + chunk.toString()).slice(-8192); });
        // Client owns transport callbacks. Do not replace SDK onclose/onmessage.
        client.onclose = () => {
            c.closed = true;
            for (const request of c.requests) request.abort(new Error('SSH transport closed'));
            if (this.connection !== c) return;
            this.verified = false;
            this.retireSessions();
            if (!this.stopped) this.disconnectHandler?.(new ProfileError('BACKEND_UNAVAILABLE', 'SSH/MCP connection closed', true));
        };
        let startupFailure: ProfileError | undefined;
        client.onerror = error => {
            if (!this.verified && error instanceof SyntaxError) {
                startupFailure = new ProfileError('BACKEND_PROTOCOL_ERROR', 'Non-protocol output on SSH stdout during initialization');
                void this.closeConnection(c).catch(() => {});
            }
            // A protocol error after initialization is not by itself proof of death.
        };
        const assertCurrent = () => {
            if (this.stopped || c.closed || this.connection !== c || epoch !== this.generation)
                throw new ProfileError('BACKEND_UNAVAILABLE', 'Obsolete backend connection', true);
        };
        const initialize = async () => {
            await this.request(c, signal => client.connect(transport, { timeout: this.config.lifecycle.initializeTimeoutMs + 10000, signal }));
            assertCurrent();
            const tools: Tool[] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            do {
                const page = await this.request(c, signal => client.listTools(cursor ? { cursor } : undefined, { signal }));
                assertCurrent();
                tools.push(...page.tools);
                cursor = page.nextCursor;
                if (cursor && cursors.has(cursor)) throw new ProfileError('BACKEND_INIT_FAILED', 'Repeated tools/list cursor');
                if (cursor) cursors.add(cursor);
                if (tools.length > 1000 || cursors.size > 100) throw new ProfileError('BACKEND_INIT_FAILED', 'Unbounded tool catalogue');
            } while (cursor);
            const names = new Set(tools.map(t => t.name));
            for (const required of ['read_file', 'write_file', 'edit_block', 'start_process', 'read_process_output'])
                if (!names.has(required)) throw new ProfileError('BACKEND_INIT_FAILED', `Required tool missing: ${required}`);
            if (names.size !== tools.length) throw new ProfileError('BACKEND_INIT_FAILED', 'Duplicate tool names');
            const identity = await this.probeIdentity(c);
            assertCurrent();
            const server = client.getServerVersion();
            this.identity = { ...identity, serverName: server?.name ?? 'unknown',
                serverVersion: server?.version ?? 'unknown', schemaHash: toolSchemaDigest(tools) };
            this.tools = tools;
        };
        try {
            await withTimeout(initialize(), this.config.lifecycle.initializeTimeoutMs, 'BACKEND_INIT_TIMEOUT');
            assertCurrent();
            this.verified = true;
            c.stderr = ''; // Never retain business output in diagnostics after startup.
        } catch (error) {
            if (this.connection === c) { this.verified = false; this.connection = undefined; }
            await withTimeout(this.closeConnection(c), 3000, 'CLEANUP_UNCONFIRMED');
            throw classifySshFailure(startupFailure ?? error, c.stderr);
        }
    }
    private async probeIdentity(c: Connection): Promise<Pick<BackendIdentity, 'hostname' | 'user' | 'platform' | 'arch'>> {
        const client = c.client;
        const nonce = randomBytes(12).toString('hex');
        const begin = `__RDC_ID_${nonce}__`, end = `__RDC_END_${nonce}__`;
        const command = `printf '%s\\n' '${begin}'; hostname; id -un; uname -s; uname -m; printf '%s\\n' '${end}'`;
        let result = await this.request(c, signal => client.callTool({ name: 'start_process', arguments: { command, shell: '/bin/sh', timeout_ms: 1000 }, _meta: { remote: true } }, undefined, { signal }));
        let fields = result.isError ? undefined : extractIdentityFrame(textOf(result), begin, end);
        const pidText = textOf(result).match(/(?:PID|pid)[:\s]+(\d+)/)?.[1];
        const pid = pidText ? Number(pidText) : undefined;
        for (let i = 0; !result.isError && !fields && i < 10 && pid && Number.isSafeInteger(pid) && pid > 1; i++) {
            // A negative offset requests a complete tail snapshot, regardless
            // of the backend's initial-output cursor. Six lines fit in 100.
            result = await this.request(c, signal => client.callTool({
                name: 'read_process_output',
                arguments: { pid, offset: -100, length: 100, timeout_ms: 1000 },
                _meta: { remote: true },
            }, undefined, { signal }));
            if (!result.isError) fields = extractIdentityFrame(textOf(result), begin, end);
        }
        if (result.isError || !fields)
            throw new ProfileError('BACKEND_INIT_FAILED', 'Could not verify backend identity through MCP');
        const [hostname, user, platform, arch] = fields;
        if (hostname !== this.config.verification.expectedHostname || user !== this.config.verification.expectedUser)
            throw new ProfileError('TARGET_IDENTITY_MISMATCH', 'Backend hostname/user does not match the configured target');
        return { hostname, user, platform: platform.toLowerCase(), arch };
    }
    listClientTools(): { tools: Tool[] } {
        if (!this.ready) throw new ProfileError('BACKEND_UNAVAILABLE', 'Backend is not ready', true);
        return { tools: [...this.tools] };
    }
    async ping(): Promise<void> {
        if (!this.ready) throw new ProfileError('BACKEND_UNAVAILABLE', 'Backend is not ready', true);
        const c = this.connection!;
        await this.request(c, signal => c.client.ping({ timeout: this.config.lifecycle.healthTimeoutMs, signal }));
    }
    async invalidate(reason: string): Promise<void> {
        this.verified = false;
        this.retireSessions();
        const c = this.connection;
        if (c) await withTimeout(this.closeConnection(c), 3000, 'CLEANUP_UNCONFIRMED');
        if (!this.stopped) this.disconnectHandler?.(new ProfileError('BACKEND_UNAVAILABLE', reason, true));
    }
    private retireSessions(): void {
        for (const pid of this.knownPids) this.stalePids.add(pid);
        for (const id of this.knownSearches) this.staleSearches.add(id);
        this.knownPids.clear(); this.knownSearches.clear();
    }
    async callClientTool(name: string, args: any, metadata: any = {}): Promise<any> {
        if (!this.ready) throw new ProfileError('BACKEND_UNAVAILABLE', 'Backend unavailable; request was not sent', true);
        if (args?.pid !== undefined && this.stalePids.has(Number(args.pid)))
            throw new ProfileError('SESSION_CONTEXT_LOST', 'PID belonged to an earlier backend connection');
        if (args?.sessionId && this.staleSearches.has(args.sessionId))
            throw new ProfileError('SESSION_CONTEXT_LOST', 'Search belonged to an earlier backend connection');
        if (args?.pid !== undefined) this.knownPids.add(Number(args.pid));
        if (args?.sessionId) this.knownSearches.add(args.sessionId);
        const c = this.connection!;
        try {
            const result = await this.request(c, signal => c.client.callTool({ name, arguments: args, _meta: { ...metadata, remote: true } }, undefined, { signal }));
            if (this.connection !== c || c.closed) throw new Error('Backend connection changed during call');
            const output = textOf(result);
            if (name === 'start_process') {
                const pid = output.match(/(?:PID|pid)[:\s]+(\d+)/)?.[1];
                if (pid) this.knownPids.add(Number(pid));
            }
            if (name === 'start_search') {
                const id = output.match(/search_\d+_\d+/)?.[0];
                if (id) this.knownSearches.add(id);
            }
            return result;
        } catch {
            throw new ProfileError('REMOTE_RESULT_UNKNOWN', 'Request may have executed on the node; it was not replayed');
        }
    }
    async shutdown(): Promise<void> {
        this.stopped = true;
        this.verified = false;
        ++this.generation;
        const c = this.connection;
        if (c) await withTimeout(this.closeConnection(c), 3000, 'CLEANUP_UNCONFIRMED');
        await this.initializing?.catch(() => {});
        this.connection = undefined;
    }
}
