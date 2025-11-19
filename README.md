# CodeReviewer Worker

This is the worker environment for the CodeReviewer application. It handles long-running security scan tasks via an SQS queue.

## Architecture

The worker environment:
- **HTTP server** that receives POST requests from Elastic Beanstalk's SQS daemon (sqsd)
- sqsd automatically polls the SQS queue and forwards messages as HTTP POST requests
- Runs security scanning tools (Semgrep, OpenGrep, Gitleaks, Checkov, Trivy)
- Updates scan results in the PostgreSQL database
- Runs on AWS Elastic Beanstalk Worker tier with t4g.medium instances

### How Elastic Beanstalk Worker Tier Works

```
SQS Queue → sqsd (Beanstalk daemon) → HTTP POST → Worker App
                                                        ↓
                                                   Process Job
                                                        ↓
                                         Return 200 OK / 500 Error
                                                        ↓
                                    sqsd deletes message (if 200)
                                    or retries (if 500)
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables (`.env`):
```bash
POSTGRES_URL=postgresql://user:password@host:port/database
PORT=8080
```

**Note**: SQS queue configuration is handled by Elastic Beanstalk's sqsd daemon, not by the application directly.

3. Build:
```bash
npm run build
```

4. Run locally (for testing):
```bash
npm run dev
```

## Deployment

The worker is deployed to AWS Elastic Beanstalk Worker tier via the infrastructure in `CodeReviewerInfra/elastic_beanstalk_worker.tf`.

### Manual Deployment

1. Build the application:
```bash
npm run build
```

2. Create a deployment package:
```bash
zip -r worker-deploy.zip package.json dist/ src/ .ebextensions/ Dockerfile
```

3. Deploy to Elastic Beanstalk:
```bash
eb deploy codereview-production-worker
```

## Security Tools

The worker environment includes the following security scanning tools:
- **Semgrep**: SAST using Trail of Bits rules
- **OpenGrep**: Fast SAST fork of Semgrep
- **Gitleaks**: Secret and credential detection
- **Checkov**: Infrastructure as Code scanning
- **Trivy**: Dependency vulnerability scanning

All tools are installed via `.ebextensions/01_security_tools.config`.

## Job Processing

The worker receives HTTP POST requests from sqsd with the job in the request body:

```json
{
  "scanId": "scan_123456_abc",
  "repoId": 1,
  "repoUrl": "https://github.com/owner/repo.git",
  "branch": "main",
  "token": "ghp_..."
}
```

The worker:
1. Receives HTTP POST request from sqsd (on port 8080, path `/`)
2. Parses the job from the request body
3. Downloads the repository
4. Runs all security scanners in parallel
5. Updates the database with results
6. Returns HTTP 200 (success) or 500 (failure)
7. sqsd automatically deletes the message from SQS if 200, or retries if 500

## Monitoring

- CloudWatch Logs: `/aws/elasticbeanstalk/codereview-production-worker/`
- CloudWatch Alarms:
  - `codereview-production-sqs-dlq-messages`: Alerts when messages appear in the dead letter queue
  - `codereview-production-sqs-message-age`: Alerts when messages are not being processed

## Troubleshooting

### Worker not processing messages

1. Check CloudWatch Logs for errors
2. Verify worker HTTP server is running (should see "Worker HTTP server listening on port 8080")
3. Check sqsd is configured correctly in Beanstalk worker settings
4. Verify security tools are installed correctly
5. Test the worker endpoint manually: `curl -X POST http://localhost:8080/ -d '{"scanId":"test","repoId":1,...}'`

### Security scans timing out

The worker has a 1-hour timeout for each scan job. If scans are taking longer:
1. Increase the SQS visibility timeout
2. Increase the worker instance size
3. Optimize the scan configuration (skip certain tools)

## Development

### Adding a new security scanner

1. Create a new scanner file in `src/security/scanners/`
2. Add the scanner to `orchestrator.ts`
3. Update `.ebextensions/01_security_tools.config` to install the tool
4. Update the Dockerfile to include the tool installation
