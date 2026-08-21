/**
 * GET /services/infoproxy/spool
 *
 * SSE stream that runs the Info Proxy Valkey spool and emits progress. The spool
 * streams the master data tier by tier (server-side cursors, one key written at
 * a time -- see src/lib/server/infoproxy.ts), so it is safe on a memory-capped
 * container and can report `done / total` as it goes.
 *
 * Events:
 *   progress  { phase, done, total, key? }   one per key written / prune chunk
 *   done      { written, removed, byType }    final result
 *   error     { message }                     spool failed
 *
 * The browser MUST close the EventSource on `done`/`error`; otherwise it will
 * auto-reconnect and re-run the whole spool.
 */
import { error } from '@sveltejs/kit';
import { getPersona } from '$lib/server/identity';
import { syncToValkey, type SpoolProgress } from '$lib/server/infoproxy';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.userId) error(401, 'Unauthorized');
	const persona = await getPersona(locals.userId);
	if (!persona?.is_admin) error(403, 'forbidden');

	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;

	const send = (event: string, data: unknown) => {
		if (closed || !controller) return;
		try {
			controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		} catch {
			closed = true;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(c) {
			controller = c;
			try {
				const result = await syncToValkey((p: SpoolProgress) => send('progress', p));
				send('done', result);
			} catch (e) {
				send('error', { message: (e as Error).message });
			} finally {
				closed = true;
				try {
					c.close();
				} catch {
					/* already closed */
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
};
