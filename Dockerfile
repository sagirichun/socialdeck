FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN npx next build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
