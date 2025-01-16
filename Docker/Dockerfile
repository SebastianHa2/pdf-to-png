FROM node:18

# Install Ghostscript
RUN apt-get update && apt-get install -y ghostscript

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./
RUN npm install --only=prod

# Copy your server code
COPY server.js .  # or rename pdf-to-png.js -> server.js

EXPOSE 8080

CMD ["npm", "start"]