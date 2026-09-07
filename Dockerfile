# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/public ./dist/public
COPY --from=builder /app/src/db/migrations ./dist/db/migrations

# Set environment
ENV NODE_ENV=production
ENV PORT=7700
ENV HOST=0.0.0.0

EXPOSE 7700

# 컨테이너 안에서 root 로 돌 이유가 없다.
USER node

# 사내 서비스 공통 규약: /healthz 로 살아 있는지 본다.
# 이미지에 curl·wget 을 넣지 않으려고 node 내장 fetch 를 쓴다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7700/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
