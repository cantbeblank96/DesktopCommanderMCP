import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicJson, privateDirectory, readJsonIfPresent } from './profile-state.js';
import { digest, ProfileError } from './ssh-profile-config.js';

const reportSchema = z.object({
    status: z.enum(['completed', 'failed']), result: z.unknown().optional(), error: z.string().nullable(),
}).strict();
const recordSchema = z.object({
    schemaVersion: z.literal(1), id: z.string().min(1).max(160), deviceId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['intent', 'result', 'delivered']), updatedAt: z.string(),
    report: reportSchema.optional(),
}).strict().refine(v => (v.state === 'result') === !!v.report, 'Invalid report state');
export type CallReport = z.infer<typeof reportSchema>;
export type CallRecord = z.infer<typeof recordSchema>;

/** Permanent bounded tombstones; only unacknowledged results retain tool output. */
export class CallJournal {
    private records = new Map<string, CallRecord>();
    private bytes = new Map<string, number>();
    private queue: Promise<unknown> = Promise.resolve();
    private failed = false;
    private initialized = false;
    readonly directory: string;
    constructor(stateDirectory: string, private readonly maxEntries = 10000,
                private readonly maxBytes = 64 * 1024 * 1024, private readonly maxResultBytes = 8 * 1024 * 1024) {
        this.directory = path.join(stateDirectory, 'calls');
    }
    private key(deviceId: string, id: string): string { return digest({ deviceId, id }); }
    async initialize(): Promise<void> {
        await privateDirectory(this.directory);
        const files = await fs.readdir(this.directory);
        for (const file of files) {
            if (file.endsWith('.tmp')) continue; // Uncommitted atomic writes are not dispatch records.
            if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new ProfileError('JOURNAL_CORRUPT', 'Unexpected journal entry');
            const value = await readJsonIfPresent(path.join(this.directory, file), this.maxResultBytes + 65536);
            const parsed = recordSchema.safeParse(value);
            if (!parsed.success || this.key(parsed.data.deviceId, parsed.data.id) + '.json' !== file)
                throw new ProfileError('JOURNAL_CORRUPT', 'Invalid call record');
            this.records.set(file.slice(0, -5), parsed.data);
            this.bytes.set(file.slice(0, -5), Buffer.byteLength(JSON.stringify(value)) + 1);
        }
        if (this.records.size > this.maxEntries || this.totalBytes() > this.maxBytes)
            throw new ProfileError('JOURNAL_FULL', 'Journal capacity exceeded; review retained history');
        this.initialized = true;
    }
    private totalBytes(): number { return [...this.bytes.values()].reduce((a,b) => a+b, 0); }
    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.catch(() => {}).then(async () => {
            if (!this.initialized || this.failed) throw new ProfileError('JOURNAL_UNAVAILABLE', 'Journal is unavailable');
            return operation();
        });
        this.queue = next;
        return next;
    }
    private async save(key: string, record: CallRecord): Promise<void> {
        const value = recordSchema.parse(record);
        const size = Buffer.byteLength(JSON.stringify(value)) + 1;
        if (this.totalBytes() - (this.bytes.get(key) ?? 0) + size > this.maxBytes)
            throw new ProfileError('JOURNAL_FULL', 'Result journal capacity exceeded; execution will not be repeated');
        try { await atomicJson(path.join(this.directory, key + '.json'), value); }
        catch { this.failed = true; throw new ProfileError('JOURNAL_WRITE_FAILED', 'Cannot persist call state; refusing further execution'); }
        this.records.set(key, value); this.bytes.set(key, size);
    }
    reserve(deviceId: string, id: string, fingerprint: string): Promise<{ fresh: boolean; record: CallRecord }> {
        return this.serial(async () => {
            const key = this.key(deviceId, id), previous = this.records.get(key);
            if (previous) {
                if (previous.fingerprint !== fingerprint) throw new ProfileError('CALL_ID_CONFLICT', 'Call ID was reused with different arguments');
                return { fresh: false, record: previous };
            }
            if (this.records.size >= this.maxEntries) throw new ProfileError('JOURNAL_FULL', 'Call history limit reached; no history is silently evicted');
            const record: CallRecord = { schemaVersion: 1, id, deviceId, fingerprint,
                state: 'intent', updatedAt: new Date().toISOString() };
            await this.save(key, record);
            return { fresh: true, record };
        });
    }
    complete(deviceId: string, id: string, report: CallReport): Promise<void> {
        return this.serial(async () => {
            const key = this.key(deviceId, id), previous = this.records.get(key);
            if (!previous) throw new ProfileError('JOURNAL_CORRUPT', 'Missing dispatch intent');
            if (previous.state !== 'intent') return;
            if (Buffer.byteLength(JSON.stringify(report)) > this.maxResultBytes) {
                report = { status: 'failed', result: null,
                    error: 'RESULT_CACHE_LIMIT: execution finished but the result exceeds the durable cache limit; use smaller pages. The operation was not replayed.' };
            }
            await this.save(key, { ...previous, state: 'result', report, updatedAt: new Date().toISOString() });
        });
    }
    markDelivered(deviceId: string, id: string): Promise<void> {
        return this.serial(async () => {
            const key = this.key(deviceId, id), previous = this.records.get(key);
            if (!previous || previous.state !== 'result') return;
            const { report: _discardOutput, ...tombstone } = previous;
            await this.save(key, { ...tombstone, state: 'delivered', updatedAt: new Date().toISOString() });
        });
    }
    async recoverInterrupted(): Promise<void> {
        for (const record of [...this.records.values()]) {
            if (record.state === 'intent') await this.complete(record.deviceId, record.id, {
                status: 'failed', result: null,
                error: 'REMOTE_RESULT_UNKNOWN: the previous bridge stopped after recording dispatch intent. The operation was not replayed.',
            });
        }
    }
    pending(deviceId: string): CallRecord[] {
        return [...this.records.values()].filter(r => r.deviceId === deviceId && r.state === 'result');
    }
    async flush(): Promise<void> { await this.queue; }
}
