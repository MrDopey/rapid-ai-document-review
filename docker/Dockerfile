# syntax=docker/dockerfile:1

FROM node:26.1.0-trixie AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY app/shared/package.json app/shared/package.json
COPY app/backend/package.json app/backend/package.json
COPY app/frontend/package.json app/frontend/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY app ./app
RUN npm run build

FROM node:26.1.0-trixie AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY app/shared/package.json app/shared/package.json
COPY app/backend/package.json app/backend/package.json
RUN npm ci --omit=dev --workspace=app/shared --workspace=app/backend
COPY --from=build /app/app/shared/dist app/shared/dist
COPY --from=build /app/app/backend/dist app/backend/dist
COPY --from=build /app/app/frontend/dist app/backend/dist/public

EXPOSE 3000
CMD ["node", "app/backend/dist/server.js"]
