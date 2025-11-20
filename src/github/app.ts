import { App } from '@octokit/app';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { db } from '../db/drizzle';
import { githubAppInstallations } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * GitHub App configuration
 * These values should be set in environment variables
 */
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const DEFAULT_PRIVATE_KEY_PATH = path.resolve(__dirname, '../../config/github-app-private-key.pem');
const ENV_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

let resolvedPrivateKey: string | undefined;

for (const candidatePath of [ENV_PRIVATE_KEY_PATH, DEFAULT_PRIVATE_KEY_PATH]) {
  if (!candidatePath) {
    continue;
  }

  try {
    if (!existsSync(candidatePath)) {
      if (candidatePath === ENV_PRIVATE_KEY_PATH) {
        console.error(`ERROR: GitHub App private key path does not exist: ${candidatePath}`);
      }
      continue;
    }

    resolvedPrivateKey = readFileSync(candidatePath, 'utf8');
    if (candidatePath === DEFAULT_PRIVATE_KEY_PATH) {
      console.log(`INFO: Loaded GitHub App private key from default path: ${candidatePath}`);
    }
    break;
  } catch (error) {
    console.error(`ERROR: Unable to read GitHub App private key from ${candidatePath}`, error);
  }
}

if (!resolvedPrivateKey && process.env.GITHUB_APP_PRIVATE_KEY) {
  resolvedPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  console.warn('WARNING: Loading GitHub App private key from environment variable. Prefer using GITHUB_APP_PRIVATE_KEY_PATH.');
}

const GITHUB_APP_PRIVATE_KEY = resolvedPrivateKey;

if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
  console.error('ERROR: GitHub App credentials not configured!');
  console.error('Please set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH (or legacy GITHUB_APP_PRIVATE_KEY) environment variables.');
  console.error('These are required for the worker to authenticate with GitHub.');
}

/**
 * Create an Octokit App instance
 */
export function createGitHubApp() {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App credentials not configured. Please set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH (or legacy GITHUB_APP_PRIVATE_KEY) environment variables.');
  }

  return new App({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
  });
}

/**
 * Get or refresh an installation access token
 * Installation tokens expire after 1 hour
 */
export async function getInstallationToken(installationIdString: string): Promise<string> {
  // Find the installation record
  const installation = await db.query.githubAppInstallations.findFirst({
    where: eq(githubAppInstallations.installationId, installationIdString),
  });

  if (!installation) {
    throw new Error(`Installation not found: ${installationIdString}`);
  }

  // Check if token is still valid (expires in 1 hour)
  const now = new Date();
  const tokenExpiresAt = installation.tokenExpiresAt;

  // If token exists and expires more than 5 minutes from now, return it
  if (installation.accessToken && tokenExpiresAt) {
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
    if (tokenExpiresAt > fiveMinutesFromNow) {
      console.log(`Using cached installation token for ${installationIdString} (expires in ${Math.round((tokenExpiresAt.getTime() - now.getTime()) / 1000 / 60)} minutes)`);
      return installation.accessToken;
    }
  }

  // Token is expired or about to expire, get a new one
  console.log(`Fetching new installation token for ${installationIdString}...`);
  const app = createGitHubApp();
  const { data } = await app.octokit.request('POST /app/installations/{installation_id}/access_tokens', {
    installation_id: parseInt(installationIdString),
  });

  // Update the installation record with new token
  await db
    .update(githubAppInstallations)
    .set({
      accessToken: data.token,
      tokenExpiresAt: new Date(data.expires_at),
      updatedAt: new Date(),
    })
    .where(eq(githubAppInstallations.id, installation.id));

  console.log(`✓ New installation token fetched for ${installationIdString}`);
  return data.token;
}
