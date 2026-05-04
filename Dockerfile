FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

EXPOSE 4173
CMD ["node", "server.js"]
