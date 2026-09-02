---
name: atk-live-visualization
description: Build, load, verify, display, and play live ATK 4.0 scenes through ATK Agent CLI, including externally computed ephemerides. Use when a user wants to see spacecraft, debris, orbit tracks, rendezvous animation, or an already-built ATK scene in the live application. Do not use for orbital-theory-only questions that require no ATK scene.
---

# ATK Live Visualization

Produce a live, inspectable ATK result—not merely an XML/ATK file. Use the repository's deterministic CLI tools for stateful control and use UI automation only for camera operations that ATK 4.0 CONNECT cannot verify.

## Route the task

- For ordinary ATK objects defined by classical or Cartesian state, follow [references/agent-workflow.md](references/agent-workflow.md).
- For trajectories solved outside ATK, stitched transfers, rendezvous arcs, or an existing `.e`/`.atk` bundle, also read [references/external-ephemeris.md](references/external-ephemeris.md).
- When anything is missing, zero, invisible, frozen, or resource-heavy, read [references/troubleshooting.md](references/troubleshooting.md) before retrying.

## Non-negotiable checks

1. Inspect the real ATK runtime and attach to the intended PID. Never assume the most recent window is the right instance.
2. Estimate scene cost before creating large catalogs. Object count multiplied by time samples is the controlling cost.
3. Never accept a CONNECT `OK` as proof of a valid orbit. Read `Position` at the start time and at a later time; reject zero, non-finite, static, or implausible states.
4. Never accept a graphics command as proof of on-screen visibility. Read back display state, then visually inspect the live 3D view.
5. Use a pure-ASCII staging directory for every file path passed to ATK. Copy final artifacts back to the user's requested path afterward.
6. For small orbital objects, prefer visible 3D points with models off, orbit lines on, labels only when useful, and ground tracks off unless requested.
7. Reset and start animation, confirm that the clock advances, and leave the final ATK window open. Do not stop the daemon, sidecar, or ATK process unless the user asks.

## Default visual language

Use distinct colors and do not let a thick chaser line cover target tracks:

- chaser/servicer: red, orbit width about 3, point size 32–40;
- targets/debris: distinct yellow, cyan, magenta, green, or blue, orbit width about 4–5, point size 16–24;
- models: off for tiny LEO objects unless their scale has been verified;
- ground tracks: off for a space-distribution view;
- labels: off for dense scenes, on for a few objects when identification matters.

At rendezvous, the chaser point should overlap the target. During a co-flight/dwell arc, continued overlap is expected and should not be reported as a missing object.

## Completion evidence

Before reporting success, establish all of the following:

- the expected scenario and object paths exist in the live ATK object tree;
- each moving object has nonzero valid position at meaningful times;
- scenario start, stop, and animation step match the mission;
- point/model/orbit/label/color settings read back as intended;
- the 3D view visibly contains the objects or tracks after camera adjustment;
- the clock visibly advances after reset/start;
- the final scene is saved with an explicit policy and the final window remains open.

If camera framing is the only unresolved item, say so explicitly. ATK 4.0 CONNECT has no verified general fit-all camera command, so property verification alone cannot prove pixels are on screen.
