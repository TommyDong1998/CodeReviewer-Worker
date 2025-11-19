# syntax=docker/dockerfile:1.4
FROM amazonlinux:2023 AS base

# Install base dependencies
RUN dnf update -y && \
    dnf install -y --allowerasing \
    curl \
    tar \
    gzip \
    make \
    gcc-c++ \
    python3 \
    python3-pip \
    git \
    wget && \
    dnf clean all

# Install Node.js 20
RUN curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && \
    dnf install -y nodejs && \
    dnf clean all

# Enable pnpm through Corepack
RUN corepack enable pnpm

# Configure pip for better timeout handling
RUN pip3 config set global.timeout 300 && \
    pip3 config set global.retries 5

# Install security scanning tools one at a time for better reliability
RUN echo "Installing Semgrep..." && \
    pip3 install --no-cache-dir --ignore-installed requests semgrep==1.85.0 && \
    semgrep --version

RUN echo "Installing OpenGrep..." && \
    (curl -sSLf https://github.com/opengrep/opengrep/releases/latest/download/opengrep-core_linux_x86.tar.gz -o opengrep.tar.gz || \
     curl -sSLf https://github.com/opengrep/opengrep/releases/download/v1.11.5/opengrep-core_linux_x86.tar.gz -o opengrep.tar.gz) && \
    tar -xzf opengrep.tar.gz && \
    find . -name "opengrep" -type f -exec mv {} /usr/local/bin/opengrep \; && \
    chmod +x /usr/local/bin/opengrep && \
    rm -rf opengrep.tar.gz opengrep-core* && \
    opengrep --version || echo "⚠ OpenGrep installation failed, continuing without it"

RUN echo "Installing Checkov..." && \
    pip3 install --no-cache-dir checkov && \
    checkov --version

RUN echo "Installing Gitleaks..." && \
    curl -sSL https://github.com/zricethezav/gitleaks/releases/download/v8.18.2/gitleaks_8.18.2_linux_x64.tar.gz \
      -o gitleaks.tar.gz && \
    tar -xzf gitleaks.tar.gz && \
    mv $(find . -type f -name 'gitleaks' -perm +111 | head -n1) /usr/local/bin/gitleaks && \
    rm gitleaks.tar.gz && \
    gitleaks version

RUN echo "Installing Trivy..." && \
    wget -q https://github.com/aquasecurity/trivy/releases/download/v0.48.3/trivy_0.48.3_Linux-64bit.tar.gz && \
    tar -xzf trivy_0.48.3_Linux-64bit.tar.gz && \
    mv trivy /usr/local/bin/ && \
    rm -f trivy_0.48.3_Linux-64bit.tar.gz && \
    trivy --version

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install dependencies
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

# Copy application code
COPY . .

# Build TypeScript
RUN npm run build

# Start the worker
CMD ["npm", "start"]
