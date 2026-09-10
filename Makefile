.PHONY: clean install ui build test dev dist

# The UI is not committed. `make ui` builds it from frontend/ into desktop/web,
# where the Electron main process serves it and electron-builder copies it into
# the packaged app. The desktop npm scripts build it themselves too, so either
# entry point works on a fresh clone.

install:
	cd frontend && npm ci
	cd desktop && npm ci

ui:
	cd frontend && npm run build

build: ui
	cd desktop && npm run build

dev:
	cd desktop && npm run dev

dist:
	cd desktop && npm run dist:mac

test:
	cd frontend && npm run lint && npm test
	cd desktop && npm run typecheck && npm test

clean:
	rm -rf desktop/dist desktop/web
