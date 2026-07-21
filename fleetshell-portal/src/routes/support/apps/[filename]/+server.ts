/**
 * Generic download endpoint for support assets.
 *
 * URL pattern:  GET /support/apps/<logical-name>
 *               e.g. /support/apps/fleetshell-client.exe
 *
 * Each logical name maps to an environment variable that holds the
 * **absolute path** (or a path relative to cwd) of the actual file on disk.
 * To ship a new binary version, update the env var and restart the server —
 * no code change or rebuild required.
 *
 * Environment variables
 * ─────────────────────
 * DOWNLOAD_FLEETSHELL_CLIENT   path to the FleetShell Client installer
 * DOWNLOAD_VNC_VIEWER          path to the VNC Viewer installer
 * DOWNLOAD_TEAMVIEWER_CLIENT   path to the TeamViewer Client installer
 * DOWNLOAD_SSH_TERMINAL        path to the SSH Terminal installer
 */
import { env }              from '$env/dynamic/private';
import { error }            from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat }             from 'node:fs/promises';
import { Readable }         from 'node:stream';
import type { RequestHandler } from './$types';

/** Logical download name → env-var key that holds the on-disk path. */
const FILE_MAP: Record<string, keyof typeof env> = {
	'fleetshell-client.exe' : 'DOWNLOAD_FLEETSHELL_CLIENT',
	'vnc-viewer.exe'        : 'DOWNLOAD_VNC_VIEWER',
	'teamviewer-client.exe' : 'DOWNLOAD_TEAMVIEWER_CLIENT',
	'ssh-terminal.exe'      : 'DOWNLOAD_SSH_TERMINAL',
} as const;

export const GET: RequestHandler = async ({ params }) => {
	const logicalName = params.filename;
	const envKey      = FILE_MAP[logicalName];

	// Unknown logical name — not in the map at all.
	if (!envKey) error(404, `No download registered for "${logicalName}"`);

	const diskPath = (env[envKey] ?? '').trim();

	// Env var exists in the map but has not been configured yet.
	if (!diskPath) {
		error(503, `Download not yet available (set the ${envKey} environment variable)`);
	}

	// Verify the file exists and get its size for Content-Length.
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(diskPath);
	} catch {
		error(404, `File not found on server: ${diskPath}`);
	}

	// Stream the file — important for large installers.
	const nodeStream = createReadStream(diskPath);
	const webStream  = Readable.toWeb(nodeStream) as ReadableStream;

	return new Response(webStream, {
		headers: {
			'Content-Type'              : 'application/octet-stream',
			// Use the *logical* name as the download filename so the browser
			// always saves it as e.g. "fleetshell-client.exe" regardless of
			// what the file is actually called on disk.
			'Content-Disposition'       : `attachment; filename="${logicalName}"`,
			'Content-Length'            : String(fileStat.size),
			// Prevent caches from serving stale binaries after an update.
			'Cache-Control'             : 'no-store',
		},
	});
};
