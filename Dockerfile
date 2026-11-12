# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
# The setup script runs from source, so src/ ships next to dist/.
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER bun
EXPOSE 3000
CMD ["bun", "dist/bootstrap/main.js"]
