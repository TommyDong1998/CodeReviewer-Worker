# Function Scanning Solution for CodeReviewer-Worker

## Executive Summary

This document outlines the solution to add **function scanning capabilities** to the CodeReviewer-Worker service. Currently, the Worker only performs security scanning (Semgrep, Gitleaks, Checkov, Trivy). By adding function scanning, the Worker will also parse code files to extract function definitions and store them in the database.

## Current Architecture

### CodeReviewer (Main Application)
- **Function Scanning**: Done synchronously in the Next.js API route `/api/repos/[id]/auto-detect`
- **Process**:
  1. Downloads repository as ZIP using GitHub token
  2. Walks directory tree to find supported files (`.js`, `.ts`, `.py`, `.java`, etc.)
  3. Parses each file using **tree-sitter** (via `web-tree-sitter` WASM)
  4. Extracts function definitions with line numbers
  5. Stores results in `codeReviews` table
- **Limitations**:
  - 10-minute timeout
  - Blocks the Next.js server
  - Limited parallelism (5 files at a time)
  - No retry mechanism

### CodeReviewer-Worker
- **Security Scanning**: Done asynchronously via SQS queue
- **Process**:
  1. Receives job from SQS (via Elastic Beanstalk worker daemon)
  2. Downloads repository as ZIP
  3. Runs 5 security tools in parallel
  4. Stores results in `securityScans` and `securityIssues` tables
- **Advantages**:
  - Asynchronous processing
  - No timeout constraints
  - Isolated from main application
  - Better resource management

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CodeReviewer (Main App)                      │
│                                                                   │
│  User clicks "Scan Functions" button                             │
│         │                                                         │
│         ↓                                                         │
│  POST /api/repos/[id]/function-scan                              │
│         │                                                         │
│         ↓                                                         │
│  1. Create scan record in DB (status: 'processing')             │
│  2. Queue job to SQS                                             │
│  3. Return scanId to user immediately                            │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ SQS Queue
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                   CodeReviewer-Worker                            │
│                                                                   │
│  HTTP Server receives job from sqsd                              │
│         │                                                         │
│         ↓                                                         │
│  Route to appropriate processor:                                 │
│    - SecurityScanJob → processSecurityScan()                    │
│    - FunctionScanJob → processFunctionScan()  ← NEW             │
│         │                                                         │
│         ↓                                                         │
│  1. Download repo as ZIP (shared with security scan)            │
│  2. Walk directory for supported files                           │
│  3. Parse functions using tree-sitter                            │
│  4. Store in codeReviews table                                   │
│  5. Update scan record (status: 'completed')                    │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Database Schema Updates

**Add new table: `functionScans`** (similar to `securityScans`)

```typescript
// src/db/schema.ts

export const functionScans = pgTable('function_scans', {
  scanId: varchar('scan_id', { length: 255 }).primaryKey(),
  repoId: integer('repo_id').notNull().references(() => githubRepos.id, { onDelete: 'cascade' }),
  branch: varchar('branch', { length: 255 }),
  userId: integer('user_id').notNull().references(() => users.id),
  teamId: integer('team_id').references(() => teams.id),
  status: varchar('status', { length: 50 }).notNull().default('processing'), // 'processing', 'completed', 'failed'
  filesProcessed: integer('files_processed').default(0),
  functionsDetected: integer('functions_detected').default(0),
  scanDuration: integer('scan_duration').default(0), // milliseconds
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});
```

### Phase 2: Worker Code Changes

#### 2.1 Add Job Type Discriminator

```typescript
// src/worker.ts

interface BaseJob {
  jobType: 'security' | 'function';
}

interface SecurityScanJob extends BaseJob {
  jobType: 'security';
  scanId: string;
  repoId: number;
  repoUrl: string;
  branch: string;
  token?: string;
  installationId?: string;
}

interface FunctionScanJob extends BaseJob {
  jobType: 'function';
  scanId: string;
  repoId: number;
  repoUrl: string;
  branch: string;
  token?: string;
  installationId?: string;
}

type Job = SecurityScanJob | FunctionScanJob;
```

#### 2.2 Add Function Scanning Module

**Create: `src/parsing/orchestrator.ts`**

```typescript
import { parseCodeFunctions } from './tree-sitter-parser';
import { db } from '../db/drizzle';
import { codeReviews, functionScans } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { downloadRepoAsZip, walkDirectory, readRepoFile } from '../github/zip-download';

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

  // Download repository
  const repoDownload = await downloadRepoAsZip({
    repoUrl: options.repoUrl,
    branch: options.branch,
    token: options.token,
  });

  try {
    const repoPath = repoDownload.path;
    console.log(`[FunctionScan] Repository downloaded to ${repoPath}`);

    // Walk directory to find all files
    const allFiles = await walkDirectory(repoPath, SKIP_DIRS);
    const supportedFiles = allFiles.filter(isSupportedFile);

    console.log(`[FunctionScan] Found ${supportedFiles.length} supported files`);

    let filesProcessed = 0;
    let totalFunctions = 0;

    // Process files in batches
    for (let i = 0; i < supportedFiles.length; i += PARALLEL_BATCH_SIZE) {
      const batch = supportedFiles.slice(i, i + PARALLEL_BATCH_SIZE);

      // Log progress
      if (i % 50 === 0 && i > 0) {
        console.log(`[FunctionScan] Progress: ${filesProcessed}/${supportedFiles.length} files, ${totalFunctions} functions`);
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
                  commitSha: null, // Can be added if needed
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
          } catch (err) {
            console.error(`[FunctionScan] Error processing ${filePath}:`, err);
            return { filePath, functionsCount: 0, error: err };
          }
        })
      );

      // Count successful results
      for (const result of batchResults) {
        filesProcessed++;
        if (result.status === 'fulfilled' && result.value.functionsCount) {
          totalFunctions += result.value.functionsCount;
        }
      }
    }

    const scanDuration = Date.now() - startTime;

    console.log(`[FunctionScan] Completed: ${filesProcessed} files, ${totalFunctions} functions, ${scanDuration}ms`);

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
    await repoDownload.cleanup();
  }
}
```

**Create: `src/parsing/tree-sitter-parser.ts`**

Copy the tree-sitter parsing logic from CodeReviewer's `app/api/parse/actions.ts`. Key points:

- Use the same WASM-based tree-sitter parser
- Support the same languages
- Extract function definitions with line ranges
- Include content hashing for change detection

```typescript
// This file will contain:
// - parseCodeFunctions(code: string, filePath?: string)
// - Language detection logic
// - Tree-sitter initialization
// - Function extraction logic
// - Content hashing
```

#### 2.3 Update Worker Entry Point

```typescript
// src/worker.ts

import { runSecurityScan } from './security/orchestrator';
import { runFunctionScan } from './parsing/orchestrator';
import { db } from './db/drizzle';
import { securityScans, functionScans, codeReviews } from './db/schema';

async function processJob(job: Job): Promise<void> {
  if (job.jobType === 'security') {
    await processSecurityScan(job);
  } else if (job.jobType === 'function') {
    await processFunctionScan(job);
  } else {
    throw new Error(`Unknown job type: ${(job as any).jobType}`);
  }
}

async function processSecurityScan(job: SecurityScanJob): Promise<void> {
  // Existing security scan logic...
}

async function processFunctionScan(job: FunctionScanJob): Promise<void> {
  console.log(`Processing function scan job: ${job.scanId}`);

  try {
    // Get authentication token (same as security scan)
    let token: string | undefined = job.token;

    if (!token && job.installationId) {
      console.log(`Fetching installation token for installation: ${job.installationId}`);
      token = await getInstallationToken(job.installationId);
    }

    // Run the function scan
    const scanResult = await runFunctionScan({
      repoId: job.repoId,
      repoUrl: job.repoUrl,
      branch: job.branch,
      token: token,
    });

    // Update scan record with results
    console.log(`Updating scan ${job.scanId} to completed status`);
    await db
      .update(functionScans)
      .set({
        status: 'completed',
        filesProcessed: scanResult.filesProcessed,
        functionsDetected: scanResult.functionsDetected,
        scanDuration: scanResult.scanDuration,
        completedAt: scanResult.timestamp,
      })
      .where(eq(functionScans.scanId, job.scanId));

    console.log(`Successfully completed function scan job: ${job.scanId}`);
  } catch (error) {
    console.error('Error processing function scan job:', error);

    // Mark scan as failed
    await db
      .update(functionScans)
      .set({
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      })
      .where(eq(functionScans.scanId, job.scanId));

    throw error;
  }
}
```

### Phase 3: Main Application Changes

#### 3.1 Create Function Scan API Endpoint

**Create: `app/api/repos/[id]/function-scan/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/drizzle';
import { functionScans } from '@/lib/db/schema';
import { queueFunctionScan } from '@/lib/sqs/queue';
import { getInstallationToken } from '@/lib/github/app';
import { getUserGitHubInstallation } from '@/app/api/github/actions';
import { validateRepoAccess } from '@/lib/api/auth-helpers';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const branch = body.branch || 'main';

  try {
    // Validate authentication and repository access
    const auth = await validateRepoAccess(id);
    if (!auth.success) return auth.response;
    const { user, repo: repoRecord } = auth;

    // Get GitHub token
    const installation = await getUserGitHubInstallation();
    if (!installation) {
      return NextResponse.json(
        { error: "No GitHub App installation found" },
        { status: 401 }
      );
    }
    const token = await getInstallationToken(installation.installationId);

    // Construct clone URL
    const cloneUrl = `https://github.com/${repoRecord.fullName}.git`;

    // Generate scanId
    const scanId = `func_scan_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Create scan record
    await db.insert(functionScans).values({
      scanId,
      repoId: repoRecord.id,
      branch,
      userId: user.id,
      teamId: repoRecord.teamId,
      status: 'processing',
      filesProcessed: 0,
      functionsDetected: 0,
      scanDuration: 0,
    });

    // Queue the function scan job
    await queueFunctionScan({
      jobType: 'function',
      scanId,
      repoId: repoRecord.id,
      repoUrl: cloneUrl,
      branch,
      token,
    });

    return NextResponse.json({
      success: true,
      scanId,
      status: 'processing',
      message: 'Function scan queued. This may take a few minutes.',
    });
  } catch (error: any) {
    console.error('Error in function scan:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start function scan' },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve scan results
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const scanId = searchParams.get('scanId');

  try {
    const auth = await validateRepoAccess(id);
    if (!auth.success) return auth.response;
    const { repo: repoRecord } = auth;

    if (scanId) {
      const scan = await db.query.functionScans.findFirst({
        where: eq(functionScans.scanId, scanId),
      });

      if (!scan) {
        return NextResponse.json(
          { error: 'Scan not found' },
          { status: 404 }
        );
      }

      return NextResponse.json({ scan });
    } else {
      // Get all scans for this repo
      const scans = await db
        .select()
        .from(functionScans)
        .where(eq(functionScans.repoId, repoRecord.id))
        .orderBy(desc(functionScans.createdAt));

      return NextResponse.json({ scans });
    }
  } catch (error: any) {
    console.error('Error fetching function scans:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch function scans' },
      { status: 500 }
    );
  }
}
```

#### 3.2 Update SQS Queue Handler

**Update: `lib/sqs/queue.ts`**

```typescript
export async function queueFunctionScan(job: FunctionScanJob): Promise<void> {
  const sqsClient = getSQSClient();
  const queueUrl = process.env.SQS_QUEUE_URL;

  if (!queueUrl) {
    throw new Error('SQS_QUEUE_URL not configured');
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
    })
  );

  console.log(`Queued function scan job: ${job.scanId}`);
}
```

### Phase 4: Dependencies

#### 4.1 Add to Worker's package.json

```json
{
  "dependencies": {
    "web-tree-sitter": "^0.20.8",
    "tree-sitter-javascript": "^0.20.4",
    "tree-sitter-typescript": "^0.20.5",
    "tree-sitter-python": "^0.20.4",
    "tree-sitter-java": "^0.20.2",
    "tree-sitter-c": "^0.20.6",
    "tree-sitter-cpp": "^0.20.3",
    "tree-sitter-c-sharp": "^0.20.0",
    "tree-sitter-php": "^0.21.1",
    "tree-sitter-ruby": "^0.20.0",
    "tree-sitter-go": "^0.20.0",
    "tree-sitter-rust": "^0.20.4",
    "tree-sitter-kotlin": "^0.3.1",
    "tree-sitter-swift": "^0.3.7",
    "tree-sitter-bash": "^0.20.4",
    "tree-sitter-dart": "^0.0.1",
    "tree-sitter-scala": "^0.20.2",
    "tree-sitter-lua": "^0.0.19",
    "tree-sitter-sql": "^0.1.0"
  }
}
```

#### 4.2 Setup WASM Files

Copy the WASM files from the main application to the Worker:

```bash
# In CodeReviewer-Worker directory
mkdir -p public/tree-sitter
cp ../CodeReviewer/public/tree-sitter/*.wasm public/tree-sitter/
```

## Migration Strategy

### Option A: Gradual Migration (Recommended)

1. **Phase 1**: Deploy Worker with function scanning capability
2. **Phase 2**: Add new API endpoint `/api/repos/[id]/function-scan` alongside existing `/api/repos/[id]/auto-detect`
3. **Phase 3**: Update UI to use new endpoint for large repos
4. **Phase 4**: Monitor performance and gradually shift all function scanning to Worker
5. **Phase 5**: Deprecate old `/auto-detect` endpoint

### Option B: Immediate Migration

1. Update `/api/repos/[id]/auto-detect` to queue jobs instead of processing synchronously
2. Deploy both changes simultaneously
3. All function scanning immediately goes through Worker

## Benefits

1. **No Timeouts**: Worker can process arbitrarily large repositories
2. **Better Resource Management**: Isolated from main Next.js server
3. **Parallel Processing**: Can scale worker instances independently
4. **Retry Logic**: SQS provides automatic retries on failure
5. **Monitoring**: Centralized job tracking via scan records
6. **Consistency**: Security and function scanning use same infrastructure

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Worker becomes too complex | Keep concerns separated with modular architecture |
| Increased infrastructure cost | Monitor usage and optimize batch sizes |
| Longer wait times for users | Implement WebSocket/polling for real-time updates |
| Tree-sitter WASM issues in Worker | Thorough testing in Worker environment |

## Testing Plan

1. **Unit Tests**: Test `parseCodeFunctions` with various languages
2. **Integration Tests**: Test full scan pipeline with sample repositories
3. **Load Tests**: Test with large repositories (>5GB, >10K files)
4. **Comparison Tests**: Compare results between old and new implementation
5. **Failure Tests**: Test error handling and retry logic

## Monitoring

Add CloudWatch metrics for:
- Function scan duration
- Files processed per scan
- Functions detected per scan
- Failure rate
- Queue depth
- Worker memory/CPU usage

## Timeline Estimate

- **Phase 1** (Database): 1 day
- **Phase 2** (Worker): 3-4 days
- **Phase 3** (Main App): 2 days
- **Phase 4** (Dependencies): 1 day
- **Testing**: 2-3 days
- **Deployment**: 1 day

**Total**: ~10-12 days

## Conclusion

By moving function scanning to the Worker, we achieve better scalability, reliability, and resource management. The solution reuses existing infrastructure (SQS, download logic, database) while adding a new capability that can handle repositories of any size without timeout constraints.
