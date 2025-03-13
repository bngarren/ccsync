# Define default target
.DEFAULT_GOAL := help

# Start the container and build if needed
up:  ## Start the container (build if needed)
	docker compose up -d --build

# Stop the container
down:  ## Stop and remove the container
	docker compose down

# Open shell inside the container
enter:  ## Open shell in running container
	docker compose exec node_alpine sh

# Restart the container
restart: down up  ## Restart the container

# Show available commands
help:  ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-10s\033[0m %s\n", $$1, $$2}'
