# =============================================================================
# Multi-stage Dockerfile for Express.js Application with Neon Database
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
    adduser -S nodejs -u 1001 -G nodejs

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