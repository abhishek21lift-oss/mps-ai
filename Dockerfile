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
USER express
EXPOSE 4100
ENV NODE_ENV=production \
    PORT=4100
# /health makes no upstream calls, so a slow model provider cannot cause
# a restart loop of a process that is working fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4100/health || exit 1
CMD ["node", "src/server.js"]
