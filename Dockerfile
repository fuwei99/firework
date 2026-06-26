FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app files
COPY index.js dashboard.html start.sh ./

# Make start.sh executable
RUN chmod +x start.sh

# Expose port
EXPOSE 7860

# Run starting script
CMD ["./start.sh"]
