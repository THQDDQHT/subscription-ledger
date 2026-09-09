"""Copy allowlisted source to a NEW host directory; never user data/venv/secrets."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

root=Path(__file__).resolve().parents[1]
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-i','/opt/data/home/.ssh/id_ed25519_hermes_host','-p','2222','q2qs@127.0.0.1']
target='/home/q2qs/projects/subscription-ledger'
names=['app.py','domain.py','requirements.txt','requirements-dev.txt','README.md','pytest.ini','Dockerfile','compose.yaml','.gitignore','.dockerignore']
for folder in ['templates','static','tests','scripts','docs']:
    names += [str(p.relative_to(root)) for p in (root/folder).rglob('*') if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and p.suffix!='.pyc']
names=sorted(set(names))
manifest={n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names}
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
    for name in names:
        if (root/name).is_symlink(): raise RuntimeError('Refuse source symlink')
        archive.add(root/name,arcname=name,recursive=False)
subprocess.run(ssh+[f'umask 077; mkdir {target} && tar --no-same-owner -xzf - -C {target}'],input=buffer.getvalue(),check=True)
verify="import hashlib,json,pathlib; root=pathlib.Path("+repr(target)+"); expected=json.loads("+repr(json.dumps(manifest))+"); assert all(hashlib.sha256((root/n).read_bytes()).hexdigest()==h for n,h in expected.items()); print('SOURCE_HASH_VERIFIED',len(expected))"
import shlex
subprocess.run(ssh+['python3 -c '+shlex.quote(verify)],check=True)
print('Copied source only to',target)
