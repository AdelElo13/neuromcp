FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Download ONNX model at build time
COPY scripts/ ./scripts/
RUN node scripts/download-model.mjs || true

COPY dist/ ./dist/
COPY bin/ ./bin/

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
