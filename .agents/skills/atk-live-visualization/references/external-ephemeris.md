# External ephemeris and stitched mission scenes

Read this when trajectories are computed by a separate solver or contain transfer/dwell arcs that cannot be represented by one native propagator state.

## Separate calculation from playback

Treat the external solver as the source of truth. ATK is the player and independent inspector. Record the force model, epoch, coordinate frame, units, integrator, sampling interval, manoeuvre convention, and target matching tolerance alongside the scene.

For rendezvous, verify at each arrival that position matches before the arrival burn and velocity matches after it. Do not infer rendezvous from two colored points that merely look close.

## Ephemeris bundle

Keep a self-contained ASCII staging bundle:

```text
ascii-stage/
|-- Mission.atk
`-- ephemeris/
    |-- Chaser.e
    |-- Target1.e
    `-- Target2.e
```

Every absolute path embedded in `Mission.atk` must point to the staged bundle. Copying only the scene file while leaving `.e` files behind produces objects with missing or zero state.

A compatible time-position-velocity ephemeris has this shape:

```text
stk.v.9.0

BEGIN Ephemeris
NumberOfEphemerisPoints 101
ScenarioEpoch 1 Jan 2020 00:00:00.000000
InterpolationMethod Lagrange
CentralBody Earth
CoordinateSystem J2000
DistanceUnit Kilometers

EphemerisTimePosVel
0.000 x y z vx vy vz
10.000 x y z vx vy vz
...
END Ephemeris
```

Require strictly increasing times, finite nonzero state, declared point count equal to actual rows, and coverage of the intended scenario window. Use km and km/s when `DistanceUnit Kilometers` is declared.

At stitched arc boundaries, keep position continuous and avoid duplicate timestamps. An impulsive velocity discontinuity can be distorted by polynomial interpolation; for precision analysis use separate arcs or an ATK mechanism that preserves manoeuvre breaks. A single dense ephemeris is acceptable for visualization only after checking the interpolated result around each join.

## Robust ATK 4.0 scene authoring

Prefer creating or exporting one known-good ATK object and cloning its XML structure over inventing a scene schema. In the verified fallback used for stitched missions:

- a LaunchVehicle-style object was cloned from an ATK 4.0 template;
- its external-state filename and epoch were replaced;
- the sampled states were also embedded in `HistoryData`;
- `HistoryData.Num` matched the number of data rows;
- the scenario and every object shared one epoch and time interval.

Embedding history is a fallback for ATK builds where an accepted external state still displays zero position. Always prove the resulting state with `Position` or exported object data.

## XML graphics fallback

Prefer high-level CONNECT display tools. When a generated `.atk` must carry display settings itself, the verified fields are:

- `GfxShowGndTrack=0`
- `GfxShow3DGndTrack=0`
- `GfxShowLabel=0` or `1`
- `GfxShowOrbit=1`
- `GfxLineWidth`
- `GfxColor`
- `GfxModel ShowModel="0" ShowPoint="1" PointSize="..."`

CONNECT accepts `%RRGGBB` colors. Direct XML in this ATK build stores signed BGR-style values; known values are red `-16776961`, yellow `-16711681`, cyan `-256`, magenta `-65281`, green `-16711936`, and blue `-65536`. Do not mix the two representations.

## Load strategy

Prefer `load_scenario_unicode_safe` for an ordinary saved scene. For a generated external-ephemeris bundle, preserve the whole ASCII directory and first test loading in a disposable or authorized instance.

If loading into an already-running ATK repeatedly crashes that process, stop retrying. With user authorization, close only the exact intended PID and directly launch `ATK.exe` with the staged scene path. Then attach the session to the new PID, inspect runtime state, verify positions and display, reset/start animation, and leave it open.

Never use a stale PID, never close unrelated ATK windows, and never report direct launch as successful until the window title, object tree, state, and animation have been observed.
