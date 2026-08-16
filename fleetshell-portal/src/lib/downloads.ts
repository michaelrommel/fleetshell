/**
 * Download-related portal constants.
 *
 * PUBLIC_GITHUB_RELEASE_URL -- fallback download URL shown when the portal
 * download is blocked by a corporate security scanner (e.g. ZScaler). Point it
 * at the GitHub releases page. When empty the GitHub fallback button is hidden.
 */
import { env } from '$env/dynamic/public';

export const GITHUB_RELEASE_URL: string = env.PUBLIC_GITHUB_RELEASE_URL ?? '';
