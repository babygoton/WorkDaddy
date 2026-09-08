# Local react-hot-toast runtime

WorkDaddy bundles react-hot-toast 2.6.0, React / React DOM 18.3.1 and goober 2.1.18 in `scripts/toast-runtime.js`. Runtime startup needs no npm install, CDN, or React object from WorkBuddy. Production dependencies and their MIT licenses are embedded in that generated file.

To rebuild after editing this directory:

```sh
npm ci --ignore-scripts --prefix tools/toast-runtime
node tools/toast-runtime/build.mjs
```

The adapter uses the upstream `Toaster` / `ToastBar` with `bottom-center` placement and an isolated React root. goober's supported `target` binding directs its styles and keyframes into the toast shadow root. WorkBuddy theme variables inherit through the host. Reinjection unmounts the React tree, clears the toast store, and removes the host and styles. React is bundled privately; official WorkBuddy components and state are never modified.

Automation protocol:

```json
[
  { "op": "notify.toast", "level": "loading", "message": "正在处理…", "id": "progress" },
  { "op": "logic.delay", "ms": 1500 },
  { "op": "notify.toast", "level": "success", "message": "任务完成", "id": "progress", "duration": 4200 }
]
```

Levels: `info`, `success`, `warning`, `error`, `loading`. `duration` is an integer in milliseconds, 1000–60000; ordinary notifications default to 4200 ms and loading notifications persist until updated, dismissed, or the run ends. Reusing an `id` updates that notification. `{ "op": "notify.dismiss", "id": "progress" }` dismisses it. `saveAs` retains `{ok,id}` for interpolation as `{{vars.<name>.id}}`. IDs are isolated per run. Delivery is acknowledged by the renderer; disconnected or missing notification components cause the step to fail. User-facing message content is not added to automation logs.
