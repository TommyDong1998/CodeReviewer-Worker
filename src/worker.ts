import http from 'http';
import { runSecurityScan } from './security/orchestrator';
import { runFunctionScan } from './parsing/orchestrator';
import { db } from './db/drizzle';
import { securityScans, securityIssues, functionScans, githubRepos } from './db/schema';
import { eq } from 'drizzle-orm';
import { getInstallationToken } from './github/app';

interface BaseJob {
  jobType: 'security' | 'function';
}

interface SecurityScanJob extends BaseJob {
  jobType: 'security';
  scanId: string;
  repoId: number;
  repoUrl: string;
  branch: string;
  token?: string; // Legacy - kept for backwards compatibility
  installationId?: string; // GitHub App installation ID (preferred)
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

async function processJob(job: Job): Promise<void> {
  // Route to appropriate processor based on job type
  if (job.jobType === 'security') {
    await processSecurityScan(job as SecurityScanJob);
  } else if (job.jobType === 'function') {
    await processFunctionScan(job as FunctionScanJob);
  } else {
    throw new Error(`Unknown job type: ${(job as any).jobType}`);
  }
}

async function processSecurityScan(job: SecurityScanJob): Promise<void> {
  console.log(`Processing security scan job: ${job.scanId}`);

  try {
    // Get authentication token
    let token: string | undefined = job.token;

    // If no token provided, try to get it from GitHub App installation
    if (!token && job.installationId) {
      console.log(`Fetching installation token for installation: ${job.installationId}`);
      token = await getInstallationToken(job.installationId);
    } else if (!token) {
      // Try to get installation ID from repo record
      console.log(`No token or installationId provided, looking up repo installation...`);
      const repo = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, job.repoId),
        with: {
          installation: true,
        },
      });

      if (repo?.installation?.installationId) {
        console.log(`Found installation ID from repo: ${repo.installation.installationId}`);
        token = await getInstallationToken(repo.installation.installationId);
      } else {
        console.warn(`No authentication available for repo ${job.repoId}. Will attempt to download as public repo.`);
      }
    }

    // Run the security scan
    const scanResult = await runSecurityScan({
      repoId: job.repoId,
      repoUrl: job.repoUrl,
      branch: job.branch,
      token: token,
    });

    // Update scan record with results
    console.log(`Updating scan ${job.scanId} to completed status`);
    await db
      .update(securityScans)
      .set({
        status: 'completed',
        toolsUsed: Array.isArray(scanResult.toolsUsed) ? scanResult.toolsUsed : [],
        scanDuration: scanResult.scanDuration,
        totalIssues: scanResult.summary.total,
        criticalCount: scanResult.summary.critical,
        highCount: scanResult.summary.high,
        mediumCount: scanResult.summary.medium,
        lowCount: scanResult.summary.low,
        infoCount: scanResult.summary.info,
        completedAt: scanResult.timestamp,
      })
      .where(eq(securityScans.scanId, job.scanId));

    // Save issues to database
    console.log(`Saving ${scanResult.issues?.length || 0} issues for scanId: ${job.scanId}`);
    if (Array.isArray(scanResult.issues) && scanResult.issues.length > 0) {
      await db.insert(securityIssues).values(
        scanResult.issues.map((issue) => ({
          scanId: job.scanId,
          tool: issue.tool,
          severity: issue.severity,
          title: issue.title,
          description: issue.description,
          filePath: issue.filePath,
          lineStart: issue.lineStart,
          lineEnd: issue.lineEnd,
          code: issue.code,
          recommendation: issue.recommendation,
          cwe: Array.isArray(issue.cwe) ? issue.cwe : [],
          owasp: Array.isArray(issue.owasp) ? issue.owasp : [],
        }))
      );
      console.log(`Successfully saved ${scanResult.issues.length} issues`);
    }

    console.log(`Successfully completed security scan job: ${job.scanId}`);
  } catch (error) {
    console.error('Error processing security scan job:', error);

    // Mark scan as failed
    await db
      .update(securityScans)
      .set({
        status: 'failed',
        completedAt: new Date(),
      })
      .where(eq(securityScans.scanId, job.scanId));
    console.log(`Marked scan ${job.scanId} as failed`);

    throw error; // Re-throw so HTTP handler returns 500
  }
}

async function processFunctionScan(job: FunctionScanJob): Promise<void> {
  console.log(`Processing function scan job: ${job.scanId}`);

  try {
    // Get authentication token (same logic as security scan)
    let token: string | undefined = job.token;

    if (!token && job.installationId) {
      console.log(`Fetching installation token for installation: ${job.installationId}`);
      token = await getInstallationToken(job.installationId);
    } else if (!token) {
      console.log(`No token or installationId provided, looking up repo installation...`);
      const repo = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, job.repoId),
        with: {
          installation: true,
        },
      });

      if (repo?.installation?.installationId) {
        console.log(`Found installation ID from repo: ${repo.installation.installationId}`);
        token = await getInstallationToken(repo.installation.installationId);
      } else {
        console.warn(`No authentication available for repo ${job.repoId}. Will attempt to download as public repo.`);
      }
    }

    // Run the function scan
    const scanResult = await runFunctionScan({
      repoId: job.repoId,
      repoUrl: job.repoUrl,
      branch: job.branch,
      token: token,
    });

    // Update scan record with results
    console.log(`Updating function scan ${job.scanId} to completed status`);
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
    console.log(`  Files: ${scanResult.filesProcessed}, Functions: ${scanResult.functionsDetected}, Duration: ${scanResult.scanDuration}ms`);
  } catch (error: any) {
    console.error('Error processing function scan job:', error);

    // Mark scan as failed
    await db
      .update(functionScans)
      .set({
        status: 'failed',
        errorMessage: error?.message || String(error),
        completedAt: new Date(),
      })
      .where(eq(functionScans.scanId, job.scanId));
    console.log(`Marked function scan ${job.scanId} as failed`);

    throw error; // Re-throw so HTTP handler returns 500
  }
}

// Create HTTP server to receive POST requests from Elastic Beanstalk SQS daemon (sqsd)
const server = http.createServer(async (req, res) => {
  // Health check endpoint
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Worker endpoint - sqsd posts to root path by default
  if (req.url === '/' && req.method === 'POST') {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const job: Job = JSON.parse(body);
        const jobType = job.jobType || 'security'; // Default to security for backwards compatibility
        const scanId = (job as any).scanId || 'unknown';
        console.log(`Received ${jobType} job from sqsd: ${scanId}`);

        await processJob(job);

        // Return 200 so sqsd deletes the message from queue
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, scanId, jobType }));
      } catch (error: any) {
        console.error('Error processing job:', error);

        // Return 500 so sqsd retries the message
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Processing failed' }));
      }
    });

    req.on('error', (error) => {
      console.error('Request error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request error' }));
    });

    return;
  }

  // Unknown endpoint
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Worker HTTP server listening on port ${PORT}`);
  console.log('Waiting for jobs from Elastic Beanstalk SQS daemon (sqsd)...');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
