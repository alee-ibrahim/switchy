# Roadmap

## Phase 2: auto-framing (built, 2026-11-11)

See [tracking.md](tracking.md#auto-framing-optional-per-room). Sequence per room:

```
mic on -> cut to wide -> recall seat preset -> settle -> [auto-frame: grab, detect, one move, video settle] -> cut to PTZ
```

Code: `src/engine/autoframe/` (`yunet.ts` detector, `calibration.ts`, `framing.ts`, `phase.ts`, `refiner.ts`). It is injected into the engine as `ControllerDeps.refiner` plus `refinePrepare` (pre-opens the NDI receiver).

Follow-ups:

- **Preset settle on the P100.** The controller still waits the fixed `settleMs` (2.5 s) after a recall, because VISCA position and completion are unreliable on this camera. The video-still detector (`waitVideoStill`) could replace that fixed wait as well: most of the time from mic-on to cut is spent here, not in auto-framing.
- **Person fallback.** Only faces are detected. A seated delegate in full profile, or looking down at papers, may give no face, and then the preset framing is kept. If that turns out to be common, add a small person/head detector with a permissive licence as a fallback.
- **Tilt calibration** read about 10% low at zoom 9500 in the live trials (pan was within about 3%). It is well inside the deadband, but sampling more tilt deltas would tighten it.
- **Refine thumbnail.** The live view could show the refine result as a thumbnail. Today it is only in the event log.

## Phase 3: active tracking (built, 2026-11-11)

See [tracking.md](tracking.md#active-tracking-optional-per-room). `refine: 'track'` keeps the speaker framed with pan/tilt velocity drive while their mic is the active shot (`src/engine/autoframe/track-controller.ts`: Kalman + ByteTrack-style association, Smith-predicted PD with hysteresis, measured speed table with online scale; `tracker.ts`: 10 Hz loop, watchdog, explicit stops).

Follow-ups:

- **Side profiles / heads turned away.** YuNet loses a face in full profile or looking down; tracking then stops and holds. RTMPose (Apache-2.0) head and shoulder keypoints are a future option to keep the lock in those moments. A CSRT/KCF-style correlation tracker to bridge short gaps was considered, but there is no cheap one in Node without OpenCV, so the loop holds position instead.
- **Speed table per camera.** The P100 table was measured at zoom 8202 (and spot-checked at 5872, where higher levels ran up to 1.6x faster). The online scale absorbs that; a small "measure drive speeds" button would make other camera models plug-and-play.
- **Tracking with the preset settle.** The loop waits the camera's settle time before acquiring; the video-still detector could start it earlier.

## Other follow-ups

- "Switcher" program output mode: receive, decode, mix (real transitions, no hitch) and re-encode, per room. Plug it in behind `ProgramOutput`.
- Split the engine into its own process or pod (hostNetwork) and keep the UI/API as a normal Kubernetes app (see [deploy.md](deploy.md)).
- Native OIDC auth mode.
- Sony CGI driver, if VISCA-over-IP turns out to be locked or needs authentication on the BRC-X400.
- Persist the event log (currently an in-memory ring of 300 entries per room).
- Find out whether the DCen connect dump lists mics that are already on. At the moment Switchy assumes all mics are off after a reconnect.
