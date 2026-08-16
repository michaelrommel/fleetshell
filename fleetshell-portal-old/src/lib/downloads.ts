/**
 * Download-related portal constants.
 *
 * PUBLIC_GITHUB_RELEASE_URL — fallback download URL shown when the portal
 * download is blocked by a corporate security scanner (e.g. ZScaler sandbox
 * scan).  Point it to the GitHub releases page or a specific release asset.
 *
 * Set in .env (dev) or the ECS task definition (prod).
 * When left empty the GitHub fallback button is hidden.
 *
 *   PUBLIC_GITHUB_RELEASE_URL=https://github.com/<org>/fleetshell-client/releases/latest
 */
import { env } from '$env/dynamic/public';

export const GITHUB_RELEASE_URL: string =
	env.PUBLIC_GITHUB_RELEASE_URL ?? '';
