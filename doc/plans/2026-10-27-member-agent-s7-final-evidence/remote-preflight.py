import hashlib
import json
import pathlib
import subprocess

def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

base = '/root/paperclip-deploy'
app_id = run(['docker', 'compose', 'ps', '-q', 'server'], base)
db_id = run(['docker', 'compose', 'ps', '-q', 'db'], base)
if not app_id or not db_id:
    raise RuntimeError('Expected app and DB services not found')
app = json.loads(run(['docker', 'inspect', app_id]))[0]
db = json.loads(run(['docker', 'inspect', db_id]))[0]
labels = app['Config']['Labels']
cwd = labels.get('com.docker.compose.project.working_dir', base)
configs = labels['com.docker.compose.project.config_files'].split(',')
compose = ['docker', 'compose']
for config in configs:
    compose += ['-f', config]
project = labels['com.docker.compose.project']
compose += ['-p', project]
config = json.loads(run(compose + ['config', '--format', 'json'], cwd))
service = config['services']['server']
build = service.get('build')
source = pathlib.Path(build['context'] if isinstance(build, dict) else build).resolve() if build else None
files = ['server/src/routes/agents.ts', 'server/src/services/agent-configuration.ts', 'server/src/adapters/member-agent/execute.ts']
hashes = {}
if source:
    for name in files:
        p = source / name
        hashes[name] = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
print(json.dumps({
    'composeVersion': run(['docker','compose','version','--short']),
    'composeArgs': compose, 'workingDir': cwd, 'configFiles': configs,
    'build': {k: build[k] for k in ['context','dockerfile','target'] if k in build} if isinstance(build,dict) else build,
    'configuredImage': service.get('image'), 'sourceDir': str(source), 'sourceSha256': hashes,
    'app': {'id':app['Id'],'imageId':app['Image'],'imageName':app['Config']['Image'],'startedAt':app['State']['StartedAt'],'status':app['State']['Status']},
    'db': {'id':db['Id'],'startedAt':db['State']['StartedAt'],'status':db['State']['Status']},
    'disk':run(['df','-h','/']),
}, indent=2))
