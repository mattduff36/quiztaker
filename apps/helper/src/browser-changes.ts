import {createHash} from 'node:crypto';

type Target={targetId:string;type:string;url:string;title:string};
export function browserInventoryToken(targets:Target[]) {
  return createHash('sha256').update(JSON.stringify(targets.filter(t=>t.type==='page'&&/^https?:\/\//.test(t.url))
    .map(t=>[t.targetId,t.url,t.title] as const).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}
/** Passive target metadata only: reconcile missed title events without page capture, focus or resizing. */
export class BrowserChanges {
  private socket:WebSocket|null=null;private targets=new Map<string,Target>();private connecting=false;
  private disposed=false;private requestId=1;private pending:{id:number;timer:ReturnType<typeof setTimeout>}|null=null;
  token:string='offline';
  constructor(private port:number){}
  async connect(){
    if(this.disposed)return;
    if(this.socket){if(this.socket.readyState===WebSocket.OPEN)this.reconcile(this.socket);return;}
    if(this.connecting)return;this.connecting=true;
    try{
      const response=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(1500)});
      const version=await response.json() as {webSocketDebuggerUrl?:string};
      if(this.disposed)return;
      const address=new URL(version.webSocketDebuggerUrl||'');
      if(address.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(address.hostname)||Number(address.port)!==this.port)throw Error('Unexpected local browser endpoint');
      const socket=new WebSocket(address.href);this.socket=socket;this.targets.clear();
      const opening=setTimeout(()=>{if(socket.readyState===WebSocket.CONNECTING){socket.close();clear();}},3000);
      socket.addEventListener('open',()=>{clearTimeout(opening);socket.send(JSON.stringify({id:1,method:'Target.setDiscoverTargets',params:{discover:true}}));this.reconcile(socket);});
      socket.addEventListener('message',event=>{
        try{const value=JSON.parse(String(event.data));const info=value.params?.targetInfo as Target|undefined;
          if(this.socket!==socket)return;
          if(this.pending&&value.id===this.pending.id){
            clearTimeout(this.pending.timer);this.pending=null;
            if(!Array.isArray(value.result?.targetInfos)){socket.close();clear();return;}
            this.targets=new Map(value.result.targetInfos.map((target:Target)=>[target.targetId,target]));
            this.token=browserInventoryToken([...this.targets.values()]);return;
          }
          if(value.method==='Target.targetCreated'||value.method==='Target.targetInfoChanged'){if(info)this.targets.set(info.targetId,info);}
          else if(value.method==='Target.targetDestroyed')this.targets.delete(value.params.targetId);else return;
          this.token=browserInventoryToken([...this.targets.values()]);
        }catch{/* Malformed local notification never becomes a job. */}
      });
      const clear=()=>{clearTimeout(opening);if(this.socket===socket){if(this.pending)clearTimeout(this.pending.timer);this.pending=null;this.socket=null;this.token='offline';this.targets.clear();}};
      socket.addEventListener('close',clear);socket.addEventListener('error',()=>{socket.close();clear();});
    }catch{this.token='offline';}finally{this.connecting=false;}
  }
  private reconcile(socket:WebSocket){
    if(this.pending)return;
    const id=++this.requestId;
    const timer=setTimeout(()=>{if(this.socket===socket){this.pending=null;this.socket=null;this.token='offline';this.targets.clear();socket.close();}},2500);
    this.pending={id,timer};
    socket.send(JSON.stringify({id,method:'Target.getTargets'}));
  }
  close(){this.disposed=true;if(this.pending)clearTimeout(this.pending.timer);this.pending=null;const socket=this.socket;this.socket=null;this.token='offline';this.targets.clear();socket?.close();}
}
