import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

base = Path('/root/paperclip-deploy')
release = base / 'releases/s7-20261027T0406Z'
state = json.loads((release / 'deployment-state.json').read_text())
source = Path(state['sourceDir'])
updates = {
    'server/src/routes/agents.ts': ('agents.ts', '4a7cb1b85a70fd4823e5a5091fbaefa30ab0490a834f76de5d8699e71215900d'),
    'server/src/services/agent-configuration.ts': ('agent-configuration.ts', '297232da24e35765f1340826b6456f380ce6f645a5586873f9626e8f34580151'),
    'server/src/adapters/member-agent/execute.ts': ('execute.ts', 'c0973f1d246be0b609320e8ac29ac56b56f39df2a85cfeae6e786f4dac04840d'),
}
def run(args):
    return subprocess.check_output(args, cwd=base, text=True).strip()

for name, (upload, digest) in updates.items():
    if hashlib.sha256((release/'uploads'/upload).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Uploaded file hash mismatch: ' + name)
    if hashlib.sha256((source/name).read_bytes()).hexdigest() != state['sourceBeforeSha256'][name]:
        raise RuntimeError('Deployment source changed before update: ' + name)

try:
    for name, (upload, _) in updates.items():
        shutil.copy2(release/'uploads'/upload, source/name)
    source_after = {name: hashlib.sha256((source/name).read_bytes()).hexdigest() for name in updates}
    (release/'source-after.json').write_text(json.dumps(source_after, indent=2))
    print('SOURCE_UPDATE_FILES=' + json.dumps(source_after), flush=True)
    subprocess.check_call(['docker','compose','--progress','plain','build','server'], cwd=base)
    image = run(['docker','image','inspect',state['oldImageName'],'--format','{{.Id}}'])
    candidate_tag = 'paperclip-s7-candidate:s7-20261027-0406'
    subprocess.check_call(['docker','tag',image,candidate_tag])
    check = 'const fs=require("fs"),crypto=require("crypto");const expected='+json.dumps(source_after)+';for(const [p,h] of Object.entries(expected)){const actual=crypto.createHash("sha256").update(fs.readFileSync("/app/"+p)).digest("hex");if(actual!==h)throw Error("Image source mismatch: "+p);}console.log("IMAGE_SOURCE_SHA256_MATCH=3");'
    validation = run(['docker','run','--rm','--network','none','--entrypoint','node',candidate_tag,'-e',check])
    app_id = run(['docker','compose','ps','-q','server'])
    app = json.loads(run(['docker','inspect',app_id]))[0]
    db_id = run(['docker','compose','ps','-q','db'])
    db = json.loads(run(['docker','inspect',db_id]))[0]
    if app['Id'] != state['appBefore']['id'] or app['Image'] != state['oldImageId']:
        raise RuntimeError('Application changed while building')
    if db['Id'] != state['dbBefore']['id'] or db['State']['StartedAt'] != state['dbBefore']['startedAt']:
        raise RuntimeError('Database identity changed while building')
    result = {'built':True,'candidateTag':candidate_tag,'candidateImageId':image,'imageSourceValidation':validation,'sourceSha256':source_after,'appUnchangedDuringBuild':True,'dbUnchangedDuringBuild':True}
    (release/'build-result.json').write_text(json.dumps(result,indent=2))
    print('BUILD_RESULT='+json.dumps(result),flush=True)
except Exception as error:
    for name in updates:
        shutil.copy2(release/'before'/name,source/name)
    subprocess.check_call(['docker','tag',state['rollbackTag'],state['oldImageName']])
    print('BUILD_FAILED_SOURCE_AND_IMAGE_TAG_RESTORED='+type(error).__name__,flush=True)
    raise
