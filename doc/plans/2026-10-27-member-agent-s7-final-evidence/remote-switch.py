import datetime
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

base = Path('/root/paperclip-deploy')
release = base/'releases/s7-20261027T0406Z'
state = json.loads((release/'deployment-state.json').read_text())
build = json.loads((release/'build-result.json').read_text())
confirmed = datetime.datetime.fromisoformat('2026-10-27T11:57:00+08:00')
now = datetime.datetime.now(datetime.timezone.utc)
if not 0 <= (now-confirmed).total_seconds() <= 1800:
    print('STOP_BEFORE_CUTOVER: owner active-run confirmation expired; request fresh confirmation')
    raise SystemExit(42)

def run(args):
    return subprocess.check_output(args,cwd=base,text=True).strip()

def container(service):
    identity=run(['docker','compose','ps','-q',service])
    return json.loads(run(['docker','inspect',identity]))[0]

def database_unchanged():
    db=container('db')
    return db['Id']==state['dbBefore']['id'] and db['State']['StartedAt']==state['dbBefore']['startedAt']

def health():
    with urllib.request.urlopen('http://127.0.0.1:3100/api/health',timeout=4) as response:
        result=json.load(response)
        return {'httpStatus':response.status,'status':result.get('status'),'deploymentMode':result.get('deploymentMode')}

def wait_health():
    for attempt in range(30):
        try:
            value=health()
            if value['httpStatus']==200 and value['status']=='ok' and value['deploymentMode']=='authenticated':
                return value
        except (OSError,ValueError):
            pass
        time.sleep(2)
    raise RuntimeError('Application health did not become ok/authenticated')

app=container('server')
if app['Id']!=state['appBefore']['id'] or app['Image']!=state['oldImageId'] or not database_unchanged():
    raise RuntimeError('Application/database identity changed before cutover')
tagged=run(['docker','image','inspect',state['oldImageName'],'--format','{{.Id}}'])
if tagged!=build['candidateImageId']:
    raise RuntimeError('Compose image tag does not match validated candidate')

try:
    switch=run(['docker','compose','up','-d','--no-deps','--no-build','--force-recreate','server'])
    live=wait_health()
    if not database_unchanged():
        raise RuntimeError('Database container changed')
    connection=http.client.HTTPConnection('127.0.0.1',3100,timeout=5)
    connection.request('GET','/api/member-agent/v1/connect',headers={
        'Connection':'Upgrade','Upgrade':'websocket','Sec-WebSocket-Version':'13',
        'Sec-WebSocket-Key':'cGFwZXJjbGlwLXM3LXRlcw==',
    })
    response=connection.getresponse()
    no_key_status=response.status
    response.read()
    connection.close()
    if no_key_status!=401:
        raise RuntimeError('Member entry without Key returned '+str(no_key_status))
    app=container('server')
    if app['Image']!=build['candidateImageId']:
        raise RuntimeError('Running image is not validated candidate')
    db=container('db')
    result={'deployed':True,'cutoverStartedAt':now.isoformat(),'ownerActiveRunConfirmedAt':confirmed.isoformat(),
            'health':live,'memberNoKeyHttpStatus':no_key_status,'appAfter':{'id':app['Id'],'imageId':app['Image'],'startedAt':app['State']['StartedAt'],'status':app['State']['Status']},
            'dbBefore':state['dbBefore'],'dbAfter':{'id':db['Id'],'startedAt':db['State']['StartedAt'],'status':db['State']['Status']},
            'dbUnchanged':True,'rollbackTag':state['rollbackTag'],'sourceBackup':state['sourceBackup'],'sourceSha256':build['sourceSha256']}
    (release/'deployment-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
except Exception as error:
    for name in state['sourceBeforeSha256']:
        shutil.copy2(release/'before'/name,Path(state['sourceDir'])/name)
    subprocess.check_call(['docker','tag',state['rollbackTag'],state['oldImageName']])
    rollback=run(['docker','compose','up','-d','--no-deps','--no-build','--force-recreate','server'])
    restored_health=wait_health()
    restored_app=container('server')
    result={'deployed':False,'failure':str(error),'rolledBack':restored_app['Image']==state['oldImageId'],
            'rollbackTag':state['rollbackTag'],'healthAfterRollback':restored_health,'dbUnchanged':database_unchanged()}
    (release/'deployment-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
    raise
