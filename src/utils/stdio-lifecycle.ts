import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';

interface StdioExitOptions {
    enabled: boolean;
    close: () => Promise<void>;
    input?: Readable;
    signals?: EventEmitter;
    exit?: (code: number) => void;
    graceMs?: number;
}

/** Opt-in EOF ownership for SSH-managed backends, not a process-tree reaper. */
export function installStdioExitHandler(options: StdioExitOptions): () => void {
    if (!options.enabled) return () => {};
    const input = options.input ?? process.stdin;
    const signals = options.signals ?? process;
    const exit = options.exit ?? ((code: number) => process.exit(code));
    let stopping = false;
    let finished = false;
    let deadline: NodeJS.Timeout | undefined;
    const detach = () => {
        input.off('end', stop);
        input.off('close', stop);
        signals.off('SIGTERM', stop);
        signals.off('SIGHUP', stop);
    };
    const finish = (code: number) => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        exit(code);
    };
    const stop = () => {
        if (stopping) return;
        stopping = true;
        detach();
        deadline = setTimeout(() => finish(1), options.graceMs ?? 2000);
        void Promise.resolve().then(options.close).then(() => finish(0), () => finish(1));
    };
    input.once('end', stop);
    input.once('close', stop);
    signals.once('SIGTERM', stop);
    signals.once('SIGHUP', stop);
    if (input.readableEnded || input.destroyed) queueMicrotask(stop);
    return () => {
        detach();
        if (deadline) clearTimeout(deadline);
    };
}
