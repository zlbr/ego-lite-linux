# Linux Docker port

The Linux port runs the open-source `ego-browser` harness against a headless
Chromium process in Docker. It implements the documented `globalThis.ego`
boundary with Chromium's remote-debugging pipe, so agent scripts use the same
`TaskSpace`, `Page`, locator, input, wait, screenshot, and CDP APIs as the
embedded macOS runtime.

## Build

From the repository root:

```bash
docker build -t ego-lite-linux .
```

The image is multi-architecture when built with a multi-platform Docker
builder. Debian supplies the Chromium binary for the selected architecture.

## Run

Pass an ego-browser program on standard input:

```bash
docker run --rm -i ego-lite-linux <<'JS'
const task = await taskSpace('example')
const page = task.page('p1')
await page.goto('https://example.com')
cliLog(await page.snapshot({ scope: 'full_page' }))
await task.finish({ keep: [] })
JS
```

The included Compose service supports the same standard-input workflow:

```bash
docker compose build

docker compose run --rm -T ego-lite <<'JS'
const task = await taskSpace('example')
const page = task.page('p1')
await page.goto('https://example.com')
cliLog(await page.snapshot({ scope: 'full_page' }))
await task.finish({ keep: [] })
JS
```

Use `docker compose run` because each invocation represents one agent job and
exits after its input program completes. The Compose service gives Chromium a
larger shared-memory allocation and runs it under a small init process so child
processes are reaped cleanly.

Docker containers can reach services on the host through
`host.docker.internal` in Docker Desktop. On Linux Engine, add
`--add-host=host.docker.internal:host-gateway` when that route is needed.

To retain screenshots or downloads, bind-mount an output directory and use an
absolute container path:

```bash
mkdir -p output
docker run --rm -i -v "$PWD/output:/output" ego-lite-linux <<'JS'
const task = await taskSpace('capture')
const page = task.page('p1')
await page.goto('https://example.com')
await page.screenshot({ path: '/output/example.png', fullPage: true })
cliLog('/output/example.png')
JS
```

The Compose equivalent is:

```bash
docker compose run --rm -T -v "$PWD/output:/output" ego-lite <<'JS'
const task = await taskSpace('capture')
const page = task.page('p1')
await page.goto('https://example.com')
await page.screenshot({ path: '/output/example.png', fullPage: true })
cliLog('/output/example.png')
JS
```

Set `EGO_BROWSER_CHROMIUM_ARGS` to add Chromium flags, or
`EGO_BROWSER_CHROMIUM_PATH` when running the bundled CLI against another Linux
Chromium executable.

## Scope

This repository does not contain the closed-source Ego Lite desktop app. The
container therefore provides the automation runtime rather than a Linux
desktop browser UI. Each task space maps to an isolated Chromium browser
context for the lifetime of one container invocation. Semantic snapshots come
from Chromium's accessibility tree rather than Ego Lite's customized native
snapshot implementation.

The container does not provide the shared human/agent browser UI, Chrome data
migration, existing desktop logins, extensions, visual handoff, or persistent
task spaces across container invocations. `handOff()` and `takeOver()` preserve
the API's ownership state for scripts, but there is no user-facing container UI
to receive a handoff.
