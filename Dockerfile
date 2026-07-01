FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --workspaces --include-workspace-root

# Copy source and build
COPY . .
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p server/data

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server/dist/index.js"]