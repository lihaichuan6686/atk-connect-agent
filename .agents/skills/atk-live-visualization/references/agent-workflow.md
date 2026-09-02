# Agent-driven live ATK workflow

Use this procedure for a live scene managed through `atk-agent-cli`.

## 1. Locate and inspect

Run from the repository root. Use a stable English session id per task.

```powershell
node .\bin\atk-agent.mjs daemon status --session competition
node .\bin\atk-agent.mjs instance list
node .\bin\atk-agent.mjs instance current --session competition
```

If the desired ATK window already exists, attach its exact PID:

```powershell
node .\bin\atk-agent.mjs instance attach --pid 12345 --session competition
```

If no instance exists and the user has authorized creating one:

```powershell
node .\bin\atk-agent.mjs daemon start --session competition --allow-new-atk
```

Keep the same Windows privilege level for the daemon and later CLI calls. A permission mismatch must be repaired; do not start a second daemon as a workaround.

Read real runtime state before mutation:

```powershell
node .\bin\atk-agent.mjs tool call get_atk_runtime_state --session competition --json-args '{}'
```

## 2. Estimate before building

For `N` objects, duration `D`, and sample step `S`, estimate first:

```powershell
node .\bin\atk-agent.mjs tool call estimate_scene_cost --session competition --json-args '{"object_count":4,"duration_seconds":25200,"step_seconds":10}'
node .\bin\atk-agent.mjs tool call check_resource_budget --session competition --json-args '{"object_count":4,"estimated_ephemeris_points":10084}'
```

Shorten the window, increase the step, filter objects, or stage candidates when the estimate approaches configured limits. Do not build a full debris catalog merely to obtain an overview.

## 3. Create or reuse the scene

Prefer idempotent tools:

```powershell
node .\bin\atk-agent.mjs tool call ensure_scenario --session competition --allow-new-atk --json-args '{"name":"MissionDemo","central_body":"Earth"}'
node .\bin\atk-agent.mjs tool call ensure_atk_object --session competition --json-args '{"class_name":"Satellite","name":"Chaser"}'
```

Set scenario time explicitly and then set each orbit. Remember that `set_satellite_classical.sma` is in **metres**, angles are degrees, and times use official ATK date syntax.

Use scene transactions for multi-object mutation. Roll back on partial failures instead of leaving an ambiguous half-built scene.

## 4. Validate dynamics before styling

After every classical or Cartesian state assignment:

```powershell
node .\bin\atk-agent.mjs tool call get_satellite_position --session competition --json-args '{"name":"Chaser","time":"1 Jan 2020 00:00:00.000"}'
node .\bin\atk-agent.mjs tool call get_satellite_position --session competition --json-args '{"name":"Chaser","time":"1 Jan 2020 00:10:00.000"}'
```

The two states must be finite, nonzero, physically plausible, and different for a moving object. A reported `OK` followed by zeros is a failed propagation, not a successful satellite.

For several objects, use `batch_get_positions` and inspect every failure entry.

## 5. Apply 3D display settings

Example for a chaser and three targets:

```powershell
node .\bin\atk-agent.mjs tool call set_point_cloud_display --session competition --json-args '{"paths":["*/Satellite/Chaser"],"show_point":true,"point_size":40,"show_model":false}'
node .\bin\atk-agent.mjs tool call set_point_cloud_display --session competition --json-args '{"paths":["*/Satellite/Target1","*/Satellite/Target2","*/Satellite/Target3"],"show_point":true,"point_size":20,"show_model":false}'
node .\bin\atk-agent.mjs tool call set_orbit_display --session competition --json-args '{"paths":["*/Satellite/Chaser","*/Satellite/Target1","*/Satellite/Target2","*/Satellite/Target3"],"show":true}'
node .\bin\atk-agent.mjs tool call set_label_display --session competition --json-args '{"paths":["*/Satellite/Chaser","*/Satellite/Target1","*/Satellite/Target2","*/Satellite/Target3"],"show":false}'
node .\bin\atk-agent.mjs tool call color_objects_by_attribute --session competition --json-args '{"objects":[{"path":"*/Satellite/Chaser","color":"%FF0000"},{"path":"*/Satellite/Target1","color":"%FFFF00"},{"path":"*/Satellite/Target2","color":"%00FFFF"},{"path":"*/Satellite/Target3","color":"%FF00FF"}]}'
```

Use `batch_set_graphics` for shared two-dimensional visibility, label, orbit, and color settings. Ground-track control is not wrapped by every high-level tool; search the bundled official command catalog before using a raw CONNECT command.

Read back rather than trusting acceptance:

```powershell
node .\bin\atk-agent.mjs tool call verify_object_display_state --session competition --json-args '{"paths":["*/Satellite/Chaser","*/Satellite/Target1","*/Satellite/Target2","*/Satellite/Target3"],"time":"1 Jan 2020 00:10:00.000"}'
```

## 6. Save, play, and inspect

Use an explicit save policy. `save_as` works with Chinese destinations through ASCII staging:

```powershell
node .\bin\atk-agent.mjs tool call save_scenario_with_policy --session competition --json-args '{"mode":"save_as","target_path":"D:\\project\\output\\MissionDemo.atk"}'
node .\bin\atk-agent.mjs tool call reset_simulation --session competition --json-args '{}'
node .\bin\atk-agent.mjs tool call run_simulation --session competition --json-args '{}'
```

Bring the exact managed ATK PID to the foreground. Visually confirm the object tree, 3D points/tracks, and advancing clock. Use screenshot-guided UI actions for maximize, zoom, orbit, and home-view operations; do not reuse blind coordinates from another display or session.

Do not call `daemon stop`, `session close`, or kill ATK at normal completion. The user expects to inspect the live result.

## 7. Loading an existing scene

`load_scenario_unicode_safe` replaces the current scene and therefore requires explicit destructive authorization:

```powershell
node .\bin\atk-agent.mjs tool call load_scenario_unicode_safe --session competition --allow-destructive --json-args '{"source_path":"D:\\project\\output\\MissionDemo.atk"}'
```

After loading, repeat runtime, position, display, animation, and visual checks. A file opening without an error is not enough.
