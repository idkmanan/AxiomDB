# Getting Started

This section contains guides for getting up and running with the Acquisitions project.

## Quick Start

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd acquisitions
   npm install
   ```

2. **Set Up Environment**
   ```bash
   cp .env.example .env.development
   # Edit .env.development with your database URL and secrets
   ```

3. **Run Migrations**
   ```bash
   npm run db:migrate
   ```

4. **Start Development Server**
   ```bash
   npm run dev
   ```

## Guides

- [Benchmarking Guide](./benchmarking-guide.md) - How to reproduce latency numbers and benchmark methodology

## Navigation

Return to [Documentation Index](../README.md)
