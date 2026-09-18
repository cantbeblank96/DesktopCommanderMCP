import { ProfileError, type ProfileConfig } from './ssh-profile-config.js';
import type { SshBackend } from './ssh-backend.js';

/** One reconnect/health loop; it never replays a tool request. */
export class BackendSupervisor {
    private stopped = false;
    private task?: Promise<void>;
    private wakeWait?: () => void;
    private firstReady?: { resolve: () => void; reject: (error: unknown) => void };
    constructor(
        private readonly backend: Pick<SshBackend, 'ready' | 'initialize' | 'ping' | 'invalidate' | 'shutdown' | 'onDisconnect'>,
        private readonly lifecycle: ProfileConfig['lifecycle'],
        private readonly validateReady: () => Promise<void>,
        private readonly onState: (ready: boolean) => void,
        private readonly onFatal: (error: unknown) => void,
    ) {
        backend.onDisconnect(() => {
            this.onState(false);
            this.wakeWait?.();
        });
    }
    start(): Promise<void> {
        if (this.task) throw new ProfileError('BACKEND_INIT_FAILED', 'Supervisor already started');
        const ready = new Promise<void>((resolve, reject) => { this.firstReady = { resolve, reject }; });
        this.task = this.loop();
        return ready;
    }
    private wait(ms: number): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                if (this.wakeWait === finish) this.wakeWait = undefined;
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.wakeWait = finish;
        });
    }
    private async loop(): Promise<void> {
        let attempts = 0, failures = 0;
        try {
            while (!this.stopped) {
                if (!this.backend.ready) {
                    this.onState(false);
                    try {
                        await this.backend.initialize();
                        if (this.stopped) break;
                        await this.validateReady();
                        if (this.stopped || !this.backend.ready) continue;
                        attempts = 0; failures = 0;
                        this.onState(true);
                        this.firstReady?.resolve(); this.firstReady = undefined;
                    } catch (error) {
                        if (this.stopped) break;
                        if (!(error instanceof ProfileError) || !error.retryable) throw error;
                        const cap = Math.min(this.lifecycle.reconnectMaxDelayMs, 1000 * 2 ** Math.min(attempts++, 8));
                        console.error(`[ssh-backend] ${error.code}; retrying connection`);
                        await this.wait(Math.max(50, Math.floor(cap * (0.75 + Math.random() * 0.25))));
                        continue;
                    }
                }
                await this.wait(this.lifecycle.healthIntervalMs);
                if (this.stopped || !this.backend.ready) continue;
                try { await this.backend.ping(); failures = 0; }
                catch {
                    if (++failures >= this.lifecycle.healthFailureThreshold) {
                        this.onState(false);
                        await this.backend.invalidate('Backend health check failed');
                    }
                }
            }
        } catch (error) {
            this.onState(false);
            this.firstReady?.reject(error); this.firstReady = undefined;
            if (!this.stopped) this.onFatal(error);
        } finally {
            this.firstReady?.reject(new ProfileError('BACKEND_UNAVAILABLE', 'Supervisor stopped'));
            this.firstReady = undefined;
        }
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.onState(false);
        this.wakeWait?.();
        await this.backend.shutdown();
        await this.task;
    }
}
