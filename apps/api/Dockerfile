# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace @convo/api

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# `prisma generate` reads the config, which needs a URL, but it never connects.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build -w @convo/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Prisma CLI stays installed so the container can apply migrations on start.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json apps/api/prisma.config.ts ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
USER node
EXPOSE 4200
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
