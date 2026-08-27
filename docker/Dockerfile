syntax=docker/dockerfile:1

FROM node:26.1.0-trixie AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

FROM node:26.1.0-trixie AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/backend/package.json packages/backend/package.json
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/backend
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/frontend/dist packages/backend/dist/public

EXPOSE 3000
CMD ["node", "packages/backend/dist/server.js"]
