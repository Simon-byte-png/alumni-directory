FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js config.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node data/alumni.example.json ./data/alumni.example.json
RUN mkdir -p /app/data/runtime && chown node:node /app/data/runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
