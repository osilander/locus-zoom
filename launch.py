#!/usr/bin/env python3

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
GENERATOR = ROOT / "scripts" / "generate_demo_data.py"
DEFAULT_HOST = os.environ.get("HOST", "127.0.0.1")
DEFAULT_PORT = os.environ.get("PORT", "8765")
REQUIRED_DEMO_FILES = [
    DATA_DIR / "demo.fa",
    DATA_DIR / "demo.fa.fai",
    DATA_DIR / "demo.bam",
    DATA_DIR / "demo.bam.bai",
    DATA_DIR / "demo_compare.bam",
    DATA_DIR / "demo_compare.bam.bai",
    DATA_DIR / "demo_third.bam",
    DATA_DIR / "demo_third.bam.bai",
    DATA_DIR / "demo.vcf",
    DATA_DIR / "demo.gff3",
    DATA_DIR / "manifest.json",
]


def has_pysam() -> bool:
    return importlib.util.find_spec("pysam") is not None


def has_samtools() -> bool:
    candidates = ["samtools.exe", "samtools"] if sys.platform.startswith("win") else ["samtools"]
    return any(shutil.which(candidate) for candidate in candidates)


def missing_demo_files() -> list[Path]:
    return [path for path in REQUIRED_DEMO_FILES if not path.exists()]


def ensure_demo_data():
    missing = missing_demo_files()
    if not missing:
        print("Demo data found.")
        return

    print("Demo data is missing. Generating demo data now...")
    if not has_samtools():
        formatted = "\n".join(f"- {path.name}" for path in missing)
        raise SystemExit(
            "Cannot generate demo data because samtools is not installed.\n"
            "Install samtools first, then rerun launch.py.\n"
            f"Missing files:\n{formatted}"
        )

    subprocess.run([sys.executable, str(GENERATOR)], cwd=str(ROOT), check=True)
    print("Demo data generated.")


def check_runtime_backend():
    if has_pysam():
        print("Backend: pysam")
        return
    if has_samtools():
        print("Backend: samtools")
        return
    raise SystemExit(
        "No supported backend found.\n"
        "Install Python dependency `pysam` with:\n"
        "  python3 -m pip install -r requirements-production.txt\n"
        "or install `samtools` and rerun launch.py."
    )


def main():
    os.chdir(ROOT)
    print("Locus Zoom launcher")
    print(f"Expected URL: http://{DEFAULT_HOST}:{DEFAULT_PORT}")
    check_runtime_backend()
    ensure_demo_data()
    print("Starting server. Press Ctrl+C to stop.")

    import server

    server.main()


if __name__ == "__main__":
    main()
