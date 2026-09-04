# Capture — 常用构建命令
#   make build   编译并生成 Windows 安装包（默认）
#   make mac     生成 macOS 安装包（dmg + zip，arm64）
#   make linux   生成 Linux 安装包
#   make pack    仅打包未安装目录（win-unpacked，无需 wine）
#   make help    查看全部目标

SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM ?= npm
VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)
RELEASE_DIR := release

.PHONY: help install compile build win mac linux pack portable clean start asar-update

help:
	@echo "Capture $(VERSION)"
	@echo ""
	@echo "  make install     安装依赖 (npm install)"
	@echo "  make compile     仅编译 TypeScript → dist/"
	@echo "  make build       编译并生成 Windows 安装包（默认交付物）"
	@echo "  make win         同 make build（NSIS Setup + portable）"
	@echo "  make mac         编译并生成 macOS 包（dmg + zip，arm64）"
	@echo "  make linux       编译并生成 Linux 包（AppImage / deb）"
	@echo "  make pack        仅生成未打包目录（release/*-unpacked）"
	@echo "  make portable    仅生成 Windows portable exe"
	@echo "  make asar-update 编译后刷新 win-unpacked 内 app.asar（快速迭代）"
	@echo "  make start       编译并启动 Electron"
	@echo "  make clean       清理 dist/ 与 release/"
	@echo ""
	@echo "产物目录: $(RELEASE_DIR)/"
	@echo "  Windows: Capture-Setup-$(VERSION).exe , Capture-$(VERSION)-portable.exe"
	@echo "  macOS:   Capture-$(VERSION)-arm64.dmg , Capture-$(VERSION)-arm64.zip"
	@echo "  Linux:   Capture-$(VERSION).AppImage , Capture-$(VERSION).deb"

install:
	$(NPM) install

# 仅编译（tsc + 复制 renderer）
compile:
	$(NPM) run build

# 默认交付：Windows 安装包
build: win

win: compile
	@echo "==> 打包 Windows 安装包 (NSIS + portable)…"
	@if [ "$$(uname -s)" = "Linux" ] && ! command -v wine >/dev/null 2>&1; then \
		echo "提示: 当前在 Linux/WSL 且未检测到 wine，NSIS 安装包可能失败。"; \
		echo "      可先 make pack 得到 win-unpacked，或安装 wine 后再 make build。"; \
	fi
	$(NPM) run dist:win -- --publish never
	@echo ""
	@echo "==> 完成。安装包："
	@ls -lh $(RELEASE_DIR)/Capture-Setup-$(VERSION).exe \
		$(RELEASE_DIR)/Capture-$(VERSION)-portable.exe \
		2>/dev/null || ls -lh $(RELEASE_DIR)/*.{exe,AppImage,deb} 2>/dev/null || ls -lh $(RELEASE_DIR)/

mac: compile
	@echo "==> 打包 macOS (dmg + zip，arm64)…"
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "错误: macOS 打包必须在 Mac 本机执行。"; \
		exit 1; \
	fi
	$(NPM) run dist:mac -- --publish never
	@echo ""
	@echo "==> 完成。安装包："
	@ls -lh $(RELEASE_DIR)/Capture-$(VERSION)-arm64.dmg \
		$(RELEASE_DIR)/Capture-$(VERSION)-arm64.zip \
		2>/dev/null || ls -lh $(RELEASE_DIR)/*.{dmg,zip} 2>/dev/null || ls -lh $(RELEASE_DIR)/

linux: compile
	@echo "==> 打包 Linux (AppImage + deb)…"
	$(NPM) run dist:linux -- --publish never
	@ls -lh $(RELEASE_DIR)/Capture-$(VERSION).* 2>/dev/null || ls -lh $(RELEASE_DIR)/

# 仅目录产物，WSL 无 wine 时可用
pack: compile
	@echo "==> 打包未安装目录 (--dir)…"
	$(NPM) run pack -- --win --x64 --publish never
	@echo "==> 可执行文件: $(RELEASE_DIR)/win-unpacked/Capture.exe"

portable: compile
	@echo "==> 仅打包 Windows portable…"
	npx electron-builder --win portable --x64 --publish never
	@ls -lh $(RELEASE_DIR)/Capture-$(VERSION)-portable.exe 2>/dev/null || true

# 开发常用：在已有完整 app.asar 上热更新 dist（不会丢掉 node_modules）
asar-update: compile
	@test -f $(RELEASE_DIR)/win-unpacked/resources/app.asar || (echo "请先执行 make pack"; exit 1)
	@tmp=$$(mktemp -d); \
	  ./node_modules/.bin/asar extract $(RELEASE_DIR)/win-unpacked/resources/app.asar "$$tmp/app" && \
	  rm -rf "$$tmp/app/dist" && \
	  cp -a dist "$$tmp/app/dist" && \
	  cp -f dist/package.json "$$tmp/app/package.json" 2>/dev/null || true && \
	  ./node_modules/.bin/asar pack "$$tmp/app" $(RELEASE_DIR)/win-unpacked/resources/app.asar && \
	  rm -rf "$$tmp" && \
	  echo "==> 已热更新 dist → $(RELEASE_DIR)/win-unpacked/resources/app.asar"

start: compile
	$(NPM) start --ignore-scripts

clean:
	$(NPM) run clean
	@echo "==> 已清理 dist/ 与 release/"
