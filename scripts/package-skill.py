"""Build a deterministic skill download; contains no runtime data or credentials."""
from pathlib import Path
import zipfile
root = Path(__file__).resolve().parent.parent
source = root / 'skills' / 'subscription-ledger'
target = root / 'public' / 'skills' / 'subscription-ledger.zip'
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
            info = zipfile.ZipInfo(str(path.relative_to(source.parent)), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
print('Skill download packaged')
