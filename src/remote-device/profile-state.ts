import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { ProfileError, profileNameSchema } from './ssh-profile-config.js';

const credentialSchema = z.object({
    schemaVersion: z.literal(1), deviceId: z.string().uuid(),
    bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }).strict(),
}).strict();
export type ProfileCredentials = z.infer<typeof credentialSchema>;
export interface BackendIdentity {
    hostname: string; user: string; platform: string; arch: string;
    serverName: string; serverVersion: string; schemaHash: string;
}

export function profileDirectory(profile: string, home = os.homedir()): string {
    if (!profileNameSchema.safeParse(profile).success) throw new ProfileError('PROFILE_INVALID', 'Invalid profile name');
    return path.join(home, '.desktop-commander-device', 'profiles', profile);
}

export async function readJsonIfPresent(filename: string, maxBytes = 65536): Promise<any | null> {
    try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
            throw new ProfileError('STATE_CORRUPT', `Unsafe state file ${path.basename(filename)}`);
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new ProfileError('STATE_CORRUPT', 'State must contain a JSON object');
        return value;
    } catch (e: any) {
        if (e.code === 'ENOENT') return null;
        if (e instanceof ProfileError) throw e;
        throw new ProfileError(e instanceof SyntaxError ? 'STATE_CORRUPT' : 'STATE_UNREADABLE',
            `Cannot read ${path.basename(filename)} (${e.code ?? e.name})`);
    }
}
/** A same-directory atomic replacement, durable before it is acknowledged. */
export async function atomicJson(filename: string, value: unknown): Promise<void> {
    const temp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
        handle = await fs.open(temp, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value) + '\n');
        await handle.sync();
        await handle.close(); handle = undefined;
        await fs.rename(temp, filename);
        if (process.platform !== 'win32') {
            const dir = await fs.open(path.dirname(filename), 'r');
            try { await dir.sync(); } finally { await dir.close(); }
        }
    } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temp, { force: true }).catch(() => {});
    }
}
export async function privateDirectory(dirname: string): Promise<void> {
    try { await fs.mkdir(dirname, { mode: 0o700 }); }
    catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    const stat = await fs.lstat(dirname);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProfileError('STATE_UNREADABLE', 'State directory must not be a symlink');
    if (process.getuid && stat.uid !== process.getuid()) throw new ProfileError('STATE_UNREADABLE', 'State directory belongs to another user');
    if (process.platform !== 'win32') await fs.chmod(dirname, 0o700);
}

export class ProfileState {
    readonly directory: string;
    private releaseLock?: () => Promise<void>;
    private writes: Promise<void> = Promise.resolve();
    constructor(public readonly profile: string, home = os.homedir()) {
        this.directory = profileDirectory(profile, home);
    }
    async acquire(onCompromised: (error: Error) => void = error => { throw error; }): Promise<void> {
        const root = path.dirname(path.dirname(this.directory));
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProfileError('STATE_UNREADABLE', 'Unsafe state root');
        await privateDirectory(path.dirname(this.directory));
        await privateDirectory(this.directory);
        try {
            this.releaseLock = await lockfile.lock(this.directory, {
                realpath: false, lockfilePath: path.join(this.directory, 'instance.lock'),
                // Cloud authentication can correct Date.now(). Never steal a
                // possibly-live lock based on wall-clock age. Unclean exits
                // require an operator to verify termination before removing it.
                stale: Number.MAX_SAFE_INTEGER, update: 10000, retries: 0, onCompromised,
            });
        } catch (e: any) {
            throw new ProfileError(e.code === 'ELOCKED' ? 'PROFILE_ALREADY_RUNNING' : 'STATE_UNREADABLE',
                'Cannot acquire exclusive profile lock');
        }
    }
    async loadCredentials(): Promise<ProfileCredentials | null> {
        const value = await readJsonIfPresent(path.join(this.directory, 'device.json'));
        if (value === null) return null;
        const parsed = credentialSchema.safeParse(value);
        if (!parsed.success) throw new ProfileError('STATE_CORRUPT', 'Invalid credentials; refusing automatic re-enrollment');
        return parsed.data;
    }
    saveCredentials(value: ProfileCredentials): Promise<void> {
        const snapshot = credentialSchema.parse(value);
        const task = this.writes.catch(() => {}).then(() => atomicJson(path.join(this.directory, 'device.json'), snapshot));
        this.writes = task;
        return task;
    }
    async checkBinding(expected: string, identity?: BackendIdentity, save = false, required = false): Promise<void> {
        const filename = path.join(this.directory, 'binding.json');
        const binding = await readJsonIfPresent(filename);
        if (required && binding === null) throw new ProfileError('STATE_CORRUPT', 'Credentials exist but the target binding is missing');
        if (binding !== null && (binding.schemaVersion !== 1 || typeof binding.digest !== 'string' || !binding.identity))
            throw new ProfileError('STATE_CORRUPT', 'Invalid target binding');
        if (binding && binding.digest !== expected)
            throw new ProfileError('TARGET_BINDING_MISMATCH', 'Target/configuration changed; review and explicitly logout/re-enroll');
        if (binding && identity && ['hostname', 'user', 'platform', 'arch'].some(k => binding.identity[k] !== (identity as any)[k]))
            throw new ProfileError('TARGET_BINDING_MISMATCH', 'Backend identity differs from the enrolled target');
        if (binding && identity && binding.identity.schemaHash !== identity.schemaHash)
            throw new ProfileError('SCHEMA_MISMATCH', 'Backend tool schema changed; explicit review and re-enrollment are required');
        if (save && identity) await atomicJson(filename, { schemaVersion: 1, digest: expected, identity });
    }
    async logout(): Promise<void> {
        await this.flush();
        for (const file of ['device.json', 'binding.json']) await fs.rm(path.join(this.directory, file), { force: true });
        // Keep call tombstones: local logout is not server-side revocation.
    }
    async flush(): Promise<void> { await this.writes; }
    async release(): Promise<void> {
        try { await this.flush(); }
        finally {
            const release = this.releaseLock;
            this.releaseLock = undefined;
            if (release) await release();
        }
    }
}
