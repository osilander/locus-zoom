# Locus Zoom

Desktop-oriented genome viewer prototype with a web UI and a lightweight local Python API.

## Quick Start

For a new user, the simplest path is:

1. Clone the repository.
2. Change into the project directory.
3. Install the one Python dependency.
4. Run the launcher.

macOS / Linux:

```bash
git clone https://github.com/osilander/locus-zoom.git
cd locus-zoom
python3 -m pip install -r requirements-production.txt
python3 launch.py
```

Windows:

```powershell
git clone https://github.com/osilander/locus-zoom.git
cd locus-zoom
py -3 -m pip install -r requirements-production.txt
py -3 launch.py
```

The launcher will:

- check whether a supported backend is available (`pysam` preferred, `samtools` fallback)
- generate demo data automatically if it is missing
- start the local server
- print the local URL clearly

Then open:

- [http://127.0.0.1:8765](http://127.0.0.1:8765)

If `git` is not convenient, you can also download the repository ZIP from GitHub, extract it, open a terminal in the extracted folder, and then run the same install and launch commands.

## Requirements

- Python 3.10 or newer
- `pysam` installed from `requirements-production.txt` (preferred)
- or `samtools` installed on `PATH` as a fallback
- a modern browser (Chrome, Edge, Safari, Firefox)

This MVP covers three linked workflows:

- explore a reference genome by locus
- inspect mapped alignments from an indexed BAM
- inspect VCF variants in the current window and jump between variants and read evidence

## Why this shape

The UI is a web frontend, but local genomic files are served through a tiny local service layer.
The backend now prefers `pysam` (bundled `htslib`) when available and falls back to external `samtools` only when needed.
That keeps the interface modern while preserving native-path, indexed access for large local FASTA/BAM/VCF files.
The repository now also includes a first-pass Tauri shell scaffold in `src-tauri/`.

## Run

If you want to run the pieces manually instead of using `launch.py`:

1. Clone the repository and change into it.
2. Install the dependency.
3. Generate demo data.
4. Start the app.
5. Open the local URL.

macOS / Linux:

```bash
git clone https://github.com/osilander/locus-zoom.git
cd locus-zoom
python3 -m pip install -r requirements-production.txt
python3 scripts/generate_demo_data.py
python3 server.py
```

Windows:

```powershell
git clone https://github.com/osilander/locus-zoom.git
cd locus-zoom
py -3 -m pip install -r requirements-production.txt
py -3 scripts\generate_demo_data.py
py -3 server.py
```

Or, if you want the manual steps broken out:

1. Generate demo data.

macOS / Linux:

```bash
python3 scripts/generate_demo_data.py
```

Windows:

```powershell
py -3 scripts\generate_demo_data.py
```

2. Start the app.

macOS / Linux:

```bash
python3 server.py
```

Windows:

```powershell
py -3 server.py
```

You can override the bind settings for a packaged or managed run:

macOS / Linux:

```bash
HOST=127.0.0.1 PORT=8765 python3 server.py
```

Windows:

```powershell
$env:HOST="127.0.0.1"; $env:PORT="8765"; py -3 server.py
```

3. Open [http://127.0.0.1:8765](http://127.0.0.1:8765)

## Windows Notes

- The prototype still depends on `samtools` being installed and available on `PATH`.
- On Windows that usually means `samtools.exe`.
- If `pysam` is installed from `requirements-production.txt`, the backend uses that native path and no external `samtools` is required.
- If `pysam` is not installed, the backend checks for `samtools` at startup and returns a clear error if it is missing.

## Health Check

The backend exposes a simple health endpoint for environment debugging:

- [http://127.0.0.1:8765/api/health](http://127.0.0.1:8765/api/health)

It reports:

- the current Python platform string
- which backend is active (`pysam` or `samtools`)
- whether `pysam` is available
- whether `samtools` was found
- the resolved `samtools` executable path

## Demo data

The generator creates:

- `data/demo.fa`
- `data/demo.fa.fai`
- `data/demo.bam`
- `data/demo_compare.bam`
- `data/demo_third.bam`
- `data/demo.bam.bai`
- `data/demo_compare.bam.bai`
- `data/demo_third.bam.bai`
- `data/demo.vcf`
- `data/demo.gff3`
- `data/manifest.json`

The BAMs are synthetic long-read demos and load as three tracks by default so the multi-BAM UI can be exercised.

## Current scope

- single reference assembly at a time
- three demo BAMs, one demo VCF, and one demo GFF wired by default
- live local session loading by file path
- API optimized for local use and small windows
- VCF `ANN` / `CSQ` parsing is shown in the selected-variant panel
- AlphaGenome backend integration exists, but it is intentionally hidden from the UI until result rendering is complete

## Production note

For now, the most realistic “production” release is this repository plus the `launch.py` path above.
An interested user can clone/download it, install one dependency, and run it locally.

This is not yet a polished double-click desktop installer.
That fuller packaging path still needs:

- a packaged Python runtime in the desktop bundle
- platform-native build and signing with your release certificates
- final installer validation on macOS and Windows

## Next architectural steps

- move heavy alignment parsing and summarization off the request thread
- replace the local HTTP wrapper with a Tauri shell bridge
- remove the fallback `samtools` path once the packaged `pysam` runtime is always present
- complete signed installer CI around the new `src-tauri/` scaffold
