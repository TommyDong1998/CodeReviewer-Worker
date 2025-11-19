import { exec } from 'child_process';
import { promisify } from 'util';
import { SecurityIssue } from '../types';

const execAsync = promisify(exec);

interface GitleaksFinding {
  Description: string;
  StartLine: number;
  EndLine: number;
  File: string;
  Secret: string;
  RuleID: string;
}

export async function runGitleaks(repoPath: string): Promise<SecurityIssue[]> {
  try {
    // Check if gitleaks is installed
    await execAsync('which gitleaks');
  } catch {
    console.warn('Gitleaks not installed, skipping scan');
    return [];
  }

  try {
    // Run gitleaks detect with timeout
    const { stdout } = await execAsync(
      `gitleaks detect --source "${repoPath}" --report-format json --report-path /dev/stdout --no-git || true`,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 600000, // 10 minutes timeout for large projects
        killSignal: 'SIGKILL'
      }
    );

    if (!stdout.trim()) {
      return [];
    }

    const results = JSON.parse(stdout);

    return results.map((finding: GitleaksFinding) => ({
      tool: 'gitleaks' as const,
      severity: 'critical' as const, // All secrets are critical
      title: `Secret Detected: ${finding.RuleID}`,
      description: finding.Description,
      filePath: finding.File,
      lineStart: finding.StartLine,
      lineEnd: finding.EndLine,
      code: maskSecret(finding.Secret),
      recommendation: 'Immediately rotate this secret and remove it from version control history. Use environment variables or secret management services.',
      owasp: ['A02:2021-Cryptographic Failures']
    } satisfies SecurityIssue));
  } catch (error: any) {
    if (error.killed || error.signal) {
      console.warn(`Gitleaks scan was terminated (signal: ${error.signal || 'unknown'}). Skipping Gitleaks results.`);
    } else {
      console.error('Gitleaks scan failed:', error.message || error);
    }
    return [];
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return '***';
  }
  return secret.substring(0, 4) + '***' + secret.substring(secret.length - 4);
}
