#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


TASKS_VISION_VERSION = "0.10.33"
TASKS_VISION_TARBALL_URL = (
    "https://registry.npmjs.org/@mediapipe/tasks-vision/-/"
    f"tasks-vision-{TASKS_VISION_VERSION}.tgz"
)
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)
MODEL_FILENAME = "face_landmarker_v2_with_blendshapes.task"


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def extract_tgz(archive_path: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination)


def move_tree_contents(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def setup_vendor(repo_root: Path, force: bool) -> None:
    vendor_dir = repo_root / "vendor"
    package_dir = vendor_dir / "package"
    tracking_dir = repo_root / "tracking"
    model_path = tracking_dir / MODEL_FILENAME

    with tempfile.TemporaryDirectory(prefix="nijikan-vendor-") as tmp:
        tmp_dir = Path(tmp)
        tarball_path = tmp_dir / "tasks-vision.tgz"
        extract_root = tmp_dir / "extract"

        print(f"[setup_vendor] downloading @mediapipe/tasks-vision {TASKS_VISION_VERSION}")
        download(TASKS_VISION_TARBALL_URL, tarball_path)
        extract_tgz(tarball_path, extract_root)

        extracted_package_dir = extract_root / "package"
        if not extracted_package_dir.exists():
            raise RuntimeError(f"package directory not found in archive: {extracted_package_dir}")

        print(f"[setup_vendor] installing vendor package -> {package_dir}")
        move_tree_contents(extracted_package_dir, package_dir)

        if force or not model_path.exists():
            print(f"[setup_vendor] downloading face landmarker model -> {model_path}")
            download(MODEL_URL, model_path)
        else:
            print(f"[setup_vendor] model already exists, keeping: {model_path}")

    print("[setup_vendor] done")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Set up MediaPipe vendor assets for nijikan.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redownload the face landmarker model even if it already exists.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Path to the nijikan repository root.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    try:
        setup_vendor(repo_root, force=bool(args.force))
    except Exception as exc:  # pragma: no cover - CLI path
        print(f"[setup_vendor] failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
