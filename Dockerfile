FROM node:18.19-bullseye-slim AS base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . /app
COPY ./src /app/src
COPY ./migrations /app/migrations

CMD ["node", "/app/src/subscription-management/index.js"]
