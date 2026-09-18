import { z } from 'zod';
import { RemoteChannel, observeServerDate, type AuthSession } from './remote-channel.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { ProfileState, type ProfileCredentials } from './profile-state.js';
import { SshBackend, withTimeout } from './ssh-backend.js';
import { BackendSupervisor } from './backend-supervisor.js';
import { CallJournal } from './call-journal.js';
import { ProfileDispatcher } from './profile-dispatcher.js';
import { bindingDigest, loadProfile, ProfileError, profileExitCode, type ProfileCli, type ProfileConfig } from './ssh-profile-config.js';

/** Separate orchestrator: legacy local-device state and execution stay untouched. */
export class SshProfileDevice {
    readonly backend: SshBackend;
    readonly channel = new RemoteChannel();
    private supervisor?: BackendSupervisor;
    private journal?: CallJournal;
    private dispatcher?: ProfileDispatcher;
    private abort = new AbortController();
    private binding = '';
    private approvedEpoch?: number;
    private deviceId?: string;
    private stopped = false;
    private fatalError?: unknown;
    private stopping?: Promise<void>;
    private maintenance?: NodeJS.Timeout;
    private maintaining = false;
    private finish!: () => void;
    private finished = new Promise<void>(resolve => { this.finish = resolve; });
    constructor(readonly config: ProfileConfig, readonly state: ProfileState) {
        this.backend = new SshBackend(config);
        void this.channel.setBackendAvailability(false);
        this.channel.onAuthorizationLost(() => this.requestStop(new ProfileError('AUTH_REQUIRED', 'Cloud authorization was lost')));
        this.channel.onSessionRefreshed(session => {
            if (this.deviceId && this.binding) void this.persist(session).catch(error => this.requestStop(error));
        });
    }
    requestStop(error?: unknown): void {
        if (error && !this.fatalError) this.fatalError = error;
        this.finish();
        void this.stop().catch(stopError => { this.fatalError ??= stopError; });
    }
    private assertRunning(): void {
        if (this.stopped) throw this.fatalError ?? new ProfileError('STOP_REQUESTED', 'Bridge was stopped');
    }
    private async persist(session: AuthSession): Promise<void> {
        if (!this.deviceId || !session.refresh_token) throw new ProfileError('AUTH_REQUIRED', 'No persistent device session returned');
        await this.state.saveCredentials({ schemaVersion: 1, deviceId: this.deviceId,
            bindingDigest: this.binding, session: { access_token: session.access_token, refresh_token: session.refresh_token } });
    }
    async run(mode: 'doctor' | 'enroll' | 'serve'): Promise<void> {
        this.binding = await bindingDigest(this.config);
        const saved = await this.state.loadCredentials();
        await this.state.checkBinding(this.binding, undefined, false, !!saved);
        if (saved && saved.bindingDigest !== this.binding)
            throw new ProfileError('TARGET_BINDING_MISMATCH', 'Credentials belong to a different target configuration');
        if (mode === 'serve' && !saved) throw new ProfileError('AUTH_REQUIRED', 'Run this profile with --enroll first');
        const validate = async () => {
            if (await bindingDigest(this.config) !== this.binding)
                throw new ProfileError('TARGET_BINDING_MISMATCH', 'SSH configuration changed while the bridge was running');
            await this.state.checkBinding(this.binding, this.backend.identity);
        };
        if (mode === 'doctor') {
            await this.backend.initialize(); await validate(); this.assertRunning();
            console.log(JSON.stringify({ status: 'BACKEND_VERIFIED', profile: this.config.profile,
                deviceName: this.config.deviceName, backend: this.backend.identity,
                toolCount: this.backend.listClientTools().tools.length,
                cloudEnrollmentTested: false, remoteCleanupCertified: false }, null, 2));
            return;
        }
        this.supervisor = new BackendSupervisor(this.backend, this.config.lifecycle, validate,
            ready => {
                const available = ready && !this.stopped && this.backend.ready;
                this.approvedEpoch = available ? this.backend.epoch : undefined;
                void this.channel.setBackendAvailability(available, this.backend.identity?.platform).catch(() => {});
            },
            error => this.requestStop(error));
        await this.supervisor.start(); this.assertRunning();
        const verifiedTools = this.backend.listClientTools();
        await this.authenticate(saved, mode === 'enroll'); this.assertRunning();
        await this.state.checkBinding(this.binding, this.backend.identity, true);
        const current = await withTimeout(this.channel.getSession(), 15000, 'AUTH_TIMEOUT');
        if (!current.data.session) throw new ProfileError('AUTH_REQUIRED', 'No current cloud session');
        await this.persist(current.data.session);
        if (mode === 'enroll') {
            console.log(`Profile enrolled: ${this.config.profile}; device ${this.deviceId}. Start it without --enroll to serve tools.`);
            return;
        }
        this.journal = new CallJournal(this.state.directory);
        await this.journal.initialize();
        await this.journal.recoverInterrupted();
        this.dispatcher = new ProfileDispatcher({ deviceId: this.deviceId!, binding: this.binding,
            backend: this.createDispatchBackend(), channel: this.channel,
            verifyAuthorization: () => this.verifyAuthorization(),
            onShutdown: () => this.requestStop(), onFatal: error => this.requestStop(error),
        }, this.journal);
        await this.channel.registerDevice(verifiedTools, this.deviceId,
            this.config.deviceName, payload => this.dispatcher!.handle(payload));
        this.assertRunning();
        this.channel.startHeartbeat(this.deviceId!);
        this.maintenance = setInterval(() => { void this.maintain(); }, 30000);
        console.log(`SSH device bridge started: ${this.config.deviceName} (${this.deviceId}).`);
        console.log('Actual availability requires both the cloud channel and the verified node backend.');
        await this.maintain();
        await this.finished;
        if (this.fatalError) throw this.fatalError;
    }
    private createDispatchBackend() {
        const owner = this;
        const assertReady = () => {
            if (owner.stopped || !owner.backend.ready || owner.approvedEpoch !== owner.backend.epoch)
                throw new ProfileError('BACKEND_UNAVAILABLE', 'Backend generation has not passed target/schema validation', true);
        };
        return {
            get ready() { return !owner.stopped && owner.backend.ready && owner.approvedEpoch === owner.backend.epoch; },
            async ping() { assertReady(); await owner.backend.ping(); },
            async callClientTool(name: string, args: any, metadata?: any) {
                assertReady(); return owner.backend.callClientTool(name, args, metadata);
            },
        };
    }
    private async authenticate(saved: ProfileCredentials | null, enroll: boolean): Promise<void> {
        const base = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        const response = await withTimeout(fetch(`${base}/api/mcp-info`, { signal: this.abort.signal }), 15000, 'AUTH_TIMEOUT');
        if (!response.ok) throw new ProfileError('AUTH_SERVICE_UNAVAILABLE', 'Cannot retrieve cloud configuration', true);
        observeServerDate(response.headers.get('date'));
        const info = await withTimeout(response.json(), 5000, 'AUTH_TIMEOUT');
        if (typeof info.supabaseUrl !== 'string' || typeof info.supabasePublishableKey !== 'string')
            throw new ProfileError('AUTH_SERVICE_UNAVAILABLE', 'Invalid cloud configuration');
        this.channel.initialize(info.supabaseUrl, info.supabasePublishableKey);
        this.assertRunning();
        let session: AuthSession;
        if (saved) {
            this.deviceId = saved.deviceId;
            session = saved.session;
        } else {
            if (!enroll) throw new ProfileError('AUTH_REQUIRED', 'Interactive authorization requires --enroll');
            const authenticator = new DeviceAuthenticator(base,
                { deviceName: this.config.deviceName, signal: this.abort.signal });
            session = await authenticator.authenticate();
            if (!z.string().uuid().safeParse(session.device_id).success)
                throw new ProfileError('AUTH_REQUIRED', 'Cloud authorization did not return a valid device ID');
            this.deviceId = session.device_id;
        }
        const result = await withTimeout(this.channel.setSession(session), 20000, 'AUTH_TIMEOUT');
        if (result.error) throw new ProfileError('AUTH_REQUIRED', 'Saved authorization was rejected; explicitly logout/re-enroll this profile');
        await this.verifyAuthorization();
    }
    private async verifyAuthorization(): Promise<void> {
        this.assertRunning();
        if (!this.deviceId) throw new ProfileError('AUTH_REQUIRED', 'Device is not authorized');
        let device;
        try { device = await withTimeout(this.channel.findDevice(this.deviceId), 5000, 'AUTH_CHECK_TIMEOUT'); }
        catch { throw new ProfileError('AUTH_CHECK_FAILED', 'Cloud authorization could not be verified; no tool was dispatched', true); }
        this.assertRunning();
        if (!device) {
            const error = new ProfileError('DEVICE_REVOKED', 'Device was revoked; fresh authorization is required');
            this.requestStop(error); throw error;
        }
    }
    private async maintain(): Promise<void> {
        if (this.maintaining || this.stopped) return;
        this.maintaining = true;
        try { await this.verifyAuthorization(); if (!this.stopped) await this.dispatcher?.flushOutbox(); }
        catch (error) {
            if (error instanceof ProfileError && !error.retryable) this.requestStop(error);
            else console.error('[ssh-device] Cloud check/delivery temporarily unavailable');
        } finally { this.maintaining = false; }
    }
    stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.stopped = true;
        this.abort.abort();
        this.dispatcher?.stop();
        if (this.maintenance) clearInterval(this.maintenance);
        this.channel.stopHeartbeat();
        this.finish();
        this.stopping = (async () => {
            const results = await Promise.allSettled([
                this.supervisor ? this.supervisor.stop() : this.backend.shutdown(),
                this.channel.closeProfileConnection(this.deviceId),
            ]);
            await this.dispatcher?.drain();
            await this.journal?.flush();
            await this.state.flush();
            if (results.some(r => r.status === 'rejected'))
                throw new ProfileError('CLEANUP_UNCONFIRMED', 'Some bridge resources did not confirm shutdown');
        })();
        return this.stopping;
    }
}

export async function runSshProfile(cli: ProfileCli): Promise<void> {
    const state = new ProfileState(cli.profile!);
    if (cli.logout) {
        await state.acquire();
        try { await state.logout(); console.log(`Local credentials removed for profile ${cli.profile}; cloud revocation is separate.`); }
        finally { await state.release(); }
        return;
    }
    const config = await loadProfile(cli.config!, cli.profile!);
    const device = new SshProfileDevice(config, state);
    await state.acquire(error => device.requestStop(new ProfileError('PROFILE_LOCK_LOST', error.message)));
    let stopTimer: NodeJS.Timeout | undefined;
    const armDeadline = () => {
        if (!stopTimer) stopTimer = setTimeout(() => {
            console.error('CLEANUP_UNCONFIRMED: shutdown deadline exceeded; remote process cleanup is not certified');
            process.exit(1);
        }, config.lifecycle.shutdownGraceMs);
    };
    const stop = () => { armDeadline(); device.requestStop(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
        await device.run(cli.doctor ? 'doctor' : cli.enroll ? 'enroll' : 'serve');
    } catch (error) {
        if (!(error instanceof ProfileError && error.code === 'STOP_REQUESTED')) throw error;
    } finally {
        armDeadline();
        try { await device.stop(); await state.release(); }
        catch (error) {
            console.error(error instanceof Error ? error.message : 'Profile cleanup failed');
            process.exit(profileExitCode(error));
        } finally {
            if (stopTimer) clearTimeout(stopTimer);
            process.off('SIGINT', stop); process.off('SIGTERM', stop);
        }
    }
}
