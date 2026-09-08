# =============================================================================
# Multi-stage Dockerfile
# =============================================================================
# Four targets, and the last one is new in Phase 7:
#
#   development  all dependencies, hot reload. Used by the compose stacks.
#   production   production dependencies only, non-root, tini as PID 1.
#   migrator     production image + drizzle-kit, for the migration Job.
#
# WHY A SEPARATE MIGRATOR IMAGE. `drizzle-kit` is a devDependency, so it is deliberately
# absent from the production image — a runtime container has no business being able to
# rewrite the schema, and shipping a schema tool into every pod widens the blast radius of
# a compromised container for no operational benefit. But SOMETHING has to run migrations,
# and k8s/20-api.yaml runs them as a Job. That Job gets its own image.
# =============================================================================

# -----------------------------------------------------------------------------
# Base Stage: Common dependencies and configuration
# -----------------------------------------------------------------------------
FROM node:22-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    dumb-init \
    tini \
    && rm -rf /var/cache/apk/*

# Create app directory and non-root user
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs && \
    mkdir -p /app/logs && \
    chown nodejs:nodejs /app /app/logs

# -----------------------------------------------------------------------------
# Dependencies Stage: Install production dependencies only
# -----------------------------------------------------------------------------
FROM base AS deps

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production --ignore-scripts && \
    npm cache clean --force

# -----------------------------------------------------------------------------
# Development Dependencies Stage: Install all dependencies including dev
# -----------------------------------------------------------------------------
FROM base AS dev-deps

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts && \
    npm cache clean --force

# -----------------------------------------------------------------------------
# Build Stage: Compile/prepare application (if needed)
# -----------------------------------------------------------------------------
FROM dev-deps AS builder

COPY --chown=nodejs:nodejs . .

# Run any build steps here (TypeScript compile, etc.)
# RUN npm run build

# -----------------------------------------------------------------------------
# Development Stage: Hot-reload enabled
# -----------------------------------------------------------------------------
FROM dev-deps AS development

ENV NODE_ENV=development

# Copy source code
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Use tini as init process for proper signal handling
ENTRYPOINT ["tini", "--"]

# Start with file watching (--watch requires Node 18.11+)
CMD ["node", "--watch", "src/index.js"]

# -----------------------------------------------------------------------------
# Production Stage: Minimal runtime image
# -----------------------------------------------------------------------------
FROM base AS production

ENV NODE_ENV=production

# Copy production dependencies from deps stage
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application source
COPY --chown=nodejs:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown -R nodejs:nodejs logs

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) process.exit(1)})" || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["tini", "--"]

# Start application
CMD ["npm", "start"]

# -----------------------------------------------------------------------------
# Migrator Stage: the schema tool, and nothing that serves traffic
# -----------------------------------------------------------------------------
# Used by the `db-migrate` Job in k8s/20-api.yaml. It carries dev dependencies because
# drizzle-kit is one, and it never listens on a port: its whole lifecycle is "run once,
# exit 0". Keeping it out of the runtime image is the point — see the header.
FROM dev-deps AS migrator

ENV NODE_ENV=production

COPY --chown=nodejs:nodejs . .

USER nodejs

ENTRYPOINT ["tini", "--"]

# Deliberately not `npm run db:migrate`: npm adds a process layer between tini and the tool,
# which swallows the exit code that tells Kubernetes whether the Job succeeded.
CMD ["npx", "drizzle-kit", "migrate"]