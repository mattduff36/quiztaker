'use client';
import {useEffect,useRef,useState} from 'react';
import {PictureInPicture2} from 'lucide-react';

type PipVideo=HTMLVideoElement&{webkitSupportsPresentationMode?:(mode:string)=>boolean;webkitSetPresentationMode?:(mode:string)=>void;webkitPresentationMode?:string};
/** A local video of decrypted preview frames; no recording or extra media service. */
export function BrowserPictureInPicture(props:{jpeg:string;controlsHidden?:boolean;disabled:boolean;onOpen?:()=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),video=useRef<PipVideo>(null);
  const [ready,setReady]=useState(false),[message,setMessage]=useState('');
  const supported=useRef(false);
  useEffect(()=>{
    const c=canvas.current,v=video.current;
    if(!c||!v||!c.captureStream||(!v.requestPictureInPicture&&!v.webkitSetPresentationMode))return;
    supported.current=true;
    const stream=c.captureStream(2);v.srcObject=stream;
    const loaded=()=>{setReady(true);void v.play().catch(()=>setReady(false));};
    v.addEventListener('loadedmetadata',loaded);
    const background=()=>{
      if(!document.hidden)return;
      const ctx=c.getContext('2d');if(!ctx)return;
      ctx.fillStyle='#0f172a';ctx.fillRect(0,0,c.width,c.height);
      ctx.fillStyle='#fff';ctx.font=`${Math.max(16,c.width/32)}px sans-serif`;ctx.textAlign='center';
      ctx.fillText('Preview paused — return to Vitriol',c.width/2,c.height/2,c.width-24);
    };
    document.addEventListener('visibilitychange',background);
    return()=>{
      document.removeEventListener('visibilitychange',background);v.removeEventListener('loadedmetadata',loaded);
      stream.getTracks().forEach(track=>track.stop());v.srcObject=null;
      if(document.pictureInPictureElement===v)void document.exitPictureInPicture().catch(()=>{});
    };
  },[]);
  useEffect(()=>{
    const c=canvas.current;if(!c||!supported.current||document.hidden)return;
    let disposed=false;const image=new Image();
    image.onload=()=>{if(disposed||document.hidden)return;if(c.width!==image.width)c.width=image.width;if(c.height!==image.height)c.height=image.height;c.getContext('2d')?.drawImage(image,0,0);};
    image.src=`data:image/jpeg;base64,${props.jpeg}`;
    return()=>{disposed=true;image.onload=null;};
  },[props.jpeg]);
  async function open() {
    const v=video.current;if(!v||!ready||props.disabled)return;
    try{
      if(v.requestPictureInPicture&&document.pictureInPictureEnabled)await v.requestPictureInPicture();
      else if(v.webkitSupportsPresentationMode?.('picture-in-picture'))v.webkitSetPresentationMode?.('picture-in-picture');
      else throw new Error('unsupported');
      setMessage('');props.onOpen?.();
    }catch{setMessage('This browser cannot open a system pop-out. Use Float preview to keep it beside your task.');}
  }
  return <div className={props.controlsHidden?'hidden':'space-y-2 border-t border-slate-200 p-4 sm:px-6'}>
    <canvas ref={canvas} className="hidden"/>
    <video ref={video} muted playsInline autoPlay aria-hidden="true" className="pointer-events-none fixed h-px w-px opacity-0"/>
    {ready?<button type="button" disabled={props.disabled} onClick={()=>void open()} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40"><PictureInPicture2 className="size-4" aria-hidden="true"/>System pop-out</button>:null}
    <p className="text-xs leading-5 text-slate-600">Float preview stays beside your task. A system pop-out is available in supported browsers; iPhone may pause updates when you switch apps.</p>
    {message?<p role="status" className="text-sm text-slate-700">{message}</p>:null}
  </div>;
}
