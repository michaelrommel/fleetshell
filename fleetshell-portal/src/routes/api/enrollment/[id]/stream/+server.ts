/**
 * GET /api/enrollment/[id]/stream
 *
 * Server-Sent Events stream for the enrollment flow.
 * The browser opens this after the probe result is received; it stays open
 * until the client confirms certificate receipt or the stream times out.
 *
 * Events emitted (in order):
 *   ready              — subscription is live, browser may proceed
 *   csr-received       — client POSTed a CSR to /api/cert/request
 *   cert-ready         — placeholder cert stored, client may fetch it
 *   enrollment-confirmed — client confirmed cert receipt; stream closes
 *   timeout            — server-side hard limit reached
 *
 * Fast-path replay:
 *   If the browser reconnects after missing an event (e.g. tab hidden),
 *   the current Redis state is read after the subscription is live and
 *   any already-passed events are replayed exactly once.
 *
 * Design mirrors /api/probes/[id]/stream — same reconnectStrategy:false,
 * same abort-signal guard, same closed/resultReceived flags.
 */
import { error }          from '@sveltejs/kit';
import { getRedisClient } from '$lib/server/redis';
import type { RequestHandler } from './$types';

// ── Constants ─────────────────────────────────────────────────────────────────

const STREAM_TIMEOUT_MS = 5 * 60_000;   // 5 minutes hard limit
const HEARTBEAT_MS      =    15_000;    // 15-second keepalive comment

// ── Trace helper ──────────────────────────────────────────────────────────────

function trace(id: string, msg: string, data?: Record<string, unknown>): void {
	const line = data
		? `${new Date().toISOString()} [enrollment-stream/${id}] ${msg} ${JSON.stringify(data)}`
		: `${new Date().toISOString()} [enrollment-stream/${id}] ${msg}`;
	console.log(line);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ params, locals, request }) => {

	// ── Auth ──────────────────────────────────────────────────────────────────
	if (!locals.user) error(401, 'Unauthorized');

	const { id } = params;
	trace(id, 'stream requested', { user: locals.user });

	// ── Ownership check ───────────────────────────────────────────────────────
	// The logged-in user's stable association must match the requested ID so
	// users cannot eavesdrop on each other's enrollment streams.
	const redis   = await getRedisClient();
	const ownerId = await redis.get(`association:${locals.user}`);
	if (ownerId !== id) {
		trace(id, 'ownership check FAILED', { ownerId: ownerId ?? 'null' });
		error(403, 'Forbidden');
	}
	trace(id, 'ownership verified');

	const encoder = new TextEncoder();

	// ── Shared state — guards against cleanup races ───────────────────────────
	let subscriber   : ReturnType<typeof redis.duplicate> | null = null;
	let heartbeat    : ReturnType<typeof setInterval>     | null = null;
	let timeout      : ReturnType<typeof setTimeout>      | null = null;
	let closed       = false;   // true once the stream is permanently done
	let _controller  : ReadableStreamDefaultController<Uint8Array> | null = null;

	// Track which events we have already sent to avoid duplicates when the
	// fast-path replay races with a live pub/sub delivery.
	const sentEvents = new Set<string>();

	// ── SSE helpers ───────────────────────────────────────────────────────────

	const send = (event: string, data: unknown): void => {
		if (closed || !_controller) {
			trace(id, `send() skipped — stream closed (event=${event})`);
			return;
		}
		const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		try {
			_controller.enqueue(encoder.encode(line));
			trace(id, 'sent event', { event, data });
		} catch (e) {
			trace(id, `enqueue error (event=${event})`, { err: String(e) });
			closed = true;
		}
	};

	/** Send each event at most once — prevents fast-path / pub-sub duplicates. */
	const sendOnce = (event: string, data: unknown): void => {
		if (sentEvents.has(event)) {
			trace(id, `sendOnce() skipped — already sent (event=${event})`);
			return;
		}
		sentEvents.add(event);
		send(event, data);
	};

	const closeStream = (): void => {
		if (closed || !_controller) return;
		trace(id, 'closing stream controller');
		closed = true;
		try { _controller.close(); } catch { /* already closed */ }
	};

	// ── Cleanup ───────────────────────────────────────────────────────────────

	const cleanup = async (reason: string): Promise<void> => {
		trace(id, 'cleanup called', {
			reason,
			hasHeartbeat  : !!heartbeat,
			hasTimeout    : !!timeout,
			hasSubscriber : !!subscriber,
		});

		if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
		if (timeout)   { clearTimeout(timeout);    timeout   = null; }

		if (subscriber) {
			const sub = subscriber;
			subscriber = null;
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

	// ── Abort signal — fires on HTTP connection close ─────────────────────────

	request.signal.addEventListener('abort', async () => {
		trace(id, 'abort signal received — browser disconnected');
		await cleanup('abort-signal');
		closeStream();
	});

	// ── ReadableStream ────────────────────────────────────────────────────────

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			_controller = controller;
			trace(id, 'ReadableStream start()');

			// ── Subscribe FIRST, then read current state for fast-path replay ──
			// Subscribing before reading avoids a TOCTOU gap where an event is
			// published between the Redis GET and the subscribe call.
			trace(id, 'creating subscriber connection');
			subscriber = redis.duplicate({
				socket: { reconnectStrategy: false },
			});
			await subscriber.connect();
			trace(id, 'subscriber connected');

			await subscriber.subscribe(`enrollment:${id}`, async (message) => {
				trace(id, 'pub/sub message received', { message });

				let parsed: { event: string; [key: string]: unknown };
				try {
					parsed = JSON.parse(message) as typeof parsed;
				} catch {
					trace(id, 'JSON parse error, ignoring message', { message });
					return;
				}

				sendOnce(parsed.event, parsed);

				if (parsed.event === 'enrollment-confirmed') {
					await cleanup('enrollment-confirmed');
					closeStream();
				}
			});
			trace(id, 'subscription active on channel', { channel: `enrollment:${id}` });

			// ── Fast-path replay from current Redis state ──────────────────────
			// Read cert status and confirmed flag to catch up with events that
			// fired before this SSE connection was opened.
			const [certStatus, confirmed] = await Promise.all([
				redis.get(`client:${id}:cert`),
				redis.get(`client:${id}:enrollment:confirmed`),
			]);
			trace(id, 'current Redis state', {
				certStatus  : certStatus   ?? 'null',
				confirmed   : confirmed    ?? 'null',
			});

			if (confirmed === '1') {
				trace(id, 'fast-path: already enrolled — replaying full sequence');
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received',        { event: 'csr-received', csr: csr ?? '' });
				sendOnce('cert-ready',          { event: 'cert-ready' });
				sendOnce('enrollment-confirmed', { event: 'enrollment-confirmed' });
				await cleanup('fast-path-enrolled');
				closeStream();
				return;
			}

			if (certStatus === 'ready') {
				trace(id, 'fast-path: cert already ready');
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received', { event: 'csr-received', csr: csr ?? '' });
				sendOnce('cert-ready',   { event: 'cert-ready' });
			} else if (certStatus === 'pending') {
				trace(id, 'fast-path: CSR already received, cert pending');
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received', { event: 'csr-received', csr: csr ?? '' });
			}

			// ── Signal browser that the stream is ready ────────────────────────
			send('ready', { id });

			// ── Heartbeat — keeps the connection alive through proxy timeouts ──
			heartbeat = setInterval(() => {
				if (closed) { clearInterval(heartbeat!); heartbeat = null; return; }
				trace(id, 'heartbeat');
				try { controller.enqueue(encoder.encode(': heartbeat\n\n')); }
				catch (e) {
					trace(id, 'heartbeat enqueue error', { err: String(e) });
					clearInterval(heartbeat!);
					heartbeat = null;
				}
			}, HEARTBEAT_MS);

			// ── Hard timeout ───────────────────────────────────────────────────
			timeout = setTimeout(async () => {
				trace(id, 'stream timeout reached');
				await cleanup('timeout');
				send('timeout', { id });
				closeStream();
			}, STREAM_TIMEOUT_MS);

			trace(id, 'stream ready — waiting for enrollment events');
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
