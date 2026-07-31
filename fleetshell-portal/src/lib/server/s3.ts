/**
 * Singleton S3 client for the portal server.
 *
 * Configuration via environment variables:
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *   GUACD_S3_BUCKET — bucket name (e.g. dev-s3-fleetshell)
 *
 * Credentials are auto-discovered from the ECS task role, environment
 * variables, or the default credential chain — no explicit config needed.
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl }                   from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand }               from '@aws-sdk/client-s3';
import { env }                            from '$env/dynamic/private';

// ── Singleton client ──────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * List the "day folder" common prefixes under a device IP prefix.
 * Returns dates in descending order (most recent first).
 *
 * S3 key layout:
 *   guacamole/recordings/<ip>/YYYY-MM-DD/<session>.<ext>
 */
export async function listRecordingDays(ip: string): Promise<string[]> {
	const s3     = getS3Client();
	const bucket = s3Bucket();
	if (!bucket) return [];

	const prefix = `guacamole/recordings/${ip}/`;
	const resp   = await s3.send(new ListObjectsV2Command({
		Bucket    : bucket,
		Prefix    : prefix,
		Delimiter : '/',
	}));

	const days = (resp.CommonPrefixes ?? [])
		.map(p => p.Prefix?.replace(prefix, '').replace('/', '') ?? '')
		.filter(Boolean)
		.sort()
		.reverse();   // most recent first

	return days;
}

/**
 * List all session base-names (without extension) recorded on a given day
 * for a device, based on the .meta.json objects present.
 */
export async function listDaySessions(ip: string, day: string): Promise<string[]> {
	const s3     = getS3Client();
	const bucket = s3Bucket();
	if (!bucket) return [];

	const prefix = `guacamole/recordings/${ip}/${day}/`;
	const resp   = await s3.send(new ListObjectsV2Command({
		Bucket : bucket,
		Prefix : prefix,
	}));

	// Use .meta.json as the canonical session indicator — one per session.
	const sessions = (resp.Contents ?? [])
		.map(o => o.Key ?? '')
		.filter(k => k.endsWith('.meta.json'))
		.map(k => k.replace(prefix, '').replace('.meta.json', ''))
		.sort()
		.reverse();

	return sessions;
}

/**
 * Generate a presigned GET URL for the session ZIP bundle.
 * The URL is valid for 15 minutes — long enough for a download to start.
 */
export async function presignedDownloadUrl(
	ip:      string,
	day:     string,
	session: string,
	ttl     = 900,       // seconds
): Promise<string> {
	const s3     = getS3Client();
	const bucket = s3Bucket();
	const key    = `guacamole/recordings/${ip}/${day}/${session}.zip`;

	return getSignedUrl(
		s3,
		new GetObjectCommand({ Bucket: bucket, Key: key }),
		{ expiresIn: ttl },
	);
}
