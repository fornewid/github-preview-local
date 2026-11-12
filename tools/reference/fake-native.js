// Playwright init script: a fake Tauri bridge over a static export's embedded data, so views that
// only exist in the native window (local checks, Confirm) render in a plain browser for tests.
// Checks "run" for a moment and succeed. Nothing is pushed or written anywhere.
;(() => {
  const callbacks = new Map()
  let next = 1
  const emit = (event, payload) => {
    for (const [id, cb] of callbacks) if (cb.event === event) cb.fn({ event, id, payload })
  }
  window.__TAURI_INTERNALS__ = {
    transformCallback(fn) {
      const id = next++
      callbacks.set(id, { fn })
      return id
    },
    async invoke(cmd, args) {
      const data = window.__PRV_DATA__
      switch (cmd) {
        case 'get_snapshot':
          return data.snapshot
        case 'get_contents':
          return data.contents[`${args.side}:${args.path}`] ?? null
        case 'get_image':
          return data.images?.[`${args.side}:${args.path}`] ?? null
        case 'list_checks':
          return [
            { name: 'lint', run: 'npm run lint', source: '.gh-prv-local.toml' },
            { name: 'unit tests', run: './gradlew testDebugUnitTest --console=plain', source: '.gh-prv-local.toml' },
          ]
        case 'run_check':
          setTimeout(() => emit('check-event', { name: args.name, status: 'running' }), 50)
          setTimeout(() => emit('check-event', { name: args.name, chunk: '> Task :check\nBUILD SUCCESSFUL in 2s\n' }), 150)
          setTimeout(() => emit('check-event', { name: args.name, status: 'success', exitCode: 0 }), 300)
          return null
        case 'plugin:event|listen': {
          const cb = callbacks.get(args.handler)
          if (cb) cb.event = args.event
          return args.handler
        }
        default:
          // load_state, save_state, find_pr, set_zoom, …: nothing to do.
          return null
      }
    },
  }
})()
