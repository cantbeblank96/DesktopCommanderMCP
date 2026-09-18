import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export class ProfileError extends Error {
    constructor(public readonly code: string, message: string,
                public readonly retryable = false) {
        super(`${code}: ${message}`);
        this.name = 'ProfileError';
    }
}

const safeText = z.string().min(1).max(4096)
    .refine(v => !/[\x00-\x1f\x7f]/.test(v), 'Control characters are forbidden');
const localPath = safeText.refine(v => path.isAbsolute(v), 'An absolute local path is required');
export const profileNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const sshBackendSchema = z.object({
    type: z.literal('ssh'),
    sshExecutable: localPath,
    sshConfigFile: localPath,
    hostAlias: z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    remoteLauncher: safeText.refine(v => v.startsWith('/'), 'An absolute POSIX launcher path is required'),
}).strict();

export const profileConfigSchema = z.object({
    schemaVersion: z.literal(1),
    profile: profileNameSchema,
    deviceName: safeText.refine(v => v.trim().length > 0).pipe(z.string().max(128)),
    backend: sshBackendSchema,
    verification: z.object({
        expectedHostname: safeText.pipe(z.string().max(255)),
        expectedUser: safeText.pipe(z.string().max(255)),
    }).strict(),
    lifecycle: z.object({
        initializeTimeoutMs: z.number().int().min(100).max(120000).default(20000),
        healthIntervalMs: z.number().int().min(100).max(300000).default(30000),
        healthTimeoutMs: z.number().int().min(50).max(60000).default(5000),
        healthFailureThreshold: z.number().int().min(1).max(10).default(3),
        reconnectMaxDelayMs: z.number().int().min(100).max(300000).default(30000),
        shutdownGraceMs: z.number().int().min(3000).max(60000).default(8000),
    }).strict().default({}),
}).strict();
export type ProfileConfig = z.infer<typeof profileConfigSchema>;
export type SshBackendConfig = z.infer<typeof sshBackendSchema>;

export function parseProfile(value: unknown, expectedName?: string): ProfileConfig {
    const parsed = profileConfigSchema.safeParse(value);
    if (!parsed.success) throw new ProfileError('PROFILE_INVALID', parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (expectedName !== undefined && parsed.data.profile !== expectedName)
        throw new ProfileError('PROFILE_INVALID', 'CLI profile does not match configuration');
    return parsed.data;
}

export async function loadProfile(filename: string, expectedName: string): Promise<ProfileConfig> {
    try {
        const data = await fs.readFile(filename, 'utf8');
        if (Buffer.byteLength(data) > 65536) throw new ProfileError('PROFILE_INVALID', 'Configuration exceeds 64 KiB');
        return parseProfile(JSON.parse(data), expectedName);
    } catch (error: any) {
        if (error instanceof ProfileError) throw error;
        throw new ProfileError('PROFILE_INVALID', `Cannot read/parse configuration (${error.code ?? error.name})`);
    }
}

export function canonicalJson(value: any): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
        .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
export function digest(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export async function bindingDigest(config: ProfileConfig): Promise<string> {
    let sshConfig: Buffer;
    try { sshConfig = await fs.readFile(config.backend.sshConfigFile); }
    catch (e: any) { throw new ProfileError('PROFILE_INVALID', `Cannot read SSH configuration (${e.code})`); }
    return digest({ profile: config.profile, backend: config.backend, verification: config.verification,
        sshConfigSha256: createHash('sha256').update(sshConfig).digest('hex') });
}

export interface ProfileCli {
    profile?: string; config?: string; doctor: boolean; enroll: boolean;
    logout: boolean; nonInteractive: boolean; help: boolean;
}
/** Parse before selecting legacy mode: typos must not silently run local tools. */
export function parseRemoteArguments(args: string[]): ProfileCli {
    const result: ProfileCli = { doctor: false, enroll: false, logout: false, nonInteractive: false, help: false };
    const bools: Record<string, keyof ProfileCli | null> = {
        '--doctor': 'doctor', '--enroll': 'enroll', '--logout': 'logout',
        '--non-interactive': 'nonInteractive', '--help': 'help', '-h': 'help',
        '--debug': null, '--disable-no-sleep': null, '--persist-session': null, '--no-persist-session': null,
    };
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const [key, ...suffix] = args[i].split('=');
        if (seen.has(key)) throw new ProfileError('PROFILE_INVALID', `Duplicate option ${key}`);
        seen.add(key);
        if (key === '--profile' || key === '--config') {
            const value = suffix.length ? suffix.join('=') : args[++i];
            if (!value || value.startsWith('-')) throw new ProfileError('PROFILE_INVALID', `${key} requires a value`);
            result[key === '--profile' ? 'profile' : 'config'] = value;
        } else if (Object.prototype.hasOwnProperty.call(bools, key) && !suffix.length) {
            const target = bools[key];
            if (target) (result as any)[target] = true;
        } else throw new ProfileError('PROFILE_INVALID', `Unknown remote option ${key}`);
    }
    if (result.help) return result;
    if (result.profile && !profileNameSchema.safeParse(result.profile).success)
        throw new ProfileError('PROFILE_INVALID', 'Invalid profile name');
    if (!result.profile && (result.config || result.doctor || result.enroll || result.nonInteractive))
        throw new ProfileError('PROFILE_INVALID', 'SSH options require --profile');
    if (result.profile && !result.logout && !result.config)
        throw new ProfileError('PROFILE_INVALID', '--profile requires --config');
    if ([result.doctor, result.enroll, result.logout].filter(Boolean).length > 1 || (result.enroll && result.nonInteractive))
        throw new ProfileError('PROFILE_INVALID', 'Conflicting profile actions');
    if (result.profile && args.includes('--no-persist-session'))
        throw new ProfileError('PROFILE_INVALID', 'SSH profiles require independent persisted identity');
    return result;
}

export function profileExitCode(error: unknown): number {
    if (!(error instanceof ProfileError)) return 1;
    if (error.code === 'PROFILE_INVALID') return 64;
    if (error.code.startsWith('STATE_') || error.code.startsWith('JOURNAL_')) return 65;
    if (['AUTH_REQUIRED', 'DEVICE_REVOKED'].includes(error.code)) return 77;
    return error.retryable ? 1 : 78;
}
