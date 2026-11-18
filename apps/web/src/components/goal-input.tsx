'use client';
import {useLayoutEffect,useRef,type TextareaHTMLAttributes} from 'react';

/** Grow with wrapped text, then scroll after eight lines without moving the browser. */
export function GoalInput(props:TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref=useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(()=>{
    const node=ref.current;if(!node)return;
    const resize=()=>{const css=getComputedStyle(node);const line=parseFloat(css.lineHeight)||24;
      const padding=parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+2;
      node.style.height='auto';node.style.height=`${Math.min(Math.max(node.scrollHeight,line*3+padding),line*8+padding)}px`;
      node.style.overflowY=node.scrollHeight>line*8+padding?'auto':'hidden';};
    resize();let width=node.clientWidth;const observer=new ResizeObserver(()=>{if(node.clientWidth!==width){width=node.clientWidth;resize();}});observer.observe(node);return()=>observer.disconnect();
  },[props.value]);
  return <textarea {...props} ref={ref} rows={3} style={{...props.style,resize:'none'}}/>;
}
