/**
 * Singleton S3 client for the portal server -- session-recording browser.
 *
 * Environment:
 *   AWS_REGION / AWS_DEFAULT_REGION - region (default: eu-west-1)
 *   GUACD_S3_BUCKET / AWS_S3_BUCKET - recording bucket (e.g. dev-s3-fleetshell)
 *
 * Credentials come from the ECS task role / env / default chain -- no explicit
 * config. Recording objects are laid out by device IP:
 *   guacamole/recordings/<ip>/YYYY-MM-DD/<session>.<ext>
 * (written by fleetshell-gateway's guacrecord post-processor).
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';

let _s3: S3Client | undefined;

export function getS3Client(): S3Client {
	if (!_s3) {
		_s3 = new S3Client({
			region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-west-1',
		});
	}
	return _s3;
}

export function s3Bucket(): string {
	return env.GUACD_S3_BUCKET ?? env.AWS_S3_BUCKET ?? '';
}

/** Recording days (YYYY-MM-DD) for a device IP, most-recent first. */
export async function listRecordingDays(ip: string): Promise<string[]> {
	const s3 = getS3Client();
	const bucket = s3Bucket();
	if (!bucket) return [];

	const prefix = `guacamole/recordings/${ip}/`;
	const resp = await s3.send(
		new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }),
	);

	return (resp.CommonPrefixes ?? [])
		.map((p) => p.Prefix?.replace(prefix, '').replace('/', '') ?? '')
		.filter(Boolean)
		.sort()
		.reverse();
}

export type RecordingSession = { session: string; sizeBytes: number; lastModified: string | null };

/**
 * Sessions recorded on a given day for a device IP. One .meta.json per session
 * is the canonical marker; the .zip size + mtime are surfaced for the UI.
 */
export async function listDaySessions(ip: string, day: string): Promise<RecordingSession[]> {
	const s3 = getS3Client();
	const bucket = s3Bucket();
	if (!bucket) return [];

	const prefix = `guacamole/recordings/${ip}/${day}/`;
	const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
	const objs = resp.Contents ?? [];

	const zipByBase = new Map<string, { size: number; mtime: string | null }>();
	for (const o of objs) {
		const key = o.Key ?? '';
		if (key.endsWith('.zip')) {
			zipByBase.set(key.replace(prefix, '').replace('.zip', ''), {
				size: o.Size ?? 0,
				mtime: o.LastModified ? new Date(o.LastModified).toISOString() : null,
			});
		}
	}

	return objs
		.map((o) => o.Key ?? '')
		.filter((k) => k.endsWith('.meta.json'))
		.map((k) => k.replace(prefix, '').replace('.meta.json', ''))
		.sort()
		.reverse()
		.map((session) => ({
			session,
			sizeBytes: zipByBase.get(session)?.size ?? 0,
			lastModified: zipByBase.get(session)?.mtime ?? null,
		}));
}

/** Presigned GET URL for a session ZIP bundle (default 15 min TTL). */
export async function presignedDownloadUrl(
	ip: string,
	day: string,
	session: string,
	ttl = 900,
): Promise<string> {
	const s3 = getS3Client();
	const bucket = s3Bucket();
	const key = `guacamole/recordings/${ip}/${day}/${session}.zip`;
	return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}
