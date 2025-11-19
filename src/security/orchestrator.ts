import { SecurityIssue, SecurityScanResult } from './types';
import { runSemgrep } from './scanners/semgrep';
import { runOpengrep } from './scanners/opengrep';
import { runGitleaks } from './scanners/gitleaks';
import { runCheckov } from './scanners/checkov';
import { runTrivy } from './scanners/trivy';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { downloadRepoAsZip } from '../github/zip-download';

const execAsync = promisify(exec);

export interface ScanOptions {
  repoId: number;
  repoUrl: string;
  branch: string;
  token?: string;
  skipTools?: ('semgrep' | 'opengrep' | 'gitleaks' | 'checkov' | 'trivy')[];
}

export async function runSecurityScan(options: ScanOptions): Promise<SecurityScanResult> {
  const startTime = Date.now();
  const scanId = randomUUID();

  if (!options.repoUrl) {
    throw new Error('Repository URL is required');
  }

  // Download repository as zip instead of cloning to avoid GitHub API rate limits
  let repoDownload: { path: string; cleanup: () => Promise<void> } | undefined;
  let cleanupTimeout: NodeJS.Timeout | null = null;

  try {
    repoDownload = await downloadRepoAsZip({
      repoUrl: options.repoUrl,
      branch: options.branch,
      token: options.token,
    });

    const tempDir = repoDownload.path;

    // Set up aggressive cleanup timeout (15 minutes)
    // If scan takes longer than this, force cleanup to prevent memory leaks
    cleanupTimeout = setTimeout(async () => {
      console.warn(`Scan taking too long (>15min), forcing cleanup of ${tempDir}`);
      try {
        await repoDownload?.cleanup();
      } catch (err) {
        console.error('Failed to force cleanup:', err);
      }
    }, 15 * 60 * 1000);

    // Run all scanners in parallel with individual error handling
    const toolsToRun = ['semgrep', 'opengrep', 'gitleaks', 'checkov', 'trivy'].filter(
      (tool) => !options.skipTools?.includes(tool as any)
    );

    console.log(`Running security scanners: ${toolsToRun.join(', ')}`);

    const scanPromises: Promise<SecurityIssue[]>[] = [];

    // Wrap each scanner in its own error handler to prevent one failure from stopping all
    const scannerResults: { tool: string; issues: SecurityIssue[] }[] = [];

    if (toolsToRun.includes('semgrep')) {
      scanPromises.push(
        runSemgrep(tempDir)
          .then((issues) => {
            console.log(`✓ Semgrep completed: ${issues.length} issues found`);
            scannerResults.push({ tool: 'Semgrep', issues });
            return issues;
          })
          .catch((err) => {
            console.error('✗ Semgrep scan failed:', err);
            scannerResults.push({ tool: 'Semgrep', issues: [] });
            return [];
          })
      );
    }
    if (toolsToRun.includes('opengrep')) {
      scanPromises.push(
        runOpengrep(tempDir)
          .then((issues) => {
            console.log(`✓ OpenGrep completed: ${issues.length} issues found`);
            scannerResults.push({ tool: 'OpenGrep', issues });
            return issues;
          })
          .catch((err) => {
            console.error('✗ OpenGrep scan failed:', err);
            scannerResults.push({ tool: 'OpenGrep', issues: [] });
            return [];
          })
      );
    }
    if (toolsToRun.includes('gitleaks')) {
      scanPromises.push(
        runGitleaks(tempDir)
          .then((issues) => {
            console.log(`✓ Gitleaks completed: ${issues.length} issues found`);
            scannerResults.push({ tool: 'Gitleaks', issues });
            return issues;
          })
          .catch((err) => {
            console.error('✗ Gitleaks scan failed:', err);
            scannerResults.push({ tool: 'Gitleaks', issues: [] });
            return [];
          })
      );
    }
    if (toolsToRun.includes('checkov')) {
      scanPromises.push(
        runCheckov(tempDir)
          .then((issues) => {
            console.log(`✓ Checkov completed: ${issues.length} issues found`);
            scannerResults.push({ tool: 'Checkov', issues });
            return issues;
          })
          .catch((err) => {
            console.error('✗ Checkov scan failed:', err);
            scannerResults.push({ tool: 'Checkov', issues: [] });
            return [];
          })
      );
    }
    if (toolsToRun.includes('trivy')) {
      scanPromises.push(
        runTrivy(tempDir)
          .then((issues) => {
            console.log(`✓ Trivy completed: ${issues.length} issues found`);
            scannerResults.push({ tool: 'Trivy', issues });
            return issues;
          })
          .catch((err) => {
            console.error('✗ Trivy scan failed:', err);
            scannerResults.push({ tool: 'Trivy', issues: [] });
            return [];
          })
      );
    }

    // Wait for all scans to complete
    const results = await Promise.all(scanPromises);
    const allIssues = results.flat();

    // Print detailed breakdown
    console.log('\n=== Security Scan Results ===');
    for (const { tool, issues } of scannerResults) {
      const severityCounts = {
        critical: issues.filter(i => i.severity === 'critical').length,
        high: issues.filter(i => i.severity === 'high').length,
        medium: issues.filter(i => i.severity === 'medium').length,
        low: issues.filter(i => i.severity === 'low').length,
        info: issues.filter(i => i.severity === 'info').length,
      };

      console.log(`\n${tool}:`);
      console.log(`  Total: ${issues.length} issues`);
      if (issues.length > 0) {
        console.log(`  Critical: ${severityCounts.critical}`);
        console.log(`  High: ${severityCounts.high}`);
        console.log(`  Medium: ${severityCounts.medium}`);
        console.log(`  Low: ${severityCounts.low}`);
        console.log(`  Info: ${severityCounts.info}`);
      }
    }
    console.log('\n=============================\n');

    console.log(`Scan complete. Total issues found: ${allIssues.length}`);

    // Strip temp directory path from file paths
    const cleanedIssues = allIssues.map(issue => ({
      ...issue,
      filePath: issue.filePath.replace(tempDir + '/', '').replace(tempDir, '')
    }));

    // Calculate summary
    const summary = {
      critical: cleanedIssues.filter((i) => i.severity === 'critical').length,
      high: cleanedIssues.filter((i) => i.severity === 'high').length,
      medium: cleanedIssues.filter((i) => i.severity === 'medium').length,
      low: cleanedIssues.filter((i) => i.severity === 'low').length,
      info: cleanedIssues.filter((i) => i.severity === 'info').length,
      total: cleanedIssues.length
    };

    const scanDuration = Date.now() - startTime;

    const result = {
      repoId: options.repoId,
      branch: options.branch,
      scanId,
      timestamp: new Date(),
      issues: cleanedIssues,
      summary,
      scanDuration,
      toolsUsed: toolsToRun
    };

    console.log(`Scan result: ${cleanedIssues.length} issues, ${scanDuration}ms, tools: ${toolsToRun.join(', ')}`);
    return result;
  } finally {
    // Clear the cleanup timeout
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
    }

    // Cleanup: Remove temp directory
    if (repoDownload) {
      await repoDownload.cleanup();
    }
  }
}

export async function checkToolsInstalled(): Promise<{
  semgrep: boolean;
  opengrep: boolean;
  gitleaks: boolean;
  checkov: boolean;
  trivy: boolean;
}> {
  const checkTool = async (tool: string): Promise<boolean> => {
    try {
      await execAsync(`which ${tool}`);
      return true;
    } catch {
      return false;
    }
  };

  const [semgrep, opengrep, gitleaks, checkov, trivy] = await Promise.all([
    checkTool('semgrep'),
    checkTool('opengrep'),
    checkTool('gitleaks'),
    checkTool('checkov'),
    checkTool('trivy')
  ]);

  return { semgrep, opengrep, gitleaks, checkov, trivy };
}
