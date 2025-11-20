import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, rm, readdir, readFile, stat, rename } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

// Use project-relative temp directory instead of system temp
// This is more reliable and easier to clean up
const TEMP_DIR = join(process.cwd(), '.temp');

// Ensure temp directory exists on module load
mkdir(TEMP_DIR, { recursive: true }).catch(() => {
  // Ignore if already exists
});

export interface RepoDownloadOptions {
  repoUrl: string;
  branch: string;
  token?: string;
}

export interface RepoDownloadResult {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Downloads a GitHub repository as a zip file and extracts it to a temporary directory.
 * This avoids GitHub API rate limits since archive downloads don't count against the quota.
 *
 * @param options - Repository download options
 * @returns Object with path to extracted repo and cleanup function
 */
export async function downloadRepoAsZip(
  options: RepoDownloadOptions
): Promise<RepoDownloadResult> {
  const scanId = `repo-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const tempDir = join(TEMP_DIR, scanId);
    await mkdir(tempDir, { recursive: true });

  try {
    // Extract owner and repo name from URL (e.g., https://github.com/owner/repo.git)
    const urlMatch = options.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (!urlMatch) {
      throw new Error('Invalid GitHub repository URL');
    }
    const [, owner, repo] = urlMatch;

    // For private repos with authentication, use GitHub API endpoint
    // For public repos, use the standard archive URL
    const useApiEndpoint = !!options.token;

    const zipUrl = useApiEndpoint
      ? `https://api.github.com/repos/${owner}/${repo}/zipball/${options.branch}`
      : `https://github.com/${owner}/${repo}/archive/refs/heads/${options.branch}.zip`;

    const zipPath = join(TEMP_DIR, `${scanId}.zip`);

    console.log(`Downloading ${owner}/${repo}@${options.branch} as zip...`);
    console.log(`Token present: ${options.token ? 'YES (length: ' + options.token.length + ')' : 'NO'}`);
    console.log(`Using ${useApiEndpoint ? 'API' : 'archive'} endpoint`);
    console.log(`URL: ${zipUrl}`);

    // Download the zip file using curl with proper error handling
    // Note: GitHub uses "token" not "Bearer" for personal access tokens
    // Escape the token to prevent shell injection and handle special characters
    const escapedToken = options.token ? options.token.replace(/'/g, "'\\''") : '';
    const authHeader = escapedToken ? `-H 'Authorization: token ${escapedToken}'` : '';
    const curlCommand = `curl -L -w "%{http_code}" -s ${authHeader} -o "${zipPath}" "${zipUrl}"`;

    // Log command structure (without token for security)
    console.log(`Curl command structure: curl -L -w "%{http_code}" -s ${escapedToken ? '-H "Authorization: token ***"' : ''} -o "${zipPath}" "${zipUrl}"`);

    try {
      // Reduced maxBuffer from 100MB to 1MB since we only need the HTTP status code
      // The actual file is written to disk, not buffered in memory
      const { stdout, stderr } = await execAsync(curlCommand, { maxBuffer: 1024 * 1024 });

      // Parse HTTP status code from curl output (should just be the HTTP code)
      const httpCode = stdout.trim();

      console.log(`Download completed with HTTP status: ${httpCode}`);

      // Check if download was successful
      if (!httpCode.startsWith('2')) {
        console.error('Curl stderr:', stderr);
        throw new Error(`Failed to download repository: HTTP ${httpCode}. The repository may be private or the branch may not exist.`);
      }

      // Check if file exists and has content
      let fileStats;
      try {
        fileStats = await stat(zipPath);
      } catch (statError) {
        throw new Error(`Downloaded file not found at ${zipPath}`);
      }

      if (fileStats.size === 0) {
        throw new Error('Downloaded file is empty (0 bytes)');
      }

      // Reject files larger than 5GB to prevent memory issues
      const MAX_REPO_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
      if (fileStats.size > MAX_REPO_SIZE) {
        await rm(zipPath, { force: true });
        throw new Error(`Repository is too large (${Math.round(fileStats.size / 1024 / 1024)}MB). Maximum size is ${Math.round(MAX_REPO_SIZE / 1024 / 1024)}MB.`);
      }

      console.log(`Downloaded ${fileStats.size} bytes to ${zipPath}`);

      // Verify the downloaded file is a valid zip by checking its magic bytes (PK)
      // Only read the first 200 bytes instead of the entire file to save memory
      let zipHeader: Buffer;
      try {
        const fileHandle = await import('fs/promises').then(m => m.open(zipPath, 'r'));
        zipHeader = Buffer.alloc(200);
        await fileHandle.read(zipHeader, 0, 200, 0);
        console.log(`Read first ${zipHeader.length} bytes of downloaded file for validation`);
        await fileHandle.close();
      } catch (readError: any) {
        throw new Error(`Failed to read downloaded file: ${readError.message}`);
      }

      // Check ZIP magic bytes: First 2 bytes should be 'PK' (0x50, 0x4B)
      const isValidZip = zipHeader.length >= 4 && zipHeader[0] === 0x50 && zipHeader[1] === 0x4B;

      if (!isValidZip) {
        // Log first 200 bytes to help debug what was actually downloaded
        const preview = zipHeader.slice(0, Math.min(200, zipHeader.length));
        console.error('Downloaded file is NOT a valid zip!');
        console.error(`File size: ${zipHeader.length} bytes`);
        console.error(`First 4 bytes (hex): ${preview.slice(0, 4).toString('hex')}`);
        console.error(`First bytes (text): ${preview.toString('utf-8').slice(0, 200)}`);

        // Check if it's an HTML error page
        const content = zipHeader.toString('utf-8');
        if (content.includes('<!DOCTYPE') || content.includes('<html')) {
          console.error('ERROR: Downloaded content is an HTML page, not a zip file!');
          console.error('This usually means the repository is private, the branch does not exist, or authentication failed.');
        }

        throw new Error('Downloaded file is not a valid zip file. Check logs for details.');
      }

      console.log('✓ Zip file validation passed - file appears to be a valid zip archive');

      // Run an explicit ls so we can see the file on disk before extraction
      try {
        const { stdout } = await execAsync(`ls -lh "${zipPath}"`);
        console.log('Zip file listing:\n' + stdout.trim());
      } catch (lsError) {
        console.warn(`Failed to list ${zipPath} before extraction:`, (lsError as Error).message);
      }
    } catch (error: any) {
      console.error('Download/validation failed:', error.message);

      // Cleanup the bad file
      try {
        await rm(zipPath, { force: true });
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }

      throw error;
    }

    console.log('Zip file downloaded successfully, extracting...');

    // Extract the zip file
    try {
      // Reduced maxBuffer from 50MB to 1MB since unzip output is minimal
      // The actual extraction happens to disk, not in memory
      await execAsync(
        `unzip -q "${zipPath}" -d "${tempDir}"`,
        { maxBuffer: 1024 * 1024 }
      );
    } catch (error: any) {
      console.error('Unzip failed:', error);
      throw new Error(`Failed to extract repository: ${error.message}`);
    }

    // GitHub zips extract to a folder named "repo-branch", so we need to find it
    const extractedDirs = await readdir(tempDir);
    if (extractedDirs.length === 0) {
      throw new Error('Zip extraction failed - no files found');
    }
    const extractedDir = extractedDirs[0];
    const repoPath = join(tempDir, extractedDir);
    let repoRootPath = repoPath;

    // Flatten extracted repo so scanners can read from tempDir root
    try {
      const repoEntries = await readdir(repoPath, { withFileTypes: true });
      if (repoEntries.length === 0) {
        console.warn(`Extracted repository directory ${repoPath} is empty, skipping flatten step`);
      } else {
        for (const entry of repoEntries) {
          const fromPath = join(repoPath, entry.name);
          const toPath = join(tempDir, entry.name);
          await rename(fromPath, toPath);
        }
        await rm(repoPath, { recursive: true, force: true });
        repoRootPath = tempDir;
      }
    } catch (moveError) {
      console.warn('Failed to flatten extracted repo, continuing with nested path:', moveError);
    }

    // Log the directory contents after extraction/flattening
    try {
      const { stdout } = await execAsync(`ls -al "${repoRootPath}"`);
      console.log('Extracted repo contents:\n' + stdout.trim());
    } catch (lsError) {
      console.warn(`Failed to list ${repoRootPath} after extraction:`, (lsError as Error).message);
    }

    // Clean up zip file
    await rm(zipPath, { force: true });

    console.log(`Repository extracted to ${repoRootPath}`);

    return {
      path: repoRootPath,
      cleanup: async () => {
        try {
          await rm(tempDir, { recursive: true, force: true });
          console.log(`Cleaned up temp directory: ${tempDir}`);
        } catch (error) {
          console.error('Failed to cleanup temp directory:', error);
        }
      },
    };
  } catch (error) {
    // Cleanup on error - remove both temp directory and zip file
    try {
      await rm(tempDir, { recursive: true, force: true });
      await rm(join(TEMP_DIR, `${scanId}.zip`), { force: true });
    } catch (cleanupError) {
      console.error('Failed to cleanup after error:', cleanupError);
    }
    throw error;
  }
}

/**
 * Recursively walks a directory and returns all file paths
 */
export async function walkDirectory(
  dir: string,
  skipDirs: string[] = []
): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string, relativePath: string = '') {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (skipDirs.includes(entry.name)) {
          continue;
        }
        await walk(join(currentPath, entry.name), entryRelativePath);
      } else if (entry.isFile()) {
        files.push(entryRelativePath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Reads a file from the extracted repository
 */
export async function readRepoFile(repoPath: string, filePath: string): Promise<string> {
  const fullPath = join(repoPath, filePath);
  return await readFile(fullPath, 'utf-8');
}

/**
 * Cleanup old temp files (older than 1 hour)
 * This helps prevent disk space issues from failed cleanups
 */
export async function cleanupOldTempFiles(): Promise<void> {
  try {
    const entries = await readdir(TEMP_DIR, { withFileTypes: true });
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let cleanedCount = 0;

    for (const entry of entries) {
      const fullPath = join(TEMP_DIR, entry.name);
      try {
        const stats = await stat(fullPath);
        if (stats.mtimeMs < oneHourAgo) {
          await rm(fullPath, { recursive: true, force: true });
          cleanedCount++;
          console.log(`Cleaned up old temp file/directory: ${entry.name}`);
        }
      } catch (error) {
        // Ignore errors for individual files
        console.error(`Failed to cleanup ${entry.name}:`, error);
      }
    }

    if (cleanedCount > 0) {
      console.log(`✓ Cleaned up ${cleanedCount} old temp file(s)`);
    }
  } catch (error) {
    // Ignore if temp directory doesn't exist yet
    console.error('Failed to cleanup old temp files:', error);
  }
}

// Run cleanup on module load
cleanupOldTempFiles().catch(() => {
  // Ignore cleanup errors
});

// Schedule periodic cleanup every 30 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    cleanupOldTempFiles().catch(() => {
      // Ignore cleanup errors
    });
  }, 30 * 60 * 1000); // 30 minutes
}
