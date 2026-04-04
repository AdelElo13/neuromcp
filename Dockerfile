FROM node:18-slim

WORKDIR /app

# Install build tools for native modules (better-sqlite3, onnxruntime-node)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Download ONNX model at build time
COPY scripts/ ./scripts/
RUN node scripts/download-model.mjs || true

COPY dist/ ./dist/
COPY bin/ ./bin/

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
