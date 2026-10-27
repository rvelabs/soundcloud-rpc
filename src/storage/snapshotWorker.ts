import { parentPort, workerData } from 'node:worker_threads';
import { readFile, open, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const { file, key } = workerData as { file: string; key: Uint8Array };
const secret = Buffer.from(key);
let snapshot: Record<string, unknown> = {};
parentPort!.on('message', async ({ id, values }: { id: number; values?: Record<string, unknown> }) => {
    try {
        if (values === undefined) {
            let restored: Record<string, unknown> = {};
            try {
                const bytes = await readFile(file);
                if (bytes.subarray(0, 4).toString() !== 'SC01') throw new Error('Unsupported data format');
                const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(4, 16));
                decipher.setAuthTag(bytes.subarray(16, 32));
                const decoded = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
                restored = JSON.parse(decoded.toString('utf8'));
                if (!restored || typeof restored !== 'object' || Array.isArray(restored))
                    throw new Error('Invalid data snapshot');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            snapshot = restored;
            parentPort!.postMessage({ id, values: restored });
        } else {
            snapshot = { ...snapshot, ...values };
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', secret, iv);
            const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
            const bytes = Buffer.concat([Buffer.from('SC01'), iv, cipher.getAuthTag(), encrypted]);
            await mkdir(dirname(file), { recursive: true });
            const temporary = file + '.tmp';
            const handle = await open(temporary, 'w', 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, file);
            parentPort!.postMessage({ id });
        }
    } catch (error) {
        parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
});
