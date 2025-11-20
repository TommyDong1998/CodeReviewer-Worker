import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { db } from '../db/drizzle';
import { githubAppInstallations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createSign } from 'crypto';

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

function ensureGitHubAppCredentials() {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      'GitHub App credentials not configured. Please set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH (or legacy GITHUB_APP_PRIVATE_KEY) environment variables.'
    );
  }
}

function base64Url(buffer: Buffer | string): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createAppJwt(): string {
  ensureGitHubAppCredentials();
  const appId = Number(GITHUB_APP_ID);
  if (!Number.isFinite(appId)) {
    throw new Error(`Invalid GITHUB_APP_ID value: ${GITHUB_APP_ID}`);
  }

  const now = Math.floor(Date.now() / 1000);
  // Allow up to 10 minutes per GitHub's requirements, minus a minute for clock drift
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(GITHUB_APP_PRIVATE_KEY!);

  return `${signingInput}.${base64Url(signature)}`;
}

async function requestInstallationToken(installationId: number) {
  ensureGitHubAppCredentials();
  const jwt = createAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codereview-worker',
    },
  });

  const responseText = await response.text();
  let data: { token: string; expires_at: string };
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`GitHub API returned non-JSON response: ${responseText}`);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch installation token (${response.status} ${response.statusText}): ${responseText}`
    );
  }

  if (!data?.token || !data?.expires_at) {
    throw new Error('GitHub API response missing token or expires_at fields');
  }

  return data;
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
  const installationId = parseInt(installationIdString, 10);
  if (!Number.isFinite(installationId)) {
    throw new Error(`Invalid installation ID: ${installationIdString}`);
  }

  const data = await requestInstallationToken(installationId);

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
