import { CallJournal, type CallReport } from './call-journal.js';
import { digest, ProfileError } from './ssh-profile-config.js';
import { withTimeout } from './ssh-backend.js';

export interface ProfileDispatchRuntime {
    deviceId: string;
    binding: string;
    backend: { ready: boolean; ping(): Promise<void>; callClientTool(name: string, args: any, metadata?: any): Promise<any> };
    channel: {
        markCallExecuting(id: string, strict?: boolean): Promise<boolean>;
        updateCallResult(id: string, status: string, result?: any, error?: string | null, strict?: boolean): Promise<void>;
    };
    verifyAuthorization(): Promise<void>;
    onShutdown(): void;
    onFatal(error: unknown): void;
}

export class ProfileDispatcher {
    private active = new Set<string>();
    private idleWaiters: Array<() => void> = [];
    private stopped = false;
    private uploading?: Promise<void>;
    constructor(private readonly runtime: ProfileDispatchRuntime, private readonly journal: CallJournal) {}
    stop(): void { this.stopped = true; }
    async drain(): Promise<void> {
        if (this.active.size) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
        await this.uploading;
    }
    async handle(payload: any): Promise<void> {
        const call = payload?.new;
        if (!call || call.device_id !== this.runtime.deviceId || typeof call.id !== 'string' ||
            !/^[A-Za-z0-9_.:-]{1,160}$/.test(call.id) || typeof call.tool_name !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(call.tool_name) || this.stopped) return;
        if (this.active.has(call.id)) return;
        this.active.add(call.id);
        let reserved = false, shutdownRequested = false;
        try {
            const fingerprint = digest({ binding: this.runtime.binding, name: call.tool_name,
                args: call.tool_args ?? {}, metadata: call.metadata ?? {} });
            const reservation = await this.journal.reserve(this.runtime.deviceId, call.id, fingerprint);
            if (!reservation.fresh) { await this.flushOutbox(); return; }
            reserved = true;
            if (payload.claimed !== true && !await this.runtime.channel.markCallExecuting(call.id, true)) {
                await this.journal.complete(this.runtime.deviceId, call.id,
                    { status: 'failed', result: null, error: 'CALL_NOT_CLAIMED: no operation was dispatched' });
                await this.journal.markDelivered(this.runtime.deviceId, call.id);
                return; // Do not overwrite a call owned by a different process.
            }
            await this.runtime.verifyAuthorization();
            if (this.stopped) throw new ProfileError('BACKEND_UNAVAILABLE', 'Bridge is stopping; operation was not dispatched');
            let result: any;
            if (call.tool_name === 'shutdown') {
                shutdownRequested = true;
                result = { content: [{ type: 'text', text: 'Stopping this SSH device bridge, not either operating system.' }] };
            } else {
                if (!this.runtime.backend.ready) throw new ProfileError('BACKEND_UNAVAILABLE', 'Node is unavailable; operation was not dispatched', true);
                if (call.tool_name === 'ping') {
                    await this.runtime.backend.ping();
                    result = { content: [{ type: 'text', text: `pong ${new Date().toISOString()}` }] };
                } else result = await this.runtime.backend.callClientTool(call.tool_name, call.tool_args ?? {}, call.metadata ?? {});
            }
            await this.journal.complete(this.runtime.deviceId, call.id,
                { status: 'completed', result, error: null });
            await this.flushOutbox();
        } catch (error) {
            if (error instanceof ProfileError && (error.code.startsWith('JOURNAL_') || error.code.startsWith('STATE_'))) {
                this.stopped = true;
                this.runtime.onFatal(error);
            } else if (reserved) {
                const report: CallReport = { status: 'failed', result: null,
                    error: error instanceof ProfileError ? error.message : 'REMOTE_REQUEST_FAILED: no operation will be automatically replayed' };
                try { await this.journal.complete(this.runtime.deviceId, call.id, report); await this.flushOutbox(); }
                catch (journalError) { this.stopped = true; this.runtime.onFatal(journalError); }
            } else {
                console.error('[ssh-device] Call rejected before dispatch');
            }
        } finally {
            this.active.delete(call.id);
            if (!this.active.size) for (const resolve of this.idleWaiters.splice(0)) resolve();
            if (shutdownRequested) { this.stopped = true; this.runtime.onShutdown(); }
        }
    }
    flushOutbox(): Promise<void> {
        if (!this.uploading) this.uploading = this.uploadPending().finally(() => { this.uploading = undefined; });
        return this.uploading;
    }
    private async uploadPending(): Promise<void> {
        for (const record of this.journal.pending(this.runtime.deviceId).slice(0, 25)) {
            const report = record.report!;
            try {
                await withTimeout(this.runtime.channel.updateCallResult(record.id, report.status,
                    report.result ?? null, report.error, true), 6000, 'RESULT_UPLOAD_TIMEOUT');
            } catch {
                console.error('[ssh-device] Result delivery pending; cached result retained, tool not replayed');
                return;
            }
            await this.journal.markDelivered(this.runtime.deviceId, record.id);
        }
    }
}
