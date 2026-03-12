FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY migrate.js ./
EXPOSE 3000
CMD ["node", "src/server.js"]
