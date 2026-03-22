FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY lib ./lib
COPY workers ./workers

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["npm", "run", "whatsapp:worker"]
