# Acquisitions API - Docker Development & Production Guide

This document explains how to run the Acquisitions Express.js API with Docker in both development (using Neon Local) and production (using Neon Cloud) environments.

---

## Quick Start

### Development (with Neon Local)
```bash
# Start everything (app + Neon Local Postgres)
docker-compose -f docker-compose.dev.yml up --build

# Or run in background
docker-compose -f docker-compose.dev.yml up -d --build

# View logs
docker-compose -f docker-compose.dev.yml logs -f app

# Stop and remove volumes (clean slate)
docker-compose -f docker-compose.dev.yml down -v
```

### Production (with Neon Cloud)
```bash
# Set required environment variables first (see Production Setup)
export DATABASE_URL="postgres://user:pass@ep-xxx.neon.tech/db?sslmode=require"
export JWT_SECRET="$(openssl rand -base64 32)"
export COOKIE_SECRET="$(openssl rand -base64 32)"

# Build and start
docker-compose -f docker-compose.prod.yml up --build -d

# View logs
docker-compose -f docker-compose.prod.yml logs -f app
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEVELOPMENT                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐                                     │
│  │   Host       │     │   Docker     │                                     │
│  │   Machine    │     │   Network    │                                     │
│  │              │     │              │                                     │
│  │  localhost:3000 ──────►  app:3000  │                                     │
│  │  localhost:5432 ──────►neon-local:5432                                │
│  │              │     │              │                                     │
│  └──────────────┘     └──────────────┘                                     │
│         │                     │                                            │
│         ▼                     ▼                                            │
│  ┌──────────────────────────────────────────┐                              │
│  │         docker-compose.dev.yml           │                              │
│  │  ┌─────────────┐    ┌─────────────────┐  │                              │
│  │  │    app      │───►│   neon-local    │  │                              │
│  │  │ (Node.js)   │    │  (Neon Local)   │  │                              │
│  │  │             │    │  - Auto branches│  │                              │
│  │  │ --watch     │    │  - Ephemeral DB │  │                              │
│  │  └─────────────┘    └─────────────────┘  │                              │
│  └──────────────────────────────────────────┘                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRODUCTION                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐                                     │
│  │   Internet   │     │   Docker     │                                     │
│  │              │     │   Network    │                                     │
│  │  HTTPS:443   │     │              │                                     │
│  │     │        │     │   app:3000   │                                     │
│  │     ▼        │     │       │      │                                     │
│  │ ┌────────┐   │     │       ▼      │                                     │
│  │ │ Reverse│   │     │ ┌─────────┐  │                                     │
│  │ │ Proxy  │───┼─────►│ │  app    │  │                                     │
│  │ │(nginx/ │   │     │ │ (Node.js)│  │                                     │
│  │ │Traefik)│   │     │ └────┬────┘  │                                     │
│  │ └────────┘   │     │      │       │                                     │
│  └──────│───────┘     └──────│───────┘                                     │
│         │                    │                                             │
│         ▼                    ▼                                             │
│  ┌──────────────────────────────────────────┐                              │
│  │         docker-compose.prod.yml          │                              │
│  │  ┌─────────────┐                         │                              │
│  │  │    app      │──────► Neon Cloud DB   │                              │
│  │  │ (Node.js)   │    (DATABASE_URL)      │                              │
│  │  └─────────────┘                         │                              │
│  └──────────────────────────────────────────┘                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Development Environment

### Prerequisites
- Docker Desktop / Docker Engine 24+
- Docker Compose v2+
- (Optional) Neon API Key for branch management

### Files
| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (base, deps, dev-deps, builder, development, production) |
| `docker-compose.dev.yml` | Runs app + Neon Local |
| `.env.development` | Development environment variables |
| `.dockerignore` | Excludes unnecessary files from build context |

### Neon Local Details

Neon Local (`neondatabase/neon-local`) provides:
- **Ephemeral branches**: Automatic branch creation for each dev session
- **PostgreSQL compatible**: Connects via standard `postgres://` URL
- **No cloud dependency**: Runs entirely locally
- **Data persistence**: Optional via Docker volume

**Connection String (inside Docker network):**
```
postgres://neon:npg@neon-local:5432/neondb?sslmode=disable
```

**Connection String (from host machine):**
```
postgres://neon:npg@localhost:5432/neondb?sslmode=disable
```

### Starting Development

```bash
# 1. Build and start all services
docker-compose -f docker-compose.dev.yml up --build

# 2. Verify services are healthy
docker-compose -f docker-compose.dev.yml ps

# Expected output:
# NAME                    STATUS              PORTS
# acquisitions-neon-local Up (healthy)        5432/tcp, 5433/tcp
# acquisitions-app-dev    Up                  0.0.0.0:3000->3000/tcp

# 3. Test the API
curl http://localhost:3000/health
# {"status":"Ok","timestamp":"...","uptime":...}

curl http://localhost:3000/api/auth/sign-up \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","password":"password123"}'
```

### Database Access

```bash
# Connect via psql (from host)
psql "postgres://neon:npg@localhost:5432/neondb?sslmode=disable"

# Or from inside app container
docker-compose -f docker-compose.dev.yml exec app \
  psql "postgres://neon:npg@neon-local:5432/neondb?sslmode=disable"

# Run Drizzle migrations
docker-compose -f docker-compose.dev.yml exec app npm run db:migrate

# Open Drizzle Studio
docker-compose -f docker-compose.dev.yml exec app npm run db:studio
# Then open http://localhost:4983
```

### Hot Reload

The development container uses Node.js `--watch` flag (Node 18.11+). Changes to source files automatically restart the server.

```bash
# View live logs
docker-compose -f docker-compose.dev.yml logs -f app
```

### Environment Variables (Development)

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `3000` | Server port |
| `DATABASE_URL` | `postgres://neon:npg@neon-local:5432/neondb?sslmode=disable` | Neon Local connection |
| `JWT_SECRET` | `dev-secret...` | JWT signing key |
| `JWT_EXPIRES_IN` | `15m` | Token expiration |
| `LOG_LEVEL` | `debug` | Winston log level |

Override via `.env.local` (gitignored):
```bash
cp .env.development .env.local
# Edit .env.local with your values
```

---

## Production Environment

### Prerequisites
- Neon Cloud account with project created
- Domain name with DNS configured
- SSL certificates (Let's Encrypt, Cloudflare, or managed by platform)
- Container registry (Docker Hub, GHCR, ECR, etc.) or direct build on server

### Required Secrets

**NEVER commit these to git.** Use your platform's secret management:

| Secret | Description | Example |
|--------|-------------|---------|
| `DATABASE_URL` | Neon Cloud connection string | `postgres://user:pass@ep-xxx.neon.tech/db?sslmode=require` |
| `JWT_SECRET` | Min 32 chars, base64 | `openssl rand -base64 32` |
| `COOKIE_SECRET` | Random string | `openssl rand -base64 32` |
| `ARCJET_KEY` | (Optional) Arcjet API key | `ajkey_...` |

### Neon Cloud Setup

1. Create project at [console.neon.tech](https://console.neon.tech)
2. Get connection string from Dashboard → Connection Details
3. Enable **SSL mode: require** (default for Neon Cloud)
4. Configure IP allowlist or use Neon's secure proxy

### Building Production Image

```bash
# Build locally
docker build -t acquisitions-api:latest --target production .

# Or with BuildKit for faster builds
DOCKER_BUILDKIT=1 docker build -t acquisitions-api:latest --target production .

# Multi-platform (for ARM servers)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t acquisitions-api:latest --target production --push .
```

### Running with Docker Compose (Production)

```bash
# 1. Create .env.production with your secrets (or use platform secrets)
cat > .env.production <<'EOF'
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
DATABASE_URL=postgres://user:pass@ep-xxx.neon.tech/db?sslmode=require
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
COOKIE_SECRET=your-cookie-secret
CORS_ORIGIN=https://yourdomain.com
EOF

# 2. Start
docker-compose -f docker-compose.prod.yml up -d --build

# 3. Verify
docker-compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

### Production Deployment Options

#### Option 1: Docker Compose on VM (DigitalOcean, AWS EC2, etc.)
```bash
# On server
git clone <repo>
cd acquisitions
# Set secrets via environment or .env.production (chmod 600!)
docker-compose -f docker-compose.prod.yml up -d --build

# Add systemd service for auto-restart
sudo tee /etc/systemd/system/acquisitions.service <<'EOF'
[Unit]
Description=Acquisitions API
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/acquisitions
ExecStart=/usr/bin/docker-compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker-compose -f docker-compose.prod.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now acquisitions
```

#### Option 2: Railway / Render / Fly.io
```bash
# Railway
railway login
railway link
railway up

# Set secrets in Railway dashboard:
# DATABASE_URL, JWT_SECRET, COOKIE_SECRET

# Fly.io
fly launch
fly secrets set DATABASE_URL=... JWT_SECRET=... COOKIE_SECRET=...
fly deploy
```

#### Option 3: Kubernetes (Helm/Kustomize)
```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: acquisitions-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: acquisitions-api
  template:
    metadata:
      labels:
        app: acquisitions-api
    spec:
      containers:
      - name: app
        image: ghcr.io/yourusername/acquisitions-api:latest
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: acquisitions-secrets
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 30
---
apiVersion: v1
kind: Secret
metadata:
  name: acquisitions-secrets
type: Opaque
stringData:
  DATABASE_URL: "postgres://..."
  JWT_SECRET: "..."
  COOKIE_SECRET: "..."
```

#### Option 4: Serverless (Vercel, Netlify, AWS Lambda)
> Note: Express.js requires adaptation for serverless (use `@vercel/node` or similar). Consider migrating to Hono or standard Web APIs for edge deployment.

---

## Environment Variable Reference

### Development (`.env.development`)
```env
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug
DATABASE_URL=postgres://neon:npg@neon-local:5432/neondb?sslmode=disable
JWT_SECRET=dev-secret-change-in-production-min-32-chars
JWT_EXPIRES_IN=15m
COOKIE_SECRET=dev-cookie-secret-change-in-production
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
```

### Production (`.env.production` - template only!)
```env
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
# DATABASE_URL=postgres://user:pass@ep-xxx.neon.tech/db?sslmode=require
# JWT_SECRET=generate-with-openssl-rand-base64-32
# COOKIE_SECRET=generate-with-openssl-rand-base64-32
# ARCJET_KEY=ajkey_your_key
# CORS_ORIGIN=https://yourdomain.com
```

### Switching Between Environments

The `DATABASE_URL` is the key differentiator:

| Environment | DATABASE_URL |
|-------------|--------------|
| **Local Dev** | `postgres://neon:npg@neon-local:5432/neondb?sslmode=disable` |
| **CI/Test** | `postgres://neon:npg@neon-local:5432/neondb?sslmode=disable` (Neon Local in CI) |
| **Staging** | `postgres://user:pass@ep-staging.neon.tech/db?sslmode=require` |
| **Production** | `postgres://user:pass@ep-prod.neon.tech/db?sslmode=require` |

---

## Dockerfile Details

### Multi-Stage Build Stages

| Stage | Base | Purpose | Output |
|-------|------|---------|--------|
| `base` | `node:22-alpine` | Common setup, non-root user | Base image |
| `deps` | `base` | Production `npm ci` | `node_modules` (prod only) |
| `dev-deps` | `base` | Full `npm ci` (incl. dev) | `node_modules` (all) |
| `builder` | `dev-deps` | Build steps (TypeScript, etc.) | Built artifacts |
| `development` | `dev-deps` | **Dev runtime** with hot reload | Dev server |
| `production` | `base` | **Prod runtime** (minimal) | Production server |

### Key Features
- **Non-root user**: Runs as `nodejs` (UID 1001)
- **Minimal attack surface**: Alpine Linux, no build tools in prod
- **Proper init**: Uses `tini` for signal handling
- **Health checks**: Built-in `/health` endpoint
- **Layer caching**: Dependencies copied before source
- **BuildKit ready**: Uses modern Docker features

---

## Common Commands Reference

### Development
```bash
# Start with build
docker-compose -f docker-compose.dev.yml up --build

# Start detached
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f app

# Execute command in container
docker-compose -f docker-compose.dev.yml exec app npm run db:migrate
docker-compose -f docker-compose.dev.yml exec app npm run db:studio
docker-compose -f docker-compose.dev.yml exec app sh

# Stop (keep volumes)
docker-compose -f docker-compose.dev.yml down

# Stop and remove volumes (clean slate)
docker-compose -f docker-compose.dev.yml down -v

# Rebuild single service
docker-compose -f docker-compose.dev.yml up --build --no-deps app
```

### Production
```bash
# Build production image
docker build -t acquisitions-api:prod --target production .

# Run standalone (with env vars)
docker run -d \
  --name acquisitions-api \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="..." \
  -e JWT_SECRET="..." \
  -e COOKIE_SECRET="..." \
  acquisitions-api:prod

# With compose
docker-compose -f docker-compose.prod.yml up -d --build

# Scale (if using swarm/k8s)
docker-compose -f docker-compose.prod.yml up -d --scale app=3

# Update with zero downtime (rolling)
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d --no-deps app
```

### Debugging
```bash
# Inspect image layers
docker history acquisitions-api:prod

# Run shell in production image
docker run -it --rm --entrypoint sh acquisitions-api:prod

# Check health endpoint
curl http://localhost:3000/health

# View resource usage
docker stats acquisitions-app-dev
```

---

## Troubleshooting

### Neon Local Issues

**Problem**: `connection refused` to neon-local
```bash
# Check neon-local health
docker-compose -f docker-compose.dev.yml logs neon-local

# Verify it's ready
docker-compose -f docker-compose.dev.yml exec neon-local pg_isready -U neon -d neondb
```

**Problem**: Database not persisting
```bash
# Ensure volume exists
docker volume ls | grep neon-local

# Check volume mount
docker-compose -f docker-compose.dev.yml config | grep -A5 volumes
```

### Application Issues

**Problem**: `DATABASE_URL` not found
```bash
# Verify env file loaded
docker-compose -f docker-compose.dev.yml config | grep DATABASE_URL

# Check inside container
docker-compose -f docker-compose.dev.yml exec app env | grep DATABASE
```

**Problem**: Hot reload not working
```bash
# Ensure bind mount works
docker-compose -f docker-compose.dev.yml exec app ls -la /app/src

# Check Node version supports --watch
docker-compose -f docker-compose.dev.yml exec app node --version
# Need v18.11+
```

### Production Issues

**Problem**: Container exits immediately
```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs app

# Common causes:
# - Missing required env vars (DATABASE_URL, JWT_SECRET)
# - Database connection failed (check Neon Cloud IP allowlist)
# - Port already in use
```

**Problem**: Health check failing
```bash
# Test manually
docker-compose -f docker-compose.prod.yml exec app \
  node -e "require('http').get('http://localhost:3000/health', (r) => console.log(r.statusCode))"
```

---

## Security Checklist

- [ ] Use non-root user in Dockerfile (`nodejs:1001`)
- [ ] No secrets in images (use env vars / secrets manager)
- [ ] Enable `sslmode=require` for Neon Cloud
- [ ] Set strong `JWT_SECRET` (32+ chars, rotate periodically)
- [ ] Use `HttpOnly`, `Secure`, `SameSite=Strict` cookies
- [ ] Configure CORS to specific origins only
- [ ] Enable Helmet.js (already in app)
- [ ] Rate limiting via Arcjet (configured)
- [ ] Regular base image updates (`docker pull node:22-alpine`)
- [ ] Scan images: `docker scout cves acquisitions-api:prod`

---

## CI/CD Integration Example (GitHub Actions)

```yaml
# .github/workflows/docker.yml
name: Docker Build & Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=sha
      
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          target: production
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy-staging:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Deploy to staging
        run: |
          # Use your deployment method (Railway, Render, SSH, etc.)
          echo "Deploy to staging..."
```

---

## Resources

- [Neon Local Documentation](https://neon.com/docs/local/neon-local)
- [Neon Serverless Driver](https://github.com/neondatabase/serverless)
- [Docker Multi-stage Builds](https://docs.docker.com/build/building/multi-stage/)
- [Node.js Docker Best Practices](https://nodejs.org/en/docs/guides/nodejs-docker-webapp/)
- [Drizzle ORM with Neon](https://orm.drizzle.team/docs/get-started-postgresql#neon-serverless-driver)

---

## License

ISC License - See [LICENSE](LICENSE) for details.