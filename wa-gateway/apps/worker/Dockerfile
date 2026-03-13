FROM node:20-alpine AS base

WORKDIR /app

# Copy workspace root
COPY package.json package-lock.json* ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/

# Install dependencies
RUN npm install --workspace=apps/worker --include-workspace-root

# Copy source
COPY packages/ packages/
COPY apps/worker/ apps/worker/

# Generate Prisma client
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

# Build
RUN npm run build -w packages/types && \
    npm run build -w packages/config && \
    npm run build -w packages/db && \
    npm run build -w apps/worker

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
COPY --from=base /app/apps/worker/dist ./apps/worker/dist
COPY --from=base /app/apps/worker/package.json ./apps/worker/
COPY --from=base /app/package.json ./

# Sessions directory
RUN mkdir -p /app/sessions
VOLUME /app/sessions

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions

CMD ["node", "apps/worker/dist/index.js"]
