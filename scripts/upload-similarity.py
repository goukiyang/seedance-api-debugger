"""Private, bounded ImageHash fingerprint computation; never edits its input."""
import json
import os
import resource
import sys
import warnings
from importlib.metadata import version

resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
if sys.platform.startswith("linux"):
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
elif sys.platform != "darwin" or __name__ != "actual_upload_fingerprint":
    raise RuntimeError("fingerprint_platform_requires_linux_production_or_explicit_mac_calibration_import")
# Darwin's address-space limits do not provide the Linux hard-limit contract.
# The explicit synthetic-only importer supplies its RSS/wall watchdog instead.
resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
for package, expected in {"ImageHash": "4.3.2", "Pillow": "11.3.0", "numpy": "2.2.6", "scipy": "1.15.3", "PyWavelets": "1.8.0"}.items():
    if version(package) != expected:
        raise RuntimeError("fingerprint_dependency_mismatch")

import imagehash
from PIL import Image, ImageOps

ALGORITHM_VERSION = "imagehash-phash8-colorhash3-exif-alpha-wb-v1"
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
def fingerprint_image(file):
    """One actual algorithm for production jobs and isolated synthetic calibration."""
    with Image.open(file) as original:
        if getattr(original, "n_frames", 1) != 1 or original.info.get("icc_profile") or original.width * original.height > 16_000_000:
            return {"unsupported": True}
        original.load()
        image = ImageOps.exif_transpose(original).convert("RGBA")
        opaque = image.getchannel("A").getextrema() == (255, 255)
        white = Image.new("RGBA", image.size, "white")
        white.alpha_composite(image)
        black = Image.new("RGBA", image.size, "black")
        black.alpha_composite(image)
        return {"algorithmVersion": ALGORITHM_VERSION, "phash": str(imagehash.phash(white.convert("RGB"), hash_size=8)),
                "blackPhash": str(imagehash.phash(black.convert("RGB"), hash_size=8)),
                "colorhash": str(imagehash.colorhash(white.convert("RGB"), binbits=3)),
                "opaque": opaque, "width": image.width, "height": image.height}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise RuntimeError("fingerprint_arguments_invalid")
    file = os.path.realpath(sys.argv[1])
    if not file.startswith("/data/video-api-debugger/") or not 0 < os.path.getsize(file) <= 30 * 1024 * 1024:
        raise RuntimeError("fingerprint_source_boundary")
    print(json.dumps(fingerprint_image(file)))
