# Deployment Guide: Acquisitions Backend Showcase

## Overview

This guide provides multiple deployment strategies for the Acquisitions distributed backend, ranging from $0/month (free tier) to $150/month (full Kubernetes), with recommendations for portfolio showcase purposes.

## Your Current Stack

**What You've Built:**
- Phases 1-7: Complete distributed backend
- Express + Postgres + Redis + Kafka + Kubernetes
- 50+ documented findings (F-01 through F-50)
- 8 Architecture Decision Records (ADRs)
- Measured performance: v0 (695ms p95) → v7 (6.06ms p95) = **99.1% improvement**
- Benchmark harness with reproducible results

## Deployment Options

### Option 1: Free Tier Showcase ($0/month)

**Best for:** Portfolio presence, interview prep, budget-conscious deployment

**Stack:**
- **API:** Render Free (sleeps after 15min idle, 512MB RAM)
- **Database:** Neon Free Tier (0.5GB, 3 compute hours/day)
- **Redis:** Upstash Free (10K commands/day, 256MB)
- **Skip:** Kafka (optional Phase 5)
- **Monitoring:** Dashboard artifact (static HTML)

**Pros:**
- Zero cost
- Demonstrates Phases 1-4 (core + Redis distributed features)
- Good enough for sharing live links

**Cons:**
- API cold starts (~30s) when idle
- Redis command limits may affect demos
- No Kafka event streaming showcase
- Not production-grade performance

**Setup Steps:**

1. **Deploy Database (Neon)**
   ```bash
   # Already have your connection string from .env.production
   # Run migrations
   npm run db:migrate
   
   # Seed demo data
   npm run bench:seed
   npm run db:seed:deals  # 1M deals for pagination demo
   ```

2. **Deploy Redis (Upstash)**
   - Sign up at https://upstash.com
   - Create Redis database (free tier)
   - Copy connection string
   - Add to environment: `REDIS_URL=redis://...`

3. **Deploy API (Render)**
   - Connect GitHub repo at https://render.com
   - Create Web Service
   - Set environment variables:
     ```
     NODE_ENV=production
     PORT=3000
     DATABASE_URL=<your-neon-url>
     JWT_SECRET=<32+ chars>
     REDIS_URL=<your-upstash-url>
     RATE_LIMIT_STORE=redis
     CORS_ORIGIN=<your-dashboard-url>
     ```
   - Deploy from `main` branch
   - Note: Free tier sleeps after 15min idle

4. **Deploy Showcase Artifacts**
   - Option A: GitHub Pages (free)
     ```bash
     # Create gh-pages branch
     git checkout -b gh-pages
     
     # Copy artifacts
     cp /tmp/acquisitions-metrics-dashboard.html index.html
     cp /tmp/acquisitions-api-docs.html api-docs.html
     cp /tmp/acquisitions-architecture.html architecture.html
     
     # Push and enable GitHub Pages in repo settings
     git add .
     git commit -m "Add showcase artifacts"
     git push origin gh-pages
     ```
   
   - Option B: Netlify Drop (drag & drop, instant)

5. **Update Dashboard**
   - Edit `index.html` to point to your Render API URL
   - Find line: `value="http://localhost:3000"`
   - Replace with: `value="https://your-app.onrender.com"`

**Total Cost:** $0/month

---

### Option 2: Always-On Professional ($12-20/month)

**Best for:** Active job search, frequent demos, professional portfolio

**Stack:**
- **API:** Render Starter ($7/month, always-on, 512MB RAM)
- **Database:** Neon Pro ($8/month, better limits) OR keep free tier
- **Redis:** Upstash Pro ($10/month, 1M commands/day)
- **Monitoring:** Dashboard artifact
- **Skip:** Kafka

**Why This Option:**
- No cold starts - instant demos
- Professional impression
- Handles multiple concurrent viewers
- Still demonstrates distributed Redis features

**Additional Steps:**
Same as Option 1, but:
- Upgrade Render to Starter plan ($7)
- Upgrade Upstash to Pro ($10) OR stay on free tier
- Optional: Neon Pro ($8) if free tier limits hit

**Total Cost:** $7-25/month depending on database tier

---

### Option 3: Multi-Service with Kafka ($40-60/month)

**Best for:** Showcasing full Phase 5 event streaming

**Stack:**
- **API:** Render Standard ($25/month, 1GB RAM, horizontal scaling)
- **Database:** Neon Pro ($8/month)
- **Redis:** Upstash Pro ($10/month)
- **Kafka:** Upstash Kafka ($0.2/GB ingress + $5 min/month)
- **Workers:** 2 additional Render services ($7 each)

**Why This Option:**
- Demonstrates Phases 1-5 completely
- Event streaming with transactional outbox
- Async notification delivery
- Multiple worker processes

**Additional Setup:**

1. **Deploy Kafka (Upstash)**
   - Create Kafka cluster at https://upstash.com
   - Create topics:
     ```bash
     # Use Upstash CLI or console
     Topic: acquisitions.events (3 partitions)
     Topic: acquisitions.events.dlq (1 partition)
     ```
   - Get bootstrap servers URL

2. **Deploy Workers on Render**
   
   **Publisher Service:**
   - Start Command: `npm run worker:publisher`
   - Environment:
     ```
     NODE_ENV=production
     DATABASE_URL=<your-neon-url>
     KAFKA_BROKERS=<upstash-brokers>
     KAFKA_TOPIC=acquisitions.events
     KAFKA_DLQ_TOPIC=acquisitions.events.dlq
     ```
   
   **Consumer Service:**
   - Start Command: `npm run worker:consumer`
   - Same environment as publisher

3. **Update API Environment**
   - Add Kafka variables to main API service
   - Workers will process outbox and consume events

**Total Cost:** $40-60/month

---

### Option 4: Kubernetes Cluster ($50-150/month)

**Best for:** Senior/Staff roles, showcasing Phase 7 expertise

**Stack:**
- **Kubernetes:** DigitalOcean K8s ($12/month for 2-node cluster)
- **Database:** Managed Postgres ($15/month)
- **Redis:** Managed Redis ($10/month)
- **Kafka:** Optional (adds $20-50/month)
- **LoadBalancer:** $12/month

**Why This Option:**
- Demonstrates full Phase 7 deployment
- 3-replica API with HPA (Horizontal Pod Autoscaler)
- Live failure drills showcase
- Kubernetes expertise visible

**Setup:**

1. **Create Cluster**
   ```bash
   # Use your existing scripts
   npm run k8s:up  # Creates kind cluster locally
   
   # For DigitalOcean K8s (production)
   doctl kubernetes cluster create acquisitions \
     --region nyc1 \
     --size s-2vcpu-4gb \
     --count 2
   ```

2. **Deploy Manifests**
   ```bash
   # Your Phase 7 manifests are in scripts/k8s/
   kubectl apply -f scripts/k8s/
   ```

3. **Run Failure Drills**
   ```bash
   # Your scripted drills
   npm run k8s:drills
   ```

**Total Cost:** $50-150/month depending on Kafka

---

## Recommended: Hybrid Approach ($10-15/month)

**The Sweet Spot for Portfolio Showcase:**

```
┌─────────────────────────────────────────────────┐
│  API (Render Starter)                    $7    │
│  ├─ Horizontal scaling: 2-3 instances           │
│  ├─ Demonstrates distributed rate limiting      │
│  └─ Always-on, no cold starts                   │
│                                                  │
│  Database (Neon Free)                    $0    │
│  ├─ 0.5GB storage (enough for demo)            │
│  └─ 1M deals seeded for pagination showcase     │
│                                                  │
│  Redis (Upstash Free or Pro)        $0-10    │
│  ├─ Distributed rate limiting across replicas   │
│  ├─ Refresh token rotation                      │
│  └─ Idempotency keys                            │
│                                                  │
│  Skip Kafka                              $0    │
│  ├─ Events write to outbox (Phase 5 complete)  │
│  └─ Workers not running (optional showcase)     │
│                                                  │
│  Showcase Artifacts (GitHub Pages)       $0    │
│  ├─ Live Metrics Dashboard                      │
│  ├─ Architecture Explorer                       │
│  └─ API Documentation                           │
└─────────────────────────────────────────────────┘

Total: $7-17/month
```

**Why This Works:**
- Demonstrates distributed patterns (Redis rate limiting)
- Professional always-on presence
- Affordable for extended showcase period
- K8s expertise documented but not deployed live
- Event streaming code complete (Phase 5) but workers not running

---

## Showcase Materials Checklist

### 1. Live Metrics Dashboard ✅
**File:** `/tmp/acquisitions-metrics-dashboard.html`
**Deploy to:** GitHub Pages or Netlify
**Shows:**
- Real-time `/metrics` endpoint queries
- Request rate, P95 latency, error rate
- Pool utilization, event loop lag
- v0→v7 performance comparison table

### 2. Architecture Explorer
**File:** Create next (in progress)
**Shows:**
- 7 phases with timeline
- 50+ findings with evidence
- 8 ADRs with decisions
- Interactive navigation

### 3. API Documentation
**File:** Create next
**Shows:**
- All endpoints with examples
- Try-it-out against live API
- Authentication flow
- Rate limiting behavior

### 4. Updated README.md
Add to your repository:
```markdown
## 🎯 Live Demo

**Metrics Dashboard:** https://yourusername.github.io/acquisitions
**API Documentation:** https://yourusername.github.io/acquisitions/api-docs.html
**Architecture Deep Dive:** https://yourusername.github.io/acquisitions/architecture.html

## 📊 Performance Evolution

| Metric | v0 Baseline | v7 Final | Improvement |
|--------|-------------|----------|-------------|
| P95 Latency | 695.18 ms | 6.06 ms | **↓ 99.1%** |
| Throughput @ 5 VUs | 2.11 iter/s | 4.19 iter/s | **↑ 98.6%** |
| Capacity @ 100 VUs | 1.28 iter/s | 74.29 iter/s | **↑ 58×** |

[View Complete Benchmark Results →](benchmarks/v7-final/SUMMARY.md)
```

---

## Quick Start: Deploy Option 2 (Recommended)

**Time: 30 minutes**

1. **Database (5 min)**
   ```bash
   # Already have Neon - just migrate
   npm run db:migrate
   npm run bench:seed
   ```

2. **Redis (5 min)**
   - Upstash.com → Create Database → Copy URL
   - Free tier: 10K commands/day

3. **API on Render (10 min)**
   - render.com → New Web Service → Connect repo
   - Environment: Copy from `.env.production`
   - Deploy

4. **Deploy Artifacts (10 min)**
   ```bash
   # GitHub Pages
   git checkout -b gh-pages
   cp /tmp/acquisitions-metrics-dashboard.html index.html
   git add index.html
   git commit -m "Add metrics dashboard"
   git push origin gh-pages
   
   # Enable Pages in GitHub repo settings
   ```

5. **Update README** (add live links)

**Result:** Live, shareable portfolio showcase for $7-17/month

---

## Talking Points for Interviews

**Opening:**
"I built a production-ready Express backend over 7 phases, each measured and benchmarked. The v0 baseline had a 695ms p95 latency; v7 brings that to 6ms - a 99% improvement."

**Architecture:**
"The stack demonstrates distributed systems patterns:
- Phase 4: Redis-backed rate limiting using atomic Lua scripts - correct across replicas
- Phase 5: Transactional outbox pattern to avoid dual-write loss with Kafka
- Phase 7: Kubernetes deployment with HPA, proper probes, and scripted failure drills"

**Methodology:**
"Every optimization is measured - I have 50 numbered findings documenting what was wrong, how I verified it, and the measured fix. The repo includes 8 ADRs explaining architectural decisions."

**The Dashboard:**
"Here's the live metrics dashboard" [share link] "- it queries the /metrics endpoint in real-time. You can see request rates, P95 latency, pool saturation, and event-loop lag."

**Distributed Behavior:**
"The rate limiter is interesting - without Redis, 3 replicas each allow the full limit. With Redis, the sliding window is atomic across all instances. I have a proof script that demonstrates the difference."

---

## Next Steps

1. Choose deployment tier (Option 2 recommended)
2. Deploy API + Redis to Render/Upstash
3. Deploy showcase artifacts to GitHub Pages
4. Update README with live links
5. Optional: Record 2-3 minute walkthrough video

**Files to Copy:**
- `/tmp/acquisitions-metrics-dashboard.html` → Your hosting
- (Next) Architecture explorer artifact
- (Next) API documentation artifact
- This deployment guide → `docs/DEPLOYMENT.md`

---

## Cost Comparison Summary

| Option | Monthly Cost | Best For | Demonstrates |
|--------|--------------|----------|--------------|
| **Free Tier** | $0 | Portfolio presence | Phases 1-4 |
| **Professional** | $7-20 | Active job search | Phases 1-4, always-on |
| **Full Stack** | $40-60 | Complete showcase | Phases 1-5, Kafka |
| **Kubernetes** | $50-150 | Senior roles | Full Phase 7 |

**Recommended:** Start with Professional ($7-20), upgrade to Full Stack if showcasing event streaming specifically.
