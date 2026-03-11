FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
