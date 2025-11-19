export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityIssue {
  tool: 'semgrep' | 'opengrep' | 'gitleaks' | 'checkov' | 'trivy' | 'llm';
  severity: SecuritySeverity;
  title: string;
  description: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  code?: string;
  recommendation?: string;
  cwe?: string[];
  owasp?: string[];
}

export interface SecurityScanResult {
  repoId: number;
  branch: string;
  scanId: string;
  timestamp: Date;
  issues: SecurityIssue[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  scanDuration: number;
  toolsUsed: string[];
}

export interface ScanQuota {
  userId: number;
  teamId: number;
  tier: 'free' | 'plus' | 'pro';
  scansUsed: number;
  scansLimit: number;
  resetDate: Date;
}
