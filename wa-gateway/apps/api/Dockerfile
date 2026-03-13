FROM node:20-alpine AS base

WORKDIR /app

# Copy workspace root
COPY package.json package-lock.json* ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/

# Install dependencies
RUN npm install --workspace=apps/api --include-workspace-root

# Copy source
COPY packages/ packages/
COPY apps/api/ apps/api/

# Generate Prisma client
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

# Build
RUN npm run build -w packages/types && \
    npm run build -w packages/config && \
    npm run build -w packages/db && \
    npm run build -w apps/api

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/config/dist ./packages/config/dist
COPY --from=base /app/packages/config/package.json ./packages/config/
COPY --from=base /app/packages/types/dist ./packages/types/dist
COPY --from=base /app/packages/types/package.json ./packages/types/
COPY --from=base /app/packages/db/dist ./packages/db/dist
COPY --from=base /app/packages/db/package.json ./packages/db/
COPY --from=base /app/packages/db/prisma ./packages/db/prisma
COPY --from=base /app/apps/api/dist ./apps/api/dist
COPY --from=base /app/apps/api/package.json ./apps/api/
COPY --from=base /app/package.json ./

ENV NODE_ENV=production

# Run migrations and start
CMD ["sh", "-c", "npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma && node apps/api/dist/server.js"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:3100/health || exit 1
