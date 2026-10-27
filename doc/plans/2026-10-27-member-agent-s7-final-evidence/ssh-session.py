"""Interactive deployment SSH session. Password stays in memory; no shell history."""
import base64
import getpass
import hashlib
import json
from pathlib import Path
import time
import paramiko

BASE = Path(__file__).resolve().parent / 'ssh-queue'
BASE.mkdir(exist_ok=True)
PIN = 'SHA256:6mDFJhPLlx3y73DUIGC/xIPI1o/6vNx2UcY5qroqmxQ'

class PinnedHost(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        actual = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if actual != PIN:
            raise RuntimeError('SSH host fingerprint changed; stopping before authentication')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(PinnedHost())
password = getpass.getpass('192.168.0.213 root SSH password (hidden): ')
try:
    client.connect('192.168.0.213', username='root', password=password,
                   allow_agent=False, look_for_keys=False, timeout=15, auth_timeout=30)
finally:
    password = None
(BASE / 'ready.json').write_text(json.dumps({'connected': True, 'pinnedFingerprint': PIN}), encoding='utf-8')
print('SSH_CONNECTED. Keep this terminal open. No password is saved.', flush=True)
try:
    while client.get_transport() and client.get_transport().is_active():
        requests = sorted(BASE.glob('*.request.json'))
        pending = [p for p in requests if not p.with_name(p.name.replace('.request.json', '.result.json')).exists()]
        if not pending:
            time.sleep(0.5)
            continue
        for request in pending:
            out = request.with_name(request.name.replace('.request.json', '.result.json'))
            try:
                data = json.loads(request.read_text(encoding='utf-8-sig'))
                if data['operation'] == 'close':
                    out.write_text(json.dumps({'exit': 0, 'closed': True}), encoding='utf-8')
                    client.close()
                    break
                if data['operation'] == 'upload':
                    with client.open_sftp() as sftp:
                        for item in data['files']:
                            sftp.put(item['local'], item['remote'])
                    result = {'exit': 0, 'uploaded': len(data['files'])}
                elif data['operation'] == 'exec':
                    _, stdout, stderr = client.exec_command(data['command'], timeout=data.get('timeout', 900))
                    # Read both streams concurrently to avoid blocking a verbose build.
                    channel = stdout.channel
                    stdout_chunks, stderr_chunks = [], []
                    while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
                        if channel.recv_ready(): stdout_chunks.append(channel.recv(65536))
                        if channel.recv_stderr_ready(): stderr_chunks.append(channel.recv_stderr(65536))
                        time.sleep(0.05)
                    result = {'exit': channel.recv_exit_status(), 'stdout': b''.join(stdout_chunks).decode('utf-8', 'replace'),
                              'stderr': b''.join(stderr_chunks).decode('utf-8', 'replace')}
                else:
                    raise RuntimeError('Unsupported operation')
                out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
                print(request.stem + ': exit=' + str(result['exit']), flush=True)
            except Exception as error:
                out.write_text(json.dumps({'exit': 1, 'errorType': type(error).__name__}), encoding='utf-8')
                print(request.stem + ': failed (' + type(error).__name__ + ')', flush=True)
finally:
    client.close()
    print('SSH_SESSION_CLOSED', flush=True)
