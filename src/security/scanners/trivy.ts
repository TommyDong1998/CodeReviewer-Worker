import { exec } from 'child_process';
import { promisify } from 'util';
import { SecurityIssue, SecuritySeverity } from '../types';

const execAsync = promisify(exec);

interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Title: string;
  Description: string;
  PrimaryURL?: string;
}

interface TrivyResult {
  Target: string;
  Vulnerabilities?: TrivyVulnerability[];
}

interface TrivyOutput {
  Results: TrivyResult[];
}

export async function runTrivy(repoPath: string): Promise<SecurityIssue[]> {
  try {
    // Check if trivy is installed
    await execAsync('which trivy');
  } catch {
    console.warn('Trivy not installed, skipping scan');
    return [];
  }

  try {
    // Run trivy filesystem scan with timeout
    // Using --scanners vuln to explicitly scan for vulnerabilities
    // --skip-dirs to avoid scanning large node_modules, etc.
    const { stdout, stderr } = await execAsync(
      `trivy fs --format json --quiet --scanners vuln --skip-dirs "node_modules,.git" "${repoPath}"`,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 600000, // 10 minutes timeout for large projects
        killSignal: 'SIGKILL'
      }
    );

    if (!stdout.trim()) {
      console.log('Trivy returned empty output, no vulnerabilities found');
      return [];
    }

    let results: TrivyOutput;
    try {
      results = JSON.parse(stdout);
    } catch (parseError) {
      console.error('Trivy: Failed to parse JSON output');
      console.error('Trivy stdout (first 500 chars):', stdout.substring(0, 500));
      console.error('Trivy stderr:', stderr);
      return [];
    }

    const issues: SecurityIssue[] = [];

    // Ensure Results exists and is iterable
    if (!results.Results || !Array.isArray(results.Results)) {
      console.warn('Trivy: Results is not an array or is missing', {
        resultsType: typeof results.Results,
        hasResults: 'Results' in results,
        outputKeys: Object.keys(results),
        schemaVersion: (results as any).SchemaVersion
      });

      // Trivy might return an empty scan with no Results key
      // This is okay - just means no vulnerabilities found
      console.log('Trivy scan completed with no vulnerabilities');
      return [];
    }

    for (const result of results.Results) {
      // Skip results with no vulnerabilities
      if (!result.Vulnerabilities || !Array.isArray(result.Vulnerabilities)) {
        continue;
      }

      for (const vuln of result.Vulnerabilities) {
        issues.push({
          tool: 'trivy' as const,
          severity: mapTrivySeverity(vuln.Severity),
          title: `${vuln.VulnerabilityID}: ${vuln.PkgName}`,
          description: vuln.Title || vuln.Description,
          filePath: result.Target,
          lineStart: 1, // Trivy doesn't provide line numbers for dependencies
          recommendation: vuln.FixedVersion
            ? `Update ${vuln.PkgName} from ${vuln.InstalledVersion} to ${vuln.FixedVersion}`
            : `No fix available yet for ${vuln.PkgName}. Monitor for updates.`,
          owasp: ['A06:2021-Vulnerable and Outdated Components']
        } satisfies SecurityIssue);
      }
    }

    console.log(`Trivy scan found ${issues.length} vulnerability issues`);
    return issues;
  } catch (error: any) {
    if (error.killed || error.signal) {
      console.warn(`Trivy scan was terminated (signal: ${error.signal || 'unknown'}). This usually means it took too long. Skipping Trivy results.`);
    } else {
      console.error('Trivy scan failed:', error.message || error);
    }
    return [];
  }
}

function mapTrivySeverity(severity: string): SecuritySeverity {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'info';
  }
}
