# kevin9327.github.io

**[Open it →](https://kevin9327.github.io)** — every day of the last year on GitHub, standing up as a tower. Real contribution data, rendered live in WebGL.

- Drag to orbit, scroll to zoom, hover a tower to see the day.
- `space` pauses the orbit, `r` resets the view.
- The same skyline is pre-rendered in Blender on the [profile README](https://github.com/kevin9327/kevin9327); this page is the interactive version.

## How it works

- `index.html` + `main.js`: three.js (ES modules from jsDelivr, no build step). One `InstancedMesh` holds all 365 towers; each instance carries its own tint, and a small shader patch lets that tint drive the emissive glow as well as the diffuse colour. `UnrealBloomPass` does the rest.
- `data/contrib.json`: the raw `contributionCalendar` from the GitHub GraphQL API.
- `.github/workflows/refresh.yml`: refetches the calendar every day and commits it when it changed, so the city keeps growing on its own.

MIT.
