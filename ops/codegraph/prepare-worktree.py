#!/usr/bin/env python3
"""Prepare the exact SD2 worktree index, never redirect development to production."""
import datetime, fcntl, hashlib, json, os, pathlib, sqlite3, subprocess, sys, time
BASE=pathlib.Path('/Users/Shared/codegraph-projects')
COMMON=pathlib.Path('/Volumes/Data/Projects/video-api-debugger/.git').resolve()
def run(argv, cwd=None, timeout=30):
    return subprocess.check_output(argv,cwd=cwd,timeout=timeout,text=True,stderr=subprocess.PIPE).strip()
def prepare(requested):
    requested=pathlib.Path(requested).resolve()
    try:
        root=pathlib.Path(run(['git','rev-parse','--show-toplevel'],requested,10)).resolve()
        common=pathlib.Path(run(['git','rev-parse','--path-format=absolute','--git-common-dir'],root,10)).resolve()
    except subprocess.CalledProcessError as error:
        if 'not a git repository' in (error.stderr or ''): return None
        raise
    if common!=COMMON:return None
    key=hashlib.sha256(str(root).encode()).hexdigest()[:20]
    indexes=BASE/'worktree-indexes'; indexes.mkdir(exist_ok=True)
    target=indexes/key; target.mkdir(exist_ok=True)
    with open(indexes/(key+'.lock'),'w') as lock:
        deadline=time.monotonic()+180
        while True:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>deadline:raise RuntimeError('Worktree preparation is already running')
                time.sleep(.2)
        link=root/'.codegraph'
        if link.exists() and not link.is_symlink():
            writer=link/'codegraph.lock'
            if writer.exists():
                try:
                    pid=int(writer.read_text().strip());os.kill(pid,0)
                except (ValueError,ProcessLookupError):pass
                else:raise RuntimeError('Preserving existing index: writer is active')
            link.rename(root/('.codegraph.cg02-backup-'+str(time.time_ns())))
        if link.is_symlink() and link.resolve()!=target:
            raise RuntimeError('Unexpected existing index symlink; preserving it')
        if not link.exists():link.symlink_to(target,target_is_directory=True)
        # Ignore local indexes in all worktrees; never commit databases or symlinks.
        exclude=COMMON/'info/exclude'
        with open(exclude,'a+') as f:
            fcntl.flock(f,fcntl.LOCK_EX);f.seek(0);text=f.read()
            if '/.codegraph*/' not in text:f.write('\n/.codegraph*/\n')
        if not (target/'codegraph.db').exists():
            run(['/Users/gouki-youdoo/.codegraph/versions/v0.9.3/node','--liftoff-only','-e',
                'const C=require("/Users/gouki-youdoo/.codegraph/versions/v0.9.3/lib/dist/index.js").default; C.init(process.argv[1],{index:false}).then(c=>c.destroy()).catch(e=>{console.error(e.message);process.exit(1)})',str(root)],timeout=60)
        before=run(['git','rev-parse','HEAD'],root)
        extensions=set(json.loads(run(['/Users/gouki-youdoo/.codegraph/versions/v0.9.3/node','-e',
            'console.log(JSON.stringify(Object.keys(require("/Users/gouki-youdoo/.codegraph/versions/v0.9.3/lib/dist/extraction/grammars.js").EXTENSION_MAP)))'])))
        cache_path=target/'source-fingerprints.json'
        cache=json.loads(cache_path.read_text()) if cache_path.exists() else {}
        def current_hashes():
            visible=run(['git','ls-files','--cached','--others','--exclude-standard','-z'],root).split(chr(0))
            hashes={}; next_cache={}
            for f in set(visible):
                file=root/f
                if pathlib.Path(f).suffix not in extensions or not file.is_file(): continue
                stat=file.stat(); signature=[stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns]
                previous=cache.get(f)
                if previous and previous['stat']==signature:
                    digest=previous['hash']
                elif f in baseline and stat.st_ctime_ns <= baseline_at_ns and stat.st_size==baseline[f][1] and abs(stat.st_mtime_ns/1000000-baseline[f][2])<2:
                    # Reuse a prior independently verified snapshot only for
                    # files whose inode metadata has not changed since then.
                    digest=baseline[f][0]
                else:
                    digest=hashlib.sha256(file.read_bytes()).hexdigest()
                    after=file.stat()
                    if signature!=[after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns]:
                        raise RuntimeError('Source file changed while reading: '+f)
                hashes[f]=digest;next_cache[f]={'stat':signature,'hash':digest}
            cache.clear();cache.update(next_cache)
            cache_path.write_text(json.dumps(cache)+'\n')
            return hashes
        db=sqlite3.connect(str(target/'codegraph.db'),timeout=5)
        baseline={};baseline_at_ns=0
        prior=target/'source-proof.json'
        if prior.exists():
            verified=json.loads(prior.read_text())
            if verified.get('files',0)>0 and verified.get('hashMismatches')==[] and verified.get('parseErrors')==[]:
                baseline_at_ns=int(datetime.datetime.fromisoformat(verified['checkedAt'].replace('Z','+00:00')).timestamp()*1e9)
                baseline={f:(h,size,modified) for f,h,size,modified,indexed in db.execute('select path,content_hash,size,modified_at,indexed_at from files') if indexed*1000000<=baseline_at_ns}
        def indexed_hashes():
            return dict(db.execute('select path,content_hash from files').fetchall())
        expected=current_hashes()
        removed=sorted(set(indexed_hashes())-set(expected))
        if removed:
            run(['/Users/gouki-youdoo/.codegraph/versions/v0.9.3/node','--liftoff-only','-e',
                'const C=require("/Users/gouki-youdoo/.codegraph/versions/v0.9.3/lib/dist/index.js").default; const c=C.openSync(process.argv[1]); try { c.fileLock.acquire(); for(const f of JSON.parse(process.argv[2])) c.queries.deleteFile(f); } finally { c.fileLock.release(); c.destroy(); }',str(root),json.dumps(removed)],timeout=30)
        if indexed_hashes()!=expected:
            if indexed_hashes():
                run(['codegraph','sync',str(root)],timeout=180)
            if indexed_hashes()!=expected:
                # Full discovery catches clean branch switches, empty indexes,
                # and deleted untracked files absent from git status.
                run(['codegraph','index',str(root),'--quiet'],timeout=240)
        actual=indexed_hashes()
        fresh=current_hashes()
        if expected!=fresh:raise RuntimeError('Source changed during indexing; retry against the current worktree')
        missing=sorted(set(fresh)-set(actual)); extra=sorted(set(actual)-set(fresh))
        bad=[f for f in fresh.keys() & actual.keys() if fresh[f]!=actual[f]]
        errors=[f for f,e in db.execute('select path,errors from files') if e not in (None,'','[]')]
        if missing or extra or bad or errors:
            raise RuntimeError('Index verification failed: '+json.dumps(dict(missing=missing,extra=extra,stale=bad,errors=errors)))
        if before!=run(['git','rev-parse','HEAD'],root):raise RuntimeError('Worktree HEAD changed during sync; retry')
        state=json.loads(run(['codegraph','status',str(root),'--json']))
        if any(state['pendingChanges'].values()):raise RuntimeError('Index reports pending changes after verification')
        branch=run(['git','symbolic-ref','--short','-q','HEAD'],root) if subprocess.run(['git','symbolic-ref','-q','HEAD'],cwd=root,stdout=subprocess.DEVNULL).returncode==0 else '(detached)'
        proof=dict(projectPath=str(root),indexPath=str(target),indexIdentity=str((target/'codegraph.db').stat().st_dev)+':'+str((target/'codegraph.db').stat().st_ino),head=before,sourceFingerprint=hashlib.sha256(json.dumps(expected,sort_keys=True).encode()).hexdigest(),branch=branch,files=state['fileCount'],nodes=state['nodeCount'],edges=state['edgeCount'],pendingChanges=state['pendingChanges'],hashMismatches=bad,missing=missing,extra=extra,parseErrors=errors,checkedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
        (target/'source-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
        return proof
if __name__=='__main__':
    try:
        proof=prepare(sys.argv[1])
        if proof is None:sys.exit(42)
        print(json.dumps(proof,ensure_ascii=False))
    except Exception as e:
        print('CODEGRAPH_WORKTREE_FAILED: '+str(e),file=sys.stderr);sys.exit(1)
