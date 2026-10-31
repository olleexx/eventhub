# Not built or tested in the sandbox where this was written.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
USER node
# Apply committed migrations, then start. Run the worker separately if RUN_WORKER_IN_PROCESS=false.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
