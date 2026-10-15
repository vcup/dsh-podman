# SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
#
# SPDX-License-Identifier: MIT

GO ?= go
GOFMT ?= gofmt
DPRINT ?= node_modules/.bin/dprint
# dprint cannot create its default cache under the container's read-only root, so
# keep the downloaded plugins inside the workspace instead.
export DPRINT_CACHE_DIR ?= $(CURDIR)/node_modules/.cache/dprint
BUF ?= buf
GO_BUILD_TAGS = containers_image_openpgp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper
GO_BUILD_FLAGS = -tags "$(GO_BUILD_TAGS)"
GOOS ?= linux
GOARCH ?= amd64
BIN_DIR ?= bin
CONTAINER ?= podman
IMAGE_PREFIX ?= localhost/dsh-podman-
IMAGE_TAG ?= latest
GIT_DESCRIBE := $(shell git describe --tags 2>/dev/null)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null)
VERSION := $(if $(GIT_DESCRIBE),$(GIT_DESCRIBE),dev)
COMMIT := $(GIT_COMMIT)
GO_LDFLAGS = -ldflags "-X github.com/Exagone313/dsh-podman/internal/version.Version=$(VERSION) -X github.com/Exagone313/dsh-podman/internal/version.Commit=$(COMMIT)"

GO_SOURCES := $(shell find cmd internal -type f -name '*.go' -print)
JS_SOURCES := $(shell find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print)
PROTO_SOURCES := $(shell find proto -type f -name '*.proto' -print)
NODE_MODULES_TSC := node_modules/.bin/tsc
# Go sources the project owns; third_party/ is an upstream replacement module
# (the replace directive in go.mod) and is left exactly as published.
GOFMT_SOURCES := $(shell find cmd internal scripts -type f -name '*.go' -print)
# Quoted so dprint expands the globs, not the shell. dprint.json pins the width,
# the wrapped-prose policy and the plugin versions, which keeps the existing
# TypeScript and Markdown untouched.
TS_SOURCES = "src/**/*.ts" "src/**/*.tsx" "scripts/**/*.mjs"
MD_SOURCES = "**/*.md"

.PHONY: all build build-go vet test test-go test-workflow-control fmt fmt-go fmt-ts fmt-md fmt-check fmt-check-go fmt-check-ts fmt-check-md image image-go image-orchestrator image-guestagent image-gateway image-dsh download-licenses pnpm-install pnpm-build pnpm-test pnpm-prune clean proto proto-check

all: build

build: build-go pnpm-build

vet: fmt-check-go
	$(GO) vet $(GO_BUILD_FLAGS) ./...

test: test-go pnpm-test

test-go:
	$(GO) test $(GO_BUILD_FLAGS) ./...

# Real Go guest + gRPC + Node subprocess control transport (Linux only).
# Optionally pass DSH_PODMAN_TEST_PTC_BOOTSTRAP to exercise Harness's worker.
test-workflow-control: pnpm-build $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent
	DSH_PODMAN_TEST_GUEST_BIN="$(abspath $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent)" node --test scripts/test-workflow-control.mjs

# Formatting. fmt rewrites in place, fmt-check verifies; both cover every
# language the project formats (Go, TypeScript, Markdown). JSON, YAML and
# .proto sources are not formatted.
fmt: fmt-go fmt-ts fmt-md

fmt-go:
	$(GOFMT) -s -w $(GOFMT_SOURCES)

fmt-ts:
	$(DPRINT) fmt $(TS_SOURCES)

fmt-md:
	$(DPRINT) fmt $(MD_SOURCES)

fmt-check: fmt-check-go fmt-check-ts fmt-check-md

fmt-check-go:
	@out="$$($(GOFMT) -s -l $(GOFMT_SOURCES) 2>&1)"; status=$$?; \
	if [ $$status -ne 0 ] || [ -n "$$out" ]; then \
		printf '%s\n' "$$out" >&2; \
		printf "run 'make fmt-go' to rewrite the unformatted files\n" >&2; \
		exit 1; \
	fi

fmt-check-ts:
	$(DPRINT) check $(TS_SOURCES)

fmt-check-md:
	$(DPRINT) check $(MD_SOURCES)

build-go: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-gateway

# The Go images; image adds the dsh (Node) image.
image-go: image-orchestrator image-guestagent image-gateway

image: image-go image-dsh

image-orchestrator: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator third-party-licenses.pkg
	$(CONTAINER) build --build-arg TARGETOS=$(GOOS) --build-arg TARGETARCH=$(GOARCH) -f Containerfile.orchestrator -t $(IMAGE_PREFIX)orchestrator:$(IMAGE_TAG) .

image-guestagent: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent third-party-licenses.pkg
	$(CONTAINER) build --build-arg TARGETOS=$(GOOS) --build-arg TARGETARCH=$(GOARCH) -f Containerfile.guestagent -t $(IMAGE_PREFIX)guest-agent:$(IMAGE_TAG) .

# The gateway runs on the host network so it can bind the host's loopback; it
# talks to nobody but the orchestrator and the published sockets.
image-gateway: $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-gateway third-party-licenses.pkg
	$(CONTAINER) build --build-arg TARGETOS=$(GOOS) --build-arg TARGETARCH=$(GOARCH) -f Containerfile.gateway -t $(IMAGE_PREFIX)gateway:$(IMAGE_TAG) .

image-dsh:
	$(CONTAINER) build --build-arg DSH_PODMAN_PLUGIN_VERSION=$$(node -p "require('./package.json').version") -f Containerfile.dsh -t $(IMAGE_PREFIX)dsh:$(IMAGE_TAG) .

# third-party-licenses.pkg combines the project license with the licenses and notices of
# every third-party Go module; it is generated, gitignored, and baked into the
# orchestrator and guest-agent images.
third-party-licenses.pkg: scripts/download-licenses/main.go go.mod go.sum
	go run ./scripts/download-licenses

download-licenses: third-party-licenses.pkg

$(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) $(GO_LDFLAGS) -o $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-guest-agent ./cmd/dsh-podman-guest-agent

$(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) $(GO_LDFLAGS) -o $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-orchestrator ./cmd/dsh-podman-orchestrator

$(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-gateway: $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BIN_DIR)/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build $(GO_BUILD_FLAGS) $(GO_LDFLAGS) -o $(BIN_DIR)/$(GOOS)-$(GOARCH)/dsh-podman-gateway ./cmd/dsh-podman-gateway

# Protobuf. proto regenerates internal/genproto with the plugins pinned in
# buf.gen.yaml; proto-check is what CI runs: lint, no breaking change since the
# latest release tag, and committed bindings matching a fresh generation.
proto:
	$(BUF) generate

proto-check:
	$(BUF) lint
	$(BUF) breaking --against ".git#tag=$$(git describe --tags --abbrev=0)"
	$(BUF) generate
	@if [ -n "$$(git status --porcelain -- internal/genproto)" ]; then \
		git status --short -- internal/genproto >&2; \
		printf "internal/genproto is out of date: run 'make proto' and commit the result\n" >&2; \
		exit 1; \
	fi

pnpm-install:
	pnpm install --frozen-lockfile

dist/index.js: $(JS_SOURCES) $(PROTO_SOURCES) package.json pnpm-lock.yaml tsconfig.json tsconfig.client.json $(NODE_MODULES_TSC)
	pnpm run build

$(NODE_MODULES_TSC): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile

pnpm-build: dist/index.js

pnpm-test: pnpm-build
	pnpm test

pnpm-prune:
	pnpm prune --prod

clean:
	rm -rf $(BIN_DIR) dist node_modules third-party-licenses.pkg
