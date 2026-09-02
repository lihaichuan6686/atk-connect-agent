# ATK live visualization troubleshooting

Diagnose from state outward: runtime → time coverage → position → display properties → camera → animation. Do not repeatedly rebuild a scene before identifying which layer failed.

## Only the Earth is visible

Possible causes:

- the object exists in the tree but its state is zero;
- the current animation time is outside ephemeris coverage;
- an external file path broke during a move or Unicode-path load;
- the 3D model is too small while point display is off;
- the camera is zoomed or oriented away from the objects.

Check runtime state and positions at start, middle, and end. If states are valid, enable 3D points and orbit lines, turn models off, then adjust the camera visually. Do not rebuild valid dynamics to solve a camera problem.

## Object properties show position and velocity as zero

Treat this as propagation failure even if `SetState` returned `OK`.

- Confirm classical-state semi-major axis is in metres, not kilometres.
- Confirm epoch and scenario time use ATK syntax and overlap.
- Confirm coordinate system and propagator are supported.
- Confirm external ephemeris file paths and point counts.
- Re-run `Position` at explicit times.

The CLI's state setters perform an immediate nonzero-position assertion. If this assertion fails, repair the orbit input or use the external-ephemeris workflow; do not style the object yet.

## A strange red line appears on the Earth

That is usually a ground track, not the spacecraft. Disable two-dimensional and three-dimensional ground tracks, enable a 3D point, disable the tiny model, and keep the inertial orbit line on.

## Only the red chaser track is visible

Check that every target has orbit display enabled. A thick chaser track can cover nearly co-orbital target tracks; make target lines at least as thick, reduce the chaser line width, use contrasting colors, and rotate the 3D view. At rendezvous and during dwell, overlapping tracks are physically expected.

## Targets are visible but the chaser is not

The chaser may be exactly overlapped with a target, behind Earth, or represented by a sub-pixel model. Use a red point around 32–40 px with the model off. Move the clock away from a dwell interval before concluding it is missing.

## The view zooms into Earth or objects disappear while playing

CONNECT display verification does not validate camera framing. Use screenshot-guided UI control to maximize the correct ATK window, reset/home the Earth view, zoom to include the orbit shell, and rotate to separate nearby planes. Avoid hard-coded coordinates unless they were derived from the current screenshot and display scale.

## Animation does not visibly move

Set a suitable scenario step, reset, start, and verify that the clock advances. A very small step over a long interval can appear frozen; a very large step can jump over a rendezvous. For a short teaching scene, 1–10 s is usually visually useful.

## GPU or memory usage explodes

Estimate total points as approximately:

```text
object_count × (duration_seconds / step_seconds + 1)
```

Reduce target count, shorten the scenario, increase the sample step, disable heavy models/labels, or display only shortlisted objects. Build large catalogs in stages. Never continue merely because ATK has not crashed yet.

## Unicode path works inconsistently

ATK 4.0 file commands are fragile with Chinese or special-character paths. Stage the complete dependency bundle under a pure-ASCII absolute directory. Save/copy the finished artifact back to the user's requested location only after ATK has loaded and verified the staged copy.

## CONNECT load crashes ATK

Do not repeat the same load against the same running instance. Confirm the bundle independently. With explicit authorization, replace only the exact affected ATK PID and open the staged scene directly. Attach the new instance and redo all state, display, and animation checks.

## What counts as done

The scene is not done merely because a file exists or CONNECT returned `OK`. Done means valid nonzero motion, correct live object tree, readable display settings, visible 3D result, advancing animation, saved artifacts, and the final ATK window left open for the user.
