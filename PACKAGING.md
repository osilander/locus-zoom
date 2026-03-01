# Desktop Packaging

This repository now includes a Tauri desktop scaffold in `src-tauri/`.

## What is ready

- A Tauri shell that launches the local Python backend and opens the app at `http://127.0.0.1:8765`
- A production Python dependency file in `requirements-production.txt` that uses `pysam` so the backend can run without external `samtools`
- Tauri bundle targets configured for:
  - macOS `dmg`
  - Windows `msi`

## What you still need before shipping signed installers

### macOS

- An Apple Developer account
- A Developer ID Application certificate installed in the build keychain
- Notarization credentials configured in CI or on the release machine

Typical environment variables for automated macOS builds:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

### Windows

- A code-signing certificate (`.pfx`)
- The certificate password

Typical environment variables for automated Windows builds:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

## Recommended release flow

1. Build the Python runtime bundle with `pysam` included.
2. Add that bundled runtime to the Tauri resources.
3. Build the Tauri desktop bundle on each target OS.
4. Sign the installer on the native target platform.
5. Notarize the macOS build.

## Important limitation

This repository does not yet include:

- a bundled Python interpreter
- a PyInstaller / Nuitka / embedded Python packaging step
- CI secrets or platform signing identities

So the project is structurally prepared for packaging, but final signed installers still depend on your signing credentials and release infrastructure.
