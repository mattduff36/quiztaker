import {createHash} from 'node:crypto';

type Target={targetId:string;type:string;url:string;title:string};
export function browserInventoryToken(targets:Target[]) {
  return createHash('sha256').update(JSON.stringify(targets.filter(t=>t.type==='page'&&/^https?:\/\//.test(t.url))
    .map(t=>[t.targetId,t.url,t.title] as const).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}
/** Passive target events only: no page capture, DOM reads, focus or resizing. */
export class BrowserChanges {
  private socket:WebSocket|null=null;private targets=new Map<string,Target>();private connecting=false;
  token:string='offline';
  constructor(private port:number){}
  async connect(){
    if(this.socket||this.connecting)return;this.connecting=true;
    try{
      const response=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(1500)});
      const version=await response.json() as {webSocketDebuggerUrl?:string};
      const address=new URL(version.webSocketDebuggerUrl||'');
      if(address.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(address.hostname)||Number(address.port)!==this.port)throw Error('Unexpected local browser endpoint');
      const socket=new WebSocket(address.href);this.socket=socket;this.targets.clear();
      const opening=setTimeout(()=>{if(socket.readyState===WebSocket.CONNECTING){socket.close();clear();}},3000);
      socket.addEventListener('open',()=>{clearTimeout(opening);socket.send(JSON.stringify({id:1,method:'Target.setDiscoverTargets',params:{discover:true}}));});
      socket.addEventListener('message',event=>{
        try{const value=JSON.parse(String(event.data));const info=value.params?.targetInfo as Target|undefined;
          if(value.method==='Target.targetCreated'||value.method==='Target.targetInfoChanged'){if(info)this.targets.set(info.targetId,info);}
          else if(value.method==='Target.targetDestroyed')this.targets.delete(value.params.targetId);else return;
          this.token=browserInventoryToken([...this.targets.values()]);
        }catch{/* Malformed local notification never becomes a job. */}
      });
      const clear=()=>{clearTimeout(opening);if(this.socket===socket){this.socket=null;this.token='offline';this.targets.clear();}};
      socket.addEventListener('close',clear);socket.addEventListener('error',()=>{socket.close();clear();});
    }catch{this.token='offline';}finally{this.connecting=false;}
  }
  close(){const socket=this.socket;this.socket=null;this.token='offline';this.targets.clear();socket?.close();}
}
