# ─────────────────────────────────────────────────────────────────────────────
# Variables
# Override REGISTRY on the CLI: make build REGISTRY=myuser
# GIT_SHA tags images with the current commit hash for traceability.
# ─────────────────────────────────────────────────────────────────────────────
REGISTRY  ?= sauravmehta
PREFIX    ?= content-scrapper
GIT_SHA   := $(shell git rev-parse --short HEAD)
SERVICES  := auth-service telegram-read-service telegram-download-service \
             google-upload-service google-download-service api-gateway ui-service

.PHONY: build push save load up down logs clean $(SERVICES)

# ─────────────────────────────────────────────────────────────────────────────
# build — build all service images
# ─────────────────────────────────────────────────────────────────────────────
build:
	@echo "Building all images (git SHA: $(GIT_SHA))..."
	@for svc in $(SERVICES); do \
		echo "\n── Building $$svc ──"; \
		docker build \
			-t $(REGISTRY)/$(PREFIX)-$$svc:latest \
			-t $(REGISTRY)/$(PREFIX)-$$svc:$(GIT_SHA) \
			./services/$$svc; \
	done
	@echo "\nAll images built."

# ─────────────────────────────────────────────────────────────────────────────
# push — push all images to the registry
# Run 'docker login' before this.
# ─────────────────────────────────────────────────────────────────────────────
push:
	@echo "Pushing all images to $(REGISTRY)..."
	@for svc in $(SERVICES); do \
		docker push $(REGISTRY)/$(PREFIX)-$$svc:latest; \
		docker push $(REGISTRY)/$(PREFIX)-$$svc:$(GIT_SHA); \
	done
	@echo "All images pushed."

# ─────────────────────────────────────────────────────────────────────────────
# save — export all images as .tar files into ./docker-images/
# Useful for air-gapped environments or sharing images without a registry.
# ─────────────────────────────────────────────────────────────────────────────
save:
	@mkdir -p docker-images
	@for svc in $(SERVICES); do \
		echo "Saving $$svc → docker-images/$$svc.tar"; \
		docker save $(REGISTRY)/$(PREFIX)-$$svc:latest -o docker-images/$$svc.tar; \
	done
	@echo "Images saved to ./docker-images/"

# ─────────────────────────────────────────────────────────────────────────────
# load — load .tar files back into Docker (reverse of save)
# ─────────────────────────────────────────────────────────────────────────────
load:
	@for svc in $(SERVICES); do \
		echo "Loading docker-images/$$svc.tar"; \
		docker load -i docker-images/$$svc.tar; \
	done

# ─────────────────────────────────────────────────────────────────────────────
# up / down — start and stop the whole stack locally
# ─────────────────────────────────────────────────────────────────────────────
up:
	docker compose up --build -d

down:
	docker compose down

# ─────────────────────────────────────────────────────────────────────────────
# logs — tail logs from all containers
# ─────────────────────────────────────────────────────────────────────────────
logs:
	docker compose logs -f

# ─────────────────────────────────────────────────────────────────────────────
# clean — remove all built images
# ─────────────────────────────────────────────────────────────────────────────
clean:
	@for svc in $(SERVICES); do \
		docker rmi -f $(REGISTRY)/$(PREFIX)-$$svc:latest $(REGISTRY)/$(PREFIX)-$$svc:$(GIT_SHA) 2>/dev/null || true; \
	done
	@echo "Images removed."
