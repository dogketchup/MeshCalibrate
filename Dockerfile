#https://forums.docker.com/t/dockerize-a-react-vite-application/140270/6
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 5713

CMD ["npm", "run", "dev", "--", "--port=5713", "--host=0.0.0.0"]
