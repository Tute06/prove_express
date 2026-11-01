FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
