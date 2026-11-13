import concurrent.futures,hashlib,http.server,json,os,pathlib,subprocess,sys,threading,time
assert os.getuid()==0 and os.stat('/proc/self/ns/net').st_ino not in (int(sys.argv[1]),os.stat('/proc/1/ns/net').st_ino),'Only execute in a fresh isolated network namespace'
module=pathlib.Path(sys.argv[2]).resolve().as_uri();subprocess.run(['ip','link','set','lo','up'],check=True)
checks=[];servers=[];uid=65534;seen=[];events={};entered={}
class Server(http.server.ThreadingHTTPServer):allow_reuse_address=True;daemon_threads=True
def serve(port,name):
 class Handler(http.server.BaseHTTPRequestHandler):
  protocol_version='HTTP/1.1'
  def do_GET(self):
   if self.path=='/hold':entered[name].set();assert events[name].wait(30)
   body=name.encode();self.send_response(200);self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close');self.end_headers();self.wfile.write(body);self.close_connection=True
  def do_POST(self):
   body=self.rfile.read(int(self.headers['Content-Length']));seen.append((name,hashlib.sha256(body).hexdigest()));self.send_response(200);self.send_header('Content-Length',str(len(name)));self.send_header('Connection','close');self.end_headers();self.wfile.write(name.encode());self.close_connection=True
  def log_message(self,*args):pass
 events[name]=threading.Event();entered[name]=threading.Event();s=Server(('127.0.0.1',port),Handler);threading.Thread(target=s.serve_forever,daemon=True).start();servers.append(s);return s
program="""import http.client,sys
c=http.client.HTTPConnection('127.0.0.1',int(sys.argv[1]),timeout=35);body=b'request-original-id:'+b'x'*65536
c.request('POST' if sys.argv[2]=='/submit' else 'GET',sys.argv[2],body=body if sys.argv[2]=='/submit' else None);r=c.getresponse();assert r.status==200;print(r.read().decode());c.close()
"""
def request(port,path='/',app=True):
 args=(['runuser','-u','nobody','--'] if app else [])+['/usr/bin/python3','-c',program,str(port),path]
 return subprocess.check_output(args,text=True,timeout=40).strip()
def op(name,*args):
 js="const m=await import(process.argv[1]);const a=JSON.parse(process.argv[2]);console.log(JSON.stringify(m[a[0]](...a.slice(1))));"
 return json.loads(subprocess.check_output(['/usr/bin/node','--input-type=module','-e',js,module,json.dumps([name,*args])],text=True))
def stop(s):s.shutdown();s.server_close();servers.remove(s)
def wait_zero(port):
 for _ in range(100):
  if op('acceptedConnectionCount',port)==0:return
  time.sleep(.05)
 raise AssertionError('Backend connections remain')
try:
 old=serve(3302,'old');temp=serve(3303,'temporary');other=serve(8766,'other');guard=serve(3304,'guard')
 with concurrent.futures.ThreadPoolExecutor() as pool:
  prior=pool.submit(request,3302,'/hold');unrelated=pool.submit(request,8766,'/hold');assert entered['old'].wait(5) and entered['other'].wait(5)
  assert op('acceptedConnectionCount',3302)>0
  op('switchLoopback',3302,3303,uid)
  assert request(3302,'/submit')=='temporary';assert seen==[('temporary',hashlib.sha256(b'request-original-id:'+b'x'*65536).hexdigest())]
  assert request(3302,app=False)=='old';assert not prior.done() and not unrelated.done()
  events['old'].set();assert prior.result()=='old';wait_zero(3302);checks.append('existing old request finishes; late old-port POST keeps exact original bytes and executes once on ready candidate; root readiness remains direct')
  stop(old);canonical=serve(3302,'canonical')
  held=pool.submit(request,3303,'/hold');assert entered['temporary'].wait(5)
  op('switchLoopback',3303,3302,uid);op('clearLoopback',3302,uid)
  assert request(3302)=='canonical' and request(3303)=='canonical' and request(3303,app=False)=='temporary'
  events['temporary'].set();assert held.result()=='temporary';wait_zero(3303);stop(temp)
  assert request(3303)=='canonical';checks.append('canonical becomes ready before legacy candidate-port bridge; existing temporary request finishes and late old-port requests survive candidate retirement')
  future=serve(3303,'future');assert request(3303,app=False)=='future' and request(3303)=='canonical'
  op('switchLoopback',3302,3303,uid);op('clearLoopback',3303,uid)
  assert request(3302)=='future' and request(3303)=='future';checks.append('next release keeps the candidate hidden until ready, then removes the previous legacy bridge without stale routing')
  op('switchLoopback',3302,3304,uid);op('switchLoopback',3303,3304,uid)
  assert request(3302)=='guard' and request(3303)=='guard';assert request(3302,app=False)=='canonical'
  assert not unrelated.done();events['other'].set();assert unrelated.result()=='other';checks.append('fixed guard redirection works; unrelated8766 long request survives every transition without interruption')
  op('clearLoopback',3302,uid);op('clearLoopback',3303,uid)
 print(json.dumps({'schema':'sd2-loopback-namespace-engineering.v1','passed':True,'checks':checks,'networkNamespaceIsolated':True,'hostNetworkRulesChanged':False,'productionDatabaseOpened':False,'paidRequests':0,'moduleSha256':hashlib.sha256(pathlib.Path(sys.argv[2]).read_bytes()).hexdigest()}))
finally:
 for event in events.values():event.set()
 for s in servers:s.shutdown();s.server_close()
