# macOS audio routing

Realtime Translate now has platform-aware setup guidance for macOS, but macOS support should be treated as experimental until an end-to-end call is verified with a real virtual audio driver.

## Virtual audio requirement

VB-CABLE A+B is Windows-specific. On macOS, configure two independent virtual audio routes with a driver such as:

- BlackHole: free/open-source, requires manual aggregate or multi-output setup.
- Loopback: paid, easier to create named virtual routes.

The app looks for common virtual audio labels such as BlackHole, Loopback, and Soundflower, then exposes those devices during setup. If pairing is ambiguous, select the virtual input/output routes manually in Step 4.

## Packaging status

The project includes macOS `dmg` and `zip` package targets and a microphone permission usage string. Builds are not yet documented as signed or notarized, so Gatekeeper may require a manual open workaround for local artifacts.

## Verification status

Before claiming production macOS support, verify:

- The wizard detects or offers two usable virtual routes.
- `AudioContext.setSinkId` routes playback to the selected macOS output device in Electron.
- Direction A and Direction B both pass a real call smoke test.
