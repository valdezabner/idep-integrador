FROM node:20-alpine

# Install runtime dependencies needed for pg_dump (backup job) and curl (healthcheck)
RUN apk add --no-cache \
    postgresql-client \
    curl \
    docker-cli \
    ca-certificates \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Install Node dependencies first (cached layer)
# Note: use `npm install` (not `npm ci`) so the build does not require a committed
# package-lock.json, which is gitignored in this repository.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY . .

# Create upload directory with correct permissions
RUN mkdir -p /uploads && chown node:node /uploads

# Drop to unprivileged user
# Note: docker.sock access requires the node user to be in the docker group
# or the socket to have group-writable permissions — handled in docker-compose
# by mounting the socket; in production pin the GID to match the host docker group.
USER node

EXPOSE 3000

# Use exec form so SIGTERM is delivered directly to node
CMD ["node", "server.js"]
