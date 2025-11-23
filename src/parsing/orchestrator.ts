import { parseCodeFunctions } from './tree-sitter-parser.js';
import { db } from '../db/drizzle.js';
import { codeReviews } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { downloadRepoAsZip, walkDirectory, readRepoFile } from '../github/zip-download.js';

const SUPPORTED_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyw', '.pyi',
  '.java', '.c', '.h', '.cpp', '.cc', '.cxx',
  '.hpp', '.hh', '.hxx', '.cs', '.csx',
  '.php', '.phtml', '.rb', '.rake',
  '.go', '.rs', '.kt', '.kts', '.swift',
  '.sh', '.bash', '.zsh', '.dart',
  '.scala', '.sc', '.lua', '.sql'
];

const SKIP_DIRS = [
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'target',
  'vendor', '__pycache__', '.venv', 'venv', 'env', '.gradle', '.idea',
  'coverage', '.nyc_output', 'tmp', 'temp', '.cache', '.turbo', '.vercel'
];

const PARALLEL_BATCH_SIZE = 10; // Process 10 files in parallel

export interface FunctionScanOptions {
  repoId: number;
  repoUrl: string;
  branch: string;
  token?: string;
}

export interface FunctionScanResult {
  repoId: number;
  branch: string;
  scanId: string;
  timestamp: Date;
  filesProcessed: number;
  functionsDetected: number;
  scanDuration: number;
}

function isSupportedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export async function runFunctionScan(
  options: FunctionScanOptions
): Promise<FunctionScanResult> {
  const startTime = Date.now();
  const scanId = `func_scan_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  console.log(`[FunctionScan] Starting scan for repo ${options.repoId}`);
  console.log(`[FunctionScan] Repository URL: ${options.repoUrl}`);
  console.log(`[FunctionScan] Branch: ${options.branch}`);
  console.log(`[FunctionScan] Token present: ${options.token ? 'YES' : 'NO'}`);

  // Download repository
  let repoDownload;
  try {
    repoDownload = await downloadRepoAsZip({
      repoUrl: options.repoUrl,
      branch: options.branch,
      token: options.token,
    });
  } catch (error: any) {
    console.error(`[FunctionScan] Failed to download repository:`, error.message);
    throw new Error(`Failed to download repository: ${error.message}`);
  }

  try {
    const repoPath = repoDownload.path;
    console.log(`[FunctionScan] Repository downloaded to ${repoPath}`);

    // Walk directory to find all files
    console.log(`[FunctionScan] Walking directory tree...`);
    const allFiles = await walkDirectory(repoPath, SKIP_DIRS);
    const supportedFiles = allFiles.filter(isSupportedFile);

    console.log(`[FunctionScan] Found ${supportedFiles.length} supported files out of ${allFiles.length} total files`);

    if (supportedFiles.length === 0) {
      console.log(`[FunctionScan] No supported files found, completing scan`);
      return {
        repoId: options.repoId,
        branch: options.branch,
        scanId,
        timestamp: new Date(),
        filesProcessed: 0,
        functionsDetected: 0,
        scanDuration: Date.now() - startTime,
      };
    }

    let filesProcessed = 0;
    let totalFunctions = 0;
    const errors: string[] = [];

    // Process files in batches
    for (let i = 0; i < supportedFiles.length; i += PARALLEL_BATCH_SIZE) {
      const batch = supportedFiles.slice(i, i + PARALLEL_BATCH_SIZE);

      // Log progress every 50 files
      if (i % 50 === 0 && i > 0) {
        console.log(`[FunctionScan] Progress: ${filesProcessed}/${supportedFiles.length} files, ${totalFunctions} functions, ${errors.length} errors`);
      }

      const batchResults = await Promise.allSettled(
        batch.map(async (filePath) => {
          try {
            // Read file content
            const fileContent = await readRepoFile(repoPath, filePath);

            // Parse functions
            const parsedFunctions = await parseCodeFunctions(fileContent, filePath);

            if (parsedFunctions.length > 0) {
              // Delete existing marks for this file and branch
              await db
                .delete(codeReviews)
                .where(
                  and(
                    eq(codeReviews.repoId, options.repoId),
                    eq(codeReviews.filePath, filePath),
                    options.branch ? eq(codeReviews.branch, options.branch) : isNull(codeReviews.branch)
                  )
                );

              // Insert new marks
              await db.insert(codeReviews).values(
                parsedFunctions.map((fn) => ({
                  repoId: options.repoId,
                  filePath: filePath,
                  branch: options.branch || null,
                  commitSha: null,
                  functionName: fn.name,
                  lineStart: fn.startLine ?? null,
                  lineEnd: fn.endLine ?? null,
                  contentHash: fn.contentHash || null,
                  status: 'unmarked' as const,
                }))
              );

              return { filePath, functionsCount: parsedFunctions.length };
            }

            return { filePath, functionsCount: 0 };
          } catch (err: any) {
            console.error(`[FunctionScan] Error processing ${filePath}:`, err.message || err);
            return { filePath, functionsCount: 0, error: err.message || String(err) };
          }
        })
      );

      // Count successful results
      for (const result of batchResults) {
        filesProcessed++;
        if (result.status === 'fulfilled') {
          if (result.value.functionsCount) {
            totalFunctions += result.value.functionsCount;
          }
          if ((result.value as any).error) {
            errors.push(`${result.value.filePath}: ${(result.value as any).error}`);
          }
        } else if (result.status === 'rejected') {
          errors.push(`Batch processing failed: ${result.reason}`);
        }
      }
    }

    const scanDuration = Date.now() - startTime;

    console.log(`[FunctionScan] ✓ Scan completed successfully!`);
    console.log(`[FunctionScan]   Files processed: ${filesProcessed}`);
    console.log(`[FunctionScan]   Functions detected: ${totalFunctions}`);
    console.log(`[FunctionScan]   Duration: ${scanDuration}ms (${(scanDuration / 1000).toFixed(2)}s)`);
    console.log(`[FunctionScan]   Errors: ${errors.length}`);

    if (errors.length > 0 && errors.length <= 10) {
      console.log(`[FunctionScan] Error details:`);
      errors.forEach(err => console.log(`[FunctionScan]   - ${err}`));
    } else if (errors.length > 10) {
      console.log(`[FunctionScan] First 10 errors:`);
      errors.slice(0, 10).forEach(err => console.log(`[FunctionScan]   - ${err}`));
      console.log(`[FunctionScan]   ... and ${errors.length - 10} more errors`);
    }

    return {
      repoId: options.repoId,
      branch: options.branch,
      scanId,
      timestamp: new Date(),
      filesProcessed,
      functionsDetected: totalFunctions,
      scanDuration,
    };
  } finally {
    // Cleanup
    console.log(`[FunctionScan] Cleaning up downloaded repository...`);
    await repoDownload.cleanup();
  }
}
