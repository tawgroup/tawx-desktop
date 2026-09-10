.PHONY: clean install ui build test dev dist

# The frontend bundles into desktop/web, which the Electron main process serves
# and electron-builder copies into the packaged app. Building the UI is
# therefore a prerequisite of anything that runs the app.

install:
	cd frontend && npm ci
	cd desktop && npm ci

ui:
	cd frontend && npm run build

build: ui
	cd desktop && npm run build

dev: ui
	cd desktop && npm run dev

dist: ui
	cd desktop && npm run dist:mac

test:
	cd frontend && npm run lint && npm test
	cd desktop && npm run typecheck && npm test

clean:
	rm -rf desktop/dist desktop/web
