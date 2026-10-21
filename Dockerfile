# Mirrors 619-erp-backend/Dockerfile so both services build, run and are
# debugged the same way on the VPS — same base image, same non-root user
# pattern, same healthcheck shape.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 express
COPY --from=deps --chown=express:nodejs /app/node_modules ./node_modules
COPY --chown=express:nodejs . .
# Writable home for the usage ledger (MPS-01). Non-root user cannot create
# /app/logs itself; an absent dir would silently disable the audit file.
RUN mkdir -p /app/logs && chown -R express:nodejs /app/logs

# Build metadata, not configuration: /health reports it so a deploy can prove
# which commit the running process actually is. A plain build says "unknown".
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER express
EXPOSE 4100
ENV NODE_ENV=production \
    PORT=4100
# /health makes no upstream calls, so a slow model provider cannot cause
# a restart loop of a process that is working fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4100/health || exit 1
CMD ["node", "src/server.js"]
