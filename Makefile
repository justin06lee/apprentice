APP       := apprentice
BIN_DIR   := $(HOME)/.local/bin
OS        := $(shell uname -s | tr '[:upper:]' '[:lower:]')

APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app

LX_SUFFIX := $(if $(filter aarch64 arm64,$(shell uname -m)),-arm64,)
LX_SRC    := dist-app/linux$(LX_SUFFIX)-unpacked
LX_DST    := $(HOME)/.local/opt/$(APP)
LX_APPS   := $(HOME)/.local/share/applications
LX_ICONS  := $(HOME)/.local/share/icons/hicolor/scalable/apps

.PHONY: all build install install-darwin install-linux update uninstall uninstall-darwin uninstall-linux \
        launch launch-darwin launch-linux stop dev test typecheck clean

all: build install launch

# The artifact: the packaged app in dist-app/.
build:
	bun install
	@test -e node_modules/electron/dist/electron -o -d node_modules/electron/dist/Electron.app || \
		(cd node_modules/electron && node install.js)
	bun run build
	bun run build:app

# Replace a running install: stop it, remove it, build, install, start it.
update: stop uninstall build install launch

install: install-$(OS)
launch: launch-$(OS)

install-darwin:
	rm -rf $(APP_DST)
	cp -R $(APP_SRC) $(APP_DST)
	@mkdir -p $(BIN_DIR)
	@printf '#!/bin/sh\n# apprentice, from a terminal: `apprentice book.pdf` adds and opens it.\nexec /usr/bin/open -a "%s" --args "$$@"\n' '$(APP_DST)' > $(BIN_DIR)/$(APP)
	@chmod +x $(BIN_DIR)/$(APP)
	@echo "installed $(APP_DST) and $(BIN_DIR)/$(APP)"

install-linux:
	rm -rf $(LX_DST)
	@mkdir -p $(dir $(LX_DST)) $(LX_APPS) $(LX_ICONS) $(BIN_DIR)
	cp -R $(LX_SRC) $(LX_DST)
	@cp assets/$(APP).svg $(LX_ICONS)/$(APP).svg
	@printf '[Desktop Entry]\nType=Application\nName=apprentice\nGenericName=Study\nComment=Read, mark up, ask about and remember your textbooks.\nExec=%s/%s %%f\nIcon=%s\nTerminal=false\nStartupWMClass=%s\nCategories=Education;Office;\nMimeType=application/pdf;\n' '$(LX_DST)' '$(APP)' '$(APP)' '$(APP)' > $(LX_APPS)/$(APP).desktop
	@-update-desktop-database $(LX_APPS) 2>/dev/null || true
	@printf '#!/bin/sh\n# apprentice, from a terminal: `apprentice book.pdf` adds and opens it.\nnohup "%s/%s" "$$@" >/dev/null 2>&1 &\n' '$(LX_DST)' '$(APP)' > $(BIN_DIR)/$(APP)
	@chmod +x $(BIN_DIR)/$(APP)
	@echo "installed $(LX_DST), $(LX_APPS)/$(APP).desktop and $(BIN_DIR)/$(APP)"
	@./scripts/apparmor.sh '$(LX_DST)/$(APP)'

launch-darwin:
	open $(APP_DST)

launch-linux:
	$(BIN_DIR)/$(APP)

stop:
	-pkill -x $(APP) 2>/dev/null || true

uninstall: uninstall-$(OS)

uninstall-darwin:
	rm -rf $(APP_DST)

uninstall-linux:
	rm -rf $(LX_DST)

dev:
	bun run dev

typecheck:
	bun run typecheck

test:
	bun run typecheck
	bun run test

clean:
	rm -rf dist-web dist-electron dist-app
