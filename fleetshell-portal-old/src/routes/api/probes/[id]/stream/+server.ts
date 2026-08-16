/**
 * GET /api/probes/[id]/stream
 *
 * Server-Sent Events stream.  The browser opens this after receiving the
 * probe ID; when the desktop client POSTs its version data, Redis Pub/Sub
 * delivers it here and we forward it as an SSE "result" event.
 *
 * Fixes applied vs. the first version
 * ─────────────────────────────────────
 * 1. reconnectStrategy:false on the subscriber client — prevents node-redis
 *    from auto-reconnecting after disconnect(), which could trigger a
 *    message-handler loop and cause the OOM crash.
 * 2. request.signal abort listener — detects browser disconnect reliably
 *    when the ReadableStream cancel() is not called by the adapter.
 * 3. `closed` flag guards controller.enqueue/close — prevents
 *    "enqueue on closed controller" errors if cleanup races with send.
 * 4. resultReceived flag — prevents the pub/sub callback from firing
 *    more than once (belt-and-suspenders against duplicate delivery).
 * 5. Comprehensive tracing on every state transition.
 */
import { error }          from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const STREAM_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS      = 15_000;

// ── Simple trace helper ───────────────────────────────────────────────────────
function trace(id: string, msg: string, data?: Record<string, unknown>) {
	const line = data
		? `${new Date().toISOString()} [probe-stream/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [probe-stream/${id}] ${msg}`;
	console.log(line);
}

export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const { id } = params;
	trace(id, 'stream requested', { user: locals.user });

	// Ownership: the logged-in user's association must match the requested ID.
	const redis   = await getRedisClient();
	const ownerId = await redis.get(`association:${locals.user}`);
	if (ownerId !== id) {
		trace(id, 'ownership check FAILED', { ownerId: ownerId ?? 'null' });
		error(403, 'Forbidden');
	}
	trace(id, 'ownership verified');

	const encoder = new TextEncoder();

	// Shared state — guards against races between the abort handler,
	// the subscriber callback, the timeout, and the cancel() hook.
	let subscriber    : ReturnType<typeof redis.duplicate> | null = null;
	let heartbeat     : ReturnType<typeof setInterval>     | null = null;
	let timeout       : ReturnType<typeof setTimeout>      | null = null;
	let closed        = false;   // true once the stream is done
	let resultReceived = false;  // true once a pub/sub message has been processed

	// ── Controller send / close wrappers ─────────────────────────────────────
	// Using a pair of closures so we can set `closed` before calling
	// controller.close(), preventing enqueue-after-close errors.
	let _controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	const send = (event: string, data: unknown) => {
		if (closed || !_controller) {
			trace(id, `send() skipped — stream already closed (event=${event})`);
			return;
		}
		const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		try {
			_controller.enqueue(encoder.encode(line));
			trace(id, `sent event`, { event, data });
		} catch (e) {
			trace(id, `enqueue error (event=${event})`, { err: String(e) });
			closed = true;
		}
	};

	const closeStream = () => {
		if (closed || !_controller) return;
		trace(id, 'closing stream controller');
		closed = true;
		try { _controller.close(); } catch { /* already closed */ }
	};

	// ── Cleanup ───────────────────────────────────────────────────────────────
	const cleanup = async (reason: string) => {
		trace(id, `cleanup called`, { reason, hasHeartbeat: !!heartbeat, hasTimeout: !!timeout, hasSubscriber: !!subscriber });

		if (heartbeat)  { clearInterval(heartbeat);  heartbeat  = null; }
		if (timeout)    { clearTimeout(timeout);     timeout    = null; }

		if (subscriber) {
			const sub = subscriber;
			subscriber = null; // null first to prevent double-cleanup
			try {
				await sub.unsubscribe();
				trace(id, 'redis unsubscribed');
			} catch (e) {
				trace(id, 'unsubscribe error (ignored)', { err: String(e) });
			}
			try {
				sub.disconnect();
				trace(id, 'redis subscriber disconnected');
			} catch (e) {
				trace(id, 'disconnect error (ignored)', { err: String(e) });
			}
		}
	};

	// ── Abort signal — fires when the HTTP connection is closed ───────────────
	// This is more reliable than ReadableStream.cancel() in SvelteKit's adapter.
	request.signal.addEventListener('abort', async () => {
		trace(id, 'abort signal received — client disconnected');
		await cleanup('abort-signal');
		closeStream();
	});

	// ── Stream ────────────────────────────────────────────────────────────────
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			_controller = controller;
			trace(id, 'ReadableStream start()');

			// Fast path: result already in Redis (client responded before SSE opened).
			const existing = await redis.get(`client:${id}:probe`);
			trace(id, 'existing probe slot', { value: existing ?? 'null' });

			if (existing && existing !== 'pending') {
				trace(id, 'fast-path: returning cached result');
				send('result', JSON.parse(existing));
				closeStream();
				return;
			}

			// Subscribe on a dedicated connection with reconnection disabled so
			// that disconnect() truly terminates the connection and never loops.
			trace(id, 'creating subscriber connection');
			subscriber = redis.duplicate({
				socket: {
					reconnectStrategy: false,    // ← key fix: no auto-reconnect loop
				},
			});
			await subscriber.connect();
			trace(id, 'subscriber connected');

			await subscriber.subscribe(`probe:${id}`, async (message) => {
				trace(id, 'pub/sub message received', { message });

				if (resultReceived) {
					trace(id, 'duplicate pub/sub message — ignoring');
					return;
				}
				resultReceived = true;

				let parsed: unknown;
				try   { parsed = JSON.parse(message); }
				catch { parsed = { raw: message }; }

				await cleanup('result-received');
				send('result', parsed);
				closeStream();
			});
			trace(id, 'subscription active');

			// Confirm the stream is live so the browser can trigger the client.
			send('ready', { id });

			// Heartbeat — keeps idle connections alive through proxy timeouts.
			heartbeat = setInterval(() => {
				if (closed) { clearInterval(heartbeat!); heartbeat = null; return; }
				trace(id, 'heartbeat');
				try { controller.enqueue(encoder.encode(': heartbeat\n\n')); }
				catch (e) {
					trace(id, 'heartbeat enqueue error', { err: String(e) });
					clearInterval(heartbeat!); heartbeat = null;
				}
			}, HEARTBEAT_MS);

			// Hard timeout.
			timeout = setTimeout(async () => {
				trace(id, 'stream timeout reached');
				await cleanup('timeout');
				send('timeout', { id });
				closeStream();
			}, STREAM_TIMEOUT_MS);

			trace(id, 'stream ready — waiting for probe result');
		},

		async cancel(reason) {
			trace(id, 'ReadableStream cancel()', { reason: String(reason) });
			await cleanup('stream-cancelled');
		},
	});

	trace(id, 'returning SSE Response');
	return new Response(stream, {
		headers: {
			'Content-Type'      : 'text/event-stream',
			'Cache-Control'     : 'no-cache',
			'Connection'        : 'keep-alive',
			'X-Accel-Buffering' : 'no',
		},
	});
};
