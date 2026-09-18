import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureChromeAvailable } from '../dist/tools/pdf/markdown.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

test('headless startup opt-out skips Chrome resolution without changing its default', async () => {
    const original = process.env.DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT;
    try {
        for (const value of ['1', 'true', ' TRUE ', 'yes', 'on']) {
            process.env.DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT = value;
            let calls = 0;
            ensureChromeAvailable(async () => { calls++; return undefined; });
            await Promise.resolve();
            assert.equal(calls, 0, `unexpected browser preflight for ${value}`);
        }
        for (const value of ['', 'false', '0', 'off']) {
            process.env.DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT = value;
            let calls = 0;
            ensureChromeAvailable(async () => { calls++; return undefined; });
            assert.equal(calls, 1, `default preflight lost for ${value}`);
        }
    } finally {
        if (original === undefined) delete process.env.DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT;
        else process.env.DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT = original;
    }
});
