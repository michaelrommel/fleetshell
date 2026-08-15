/**
 * GET /support/apps/<logical-name>  (base-relative: /dev/support/apps/...)
 *
 * Streams a support installer whose on-disk path comes from an env var, so a
 * new binary version is shipped by updating the env var + restarting -- no code
 * change. Lives outside the (app) group, so it is not session-guarded (the
 * desktop client and unauthenticated download links can reach it).
 *
 * Env vars (absolute path, or relative to cwd):
 *   DOWNLOAD_FLEETSHELL_CLIENT, DOWNLOAD_VNC_VIEWER,
 *   DOWNLOAD_TEAMVIEWER_CLIENT, DOWNLOAD_SSH_TERMINAL
 */
import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';

const FILE_MAP: Record<string, keyof typeof env> = {
	'fleetshell-client.exe': 'DOWNLOAD_FLEETSHELL_CLIENT',
	'vnc-viewer.exe': 'DOWNLOAD_VNC_VIEWER',
	'teamviewer-client.exe': 'DOWNLOAD_TEAMVIEWER_CLIENT',
	'ssh-terminal.exe': 'DOWNLOAD_SSH_TERMINAL',
} as const;

export const GET: RequestHandler = async ({ params }) => {
	const logicalName = params.filename;
	const envKey = FILE_MAP[logicalName];
	if (!envKey) error(404, `No download registered for "${logicalName}"`);

	const diskPath = (env[envKey] ?? '').trim();
	if (!diskPath) error(503, `Download not yet available (set ${envKey})`);

	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(diskPath);
	} catch {
		error(404, `File not found on server: ${diskPath}`);
	}

	const nodeStream = createReadStream(diskPath);
	nodeStream.on('error', (err) => console.error(`[download] stream error for "${diskPath}": ${err}`));
	const webStream = Readable.toWeb(nodeStream) as ReadableStream;

	return new Response(webStream, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${basename(diskPath)}"`,
			'Content-Length': String(fileStat.size),
			'Cache-Control': 'no-store',
		},
	});
};
