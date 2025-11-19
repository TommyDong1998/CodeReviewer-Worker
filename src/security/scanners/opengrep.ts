import { exec } from 'child_process';
import { promisify } from 'util';
import { SecurityIssue, SecuritySeverity } from '../types';

const execAsync = promisify(exec);

interface OpengrepFinding {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    metadata?: {
      cwe?: string[];
      owasp?: string[];
      category?: string;
    };
  };
}

export async function runOpengrep(repoPath: string): Promise<SecurityIssue[]> {
  try {
    // Check if opengrep is installed
    await execAsync('which opengrep');
  } catch {
    console.warn('OpenGrep not installed, skipping scan');
    return [];
  }

  try {
    // Run opengrep with Trail of Bits rules and timeout
    const { stdout } = await execAsync(
      `opengrep --config=p/trailofbits --json --quiet "${repoPath}"`,
      {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 600000, // 10 minutes timeout for large projects
        killSignal: 'SIGKILL'
      }
    );

    const results = JSON.parse(stdout);

    return results.results?.map((finding: OpengrepFinding) => {
      const severity = mapOpengrepSeverity(finding.extra.severity);

      return {
        tool: 'opengrep' as const,
        severity,
        title: finding.check_id,
        description: finding.extra.message,
        filePath: finding.path,
        lineStart: finding.start.line,
        lineEnd: finding.end.line,
        cwe: finding.extra.metadata?.cwe,
        owasp: finding.extra.metadata?.owasp,
        recommendation: generateRecommendation(finding)
      } satisfies SecurityIssue;
    }) || [];
  } catch (error: any) {
    if (error.killed || error.signal) {
      console.warn(`OpenGrep scan was terminated (signal: ${error.signal || 'unknown'}). This usually means it took too long. Skipping OpenGrep results.`);
    } else {
      console.error('OpenGrep scan failed:', error.message || error);
    }
    return [];
  }
}

function mapOpengrepSeverity(severity: string): SecuritySeverity {
  switch (severity.toLowerCase()) {
    case 'error':
    case 'critical':
      return 'critical';
    case 'warning':
      return 'high';
    case 'info':
      return 'medium';
    default:
      return 'low';
  }
}

function generateRecommendation(finding: OpengrepFinding): string {
  const category = finding.extra.metadata?.category;

  if (category?.includes('injection')) {
    return 'Use parameterized queries or prepared statements to prevent injection attacks.';
  }
  if (category?.includes('xss')) {
    return 'Sanitize and escape user input before rendering. Use a templating engine with auto-escaping.';
  }
  if (category?.includes('crypto')) {
    return 'Use industry-standard cryptographic libraries. Avoid deprecated algorithms like MD5 or SHA1.';
  }

  return 'Review the code and apply security best practices. Consult OWASP guidelines for specific recommendations.';
}
