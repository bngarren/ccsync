FROM ubuntu:latest

# Set the working directory
WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg2 \
    lsb-release \
    ca-certificates \
    git \
    build-essential \
    unzip\
    npm\
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Add Bun to the PATH
ENV PATH="/root/.bun/bin:${PATH}"

# Copy your repository files into the container
COPY . .

# Install your project dependencies using Bun
RUN bun install

# Command to run your tests
#CMD ["bun", "run", "test"]