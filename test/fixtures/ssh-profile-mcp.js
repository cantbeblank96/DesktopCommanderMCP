// Test-only stdio peer. The -F file is JSON, not an actual OpenSSH config.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const configPath = process.argv[process.argv.indexOf('-F') + 1];
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
await fs.appendFile(path.join(config.root, 'starts'), `${process.pid}\n`);
if (config.mode === 'deny') {
    process.stderr.write('Permission denied (publickey).\n'); process.exit(255);
}
if (config.mode === 'hang-init') {
    process.stdin.resume(); setInterval(() => {}, 1000);
} else {
    if (config.mode === 'stdout-noise') process.stdout.write('unframed startup banner\n');
    const server = new Server({ name: 'ssh-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    const names = ['read_file', 'write_file', 'edit_block', 'start_process', 'read_process_output', 'start_search'];
    server.setRequestHandler(ListToolsRequestSchema, async request => {
        const list = config.mode === 'missing-tools' ? ['read_file'] : names;
        const page = request.params?.cursor ? list.slice(3) : list.slice(0, 3);
        return { tools: page.map(name => ({ name, inputSchema: { type: 'object' } })),
            ...(!request.params?.cursor && list.length > 3 ? { nextCursor: 'second' } : {}) };
    });
    server.setRequestHandler(PingRequestSchema, async () => {
        if (config.mode === 'hang-ping') return new Promise(() => {});
        return {};
    });
    const text = value => ({ content: [{ type: 'text', text: value }] });
    let partialIdentityFrame;
    server.setRequestHandler(CallToolRequestSchema, async request => {
        const name = request.params.name, args = request.params.arguments ?? {};
        if (name === 'start_process' && String(args.command).includes('__RDC_ID_')) {
            const begin = args.command.match(/__RDC_ID_[a-f0-9]+__/)[0];
            const end = args.command.match(/__RDC_END_[a-f0-9]+__/)[0];
            const frame = `${begin}\n${config.mode === 'wrong-host' ? 'other-host' : 'fixture-node'}\nfixture-user\nLinux\nx86_64\n${end}\n`;
            if (config.mode === 'partial-identity') {
                partialIdentityFrame = frame;
                return text(`Process started with PID 990001\nInitial output:\n${begin}\nfixture-node\n`);
            }
            return text(`Process started with PID 990001\nInitial output:\n${frame}`);
        }
        if (name === 'read_process_output' && partialIdentityFrame) {
            return text(`[Reading 6 new lines]\n\n${partialIdentityFrame}`);
        }
        if (name === 'write_file') {
            await fs.appendFile(path.join(config.root, 'writes'), 'write\n');
            await fs.writeFile(path.join(config.root, 'payload'), JSON.stringify(args));
            if (config.mode === 'drop-mid-write') process.exit(17);
            return { ...text('saved-on-fixture'), structuredContent: { args, metadata: request.params._meta } };
        }
        if (name === 'read_file') return text(await fs.readFile(path.join(config.root, 'payload'), 'utf8').catch(() => 'empty'));
        if (name === 'start_process') return text('Process started with PID 990002\nfixture-output');
        if (name === 'start_search') return text('Started content search session: search_1_12345');
        return text('fixture-output');
    });
    await server.connect(new StdioServerTransport());
    process.stdin.on('end', () => { void server.close().finally(() => process.exit(0)); });
}
