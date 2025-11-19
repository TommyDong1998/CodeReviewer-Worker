import { exec } from 'child_process';
import { promisify } from 'util';
import { SecurityIssue, SecuritySeverity } from '../types';

const execAsync = promisify(exec);

interface CheckovFinding {
  check_id: string;
  check_name: string;
  file_path: string;
  file_line_range: [number, number];
  resource: string;
  evaluations: null;
  check_class: string;
  guideline?: string;
}

interface CheckovResult {
  results: {
    failed_checks: CheckovFinding[];
  };
}

export async function runCheckov(repoPath: string): Promise<SecurityIssue[]> {
  try {
    // Check if checkov is installed
    await execAsync('which checkov');
  } catch {
    console.warn('Checkov not installed, skipping scan');
    return [];
  }

  try {
    // Run checkov on common IaC files with timeout
    // Checkov can be slow on large repos, allow up to 10 minutes
    const { stdout } = await execAsync(
      `checkov --directory "${repoPath}" --output json --quiet --compact || true`,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 600000, // 10 minutes timeout for large projects
        killSignal: 'SIGKILL' // Force kill if timeout
      }
    );

    if (!stdout.trim()) {
      return [];
    }

    let parsedOutput = JSON.parse(stdout);

    // Checkov can return either a single object or an array of objects
    // Normalize it to always be an array
    const results: CheckovResult[] = Array.isArray(parsedOutput) ? parsedOutput : [parsedOutput];

    const issues: SecurityIssue[] = [];

    for (const result of results) {
      if (result.results?.failed_checks && Array.isArray(result.results.failed_checks)) {
        for (const finding of result.results.failed_checks) {
          issues.push({
            tool: 'checkov' as const,
            severity: mapCheckovSeverity(finding.check_class),
            title: finding.check_name,
            description: `Infrastructure misconfiguration detected in ${finding.resource}`,
            filePath: finding.file_path,
            lineStart: finding.file_line_range[0],
            lineEnd: finding.file_line_range[1],
            recommendation: finding.guideline || 'Follow infrastructure security best practices. Review cloud provider security documentation.',
            owasp: ['A05:2021-Security Misconfiguration']
          } satisfies SecurityIssue);
        }
      }
    }

    return issues;
  } catch (error: any) {
    // Handle timeout and termination gracefully
    if (error.killed || error.signal) {
      console.warn(`Checkov scan was terminated (signal: ${error.signal || 'unknown'}). This usually means it took too long or used too much memory. Skipping Checkov results.`);
    } else {
      console.error('Checkov scan failed:', error.message || error);
    }
    return [];
  }
}

function mapCheckovSeverity(checkClass: string): SecuritySeverity {
  if (checkClass.includes('CRITICAL')) return 'critical';
  if (checkClass.includes('HIGH')) return 'high';
  if (checkClass.includes('MEDIUM')) return 'medium';
  if (checkClass.includes('LOW')) return 'low';
  return 'medium'; // Default
}
