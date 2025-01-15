FROM node:18

# Install the system-level Ghostscript binary
RUN apt-get update && apt-get install -y ghostscript

WORKDIR /usr/src/app

# Copy in the new minimal package.json and package-lock.json
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=prod

# Copy your PDF-to-PNG code
COPY pdf-to-png.js .

# Expose the port the Functions Framework will run on
EXPOSE 8080

# Start the function via the Functions Framework
# "createImage" should match your exported function name in pdf-to-png.js
CMD ["npm", "start"]