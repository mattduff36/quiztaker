import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import type sharp from 'sharp';
import { assertRemoteInput, sameRemoteGeometry, type RemoteFrame, type RemoteGeometry, type RemoteInput } from '@quiztaker/core/remote';
import { getAutomationRoot } from './config.js';

const require=createRequire(import.meta.url);
type BrowserTools={browserTargetId:(page:Page)=>Promise<string>;selectBrowserPage:(pages:Page[],index:number,id:string)=>Promise<Page>};
export class RemoteBrowser {
  private browser:Browser|null=null;
  private selected:string|null=null;
  private observed=new WeakSet<Page>();
  private frames=new Map<string,RemoteFrame>();
  private readonly tabs:BrowserTools;
  private readonly capture:(page:Page,geometry:RemoteGeometry,format:string)=>Promise<Buffer>;
  private readonly protect:(page:Page)=>Promise<void>;
  constructor(private readonly endpoint:string, browser?:Browser) {
    const url=new URL(endpoint);
    if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:')throw new Error('Remote browser must use local CDP');
    this.browser=browser??null;
    this.tabs=require(join(getAutomationRoot(),'lib','browser-tabs.js'));
    this.capture=require(join(getAutomationRoot(),'lib','stable-viewport-capture.js')).captureStableViewport;
    this.protect=require(join(getAutomationRoot(),'lib','course-launch.js')).protectSabaPopups;
  }
  private async connection() {
    if(!this.browser?.isConnected()){
      const {chromium}=require(join(getAutomationRoot(),'node_modules','playwright')) as typeof import('playwright');
      this.browser=await chromium.connectOverCDP(this.endpoint,{timeout:5000});
    }
    return this.browser;
  }
  private async geometry(page:Page):Promise<RemoteGeometry> {
    return page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY,url:location.href}));
  }
  async frame(manual:boolean):Promise<RemoteFrame> {
    const browser=await this.connection();
    const pages=browser.contexts().flatMap(context=>context.pages());
    if(!pages.length)throw new Error('No existing course browser tab is open');
    for(const opener of pages)if(!this.observed.has(opener)) {
      this.observed.add(opener);
      opener.on('popup',child=>{void (async()=>{
        const openerId=await this.tabs.browserTargetId(opener);
        if(this.selected!==openerId)return;
        const id=await this.tabs.browserTargetId(child);
        this.selected=id;this.frames.clear();
      })().catch(()=>{});});
    }
    const tabs=[];
    for(const page of pages)tabs.push({id:await this.tabs.browserTargetId(page),title:(await page.title()).slice(0,200),url:page.url()});
    if(!tabs.some(tab=>tab.id===this.selected))this.selected=tabs[0]!.id;
    const page=await this.tabs.selectBrowserPage(pages,0,this.selected!);
    const geometry=await this.geometry(page);
    const pixels=await this.capture(page,geometry,'jpeg');
    const makeJpeg=require(join(getAutomationRoot(),'node_modules','sharp')) as typeof sharp;
    const jpeg=await makeJpeg(pixels).resize({width:1440,height:1080,fit:'inside',withoutEnlargement:true}).jpeg({quality:50}).toBuffer();
    if(jpeg.length>480_000)throw new Error('Browser image exceeds the private relay limit');
    if(!sameRemoteGeometry(geometry,await this.geometry(page)))throw new Error('Browser changed during capture. Retrying.');
    const frame:RemoteFrame={frameId:randomUUID(),tabId:this.selected!,geometry,jpeg:jpeg.toString('base64'),tabs,capturedAt:Date.now(),manual};
    this.frames.set(frame.frameId,frame);
    for(const [id,old] of this.frames)if(Date.now()-old.capturedAt>8_000 || this.frames.size>12)this.frames.delete(id);
    return frame;
  }
  async input(input:RemoteInput, authorized:()=>boolean,viewOnly=false):Promise<void> {
    assertRemoteInput(input);
    if(viewOnly&&input.type!=='select-tab')throw new Error('View-only access only permits choosing a capture tab');
    const frame=this.frames.get(input.frameId);
    if(!authorized())throw new Error('Manual control expired');
    if(!frame || Date.now()-frame.capturedAt>8_000 || input.tabId!==this.selected || frame.tabId!==input.tabId
      || !sameRemoteGeometry(frame.geometry,input.geometry))throw new Error('Browser image is stale. Wait for a fresh image.');
    const browser=await this.connection();
    const page=await this.tabs.selectBrowserPage(browser.contexts().flatMap(context=>context.pages()),0,input.tabId);
    if(!sameRemoteGeometry(input.geometry,await this.geometry(page)))throw new Error('Browser geometry changed. Wait for a fresh image.');
    if(!authorized())throw new Error('Manual control expired');
    if(!viewOnly)await this.protect(page);
    if(!authorized())throw new Error('Manual control expired');
    switch(input.type) {
      case 'back':await page.goBack({waitUntil:'commit',timeout:5000});break;
      case 'forward':await page.goForward({waitUntil:'commit',timeout:5000});break;
      case 'reload':await page.reload({waitUntil:'commit',timeout:5000});break;
      case 'tap':await page.mouse.click(input.x,input.y);break;
      case 'scroll':await page.mouse.move(input.geometry.width/2,input.geometry.height/2);await page.mouse.wheel(input.x,input.y);break;
      case 'type':await page.keyboard.insertText(input.text);break;
      case 'key':await page.keyboard.press(input.key);break;
      case 'select-tab':{
        const target=await this.tabs.selectBrowserPage(browser.contexts().flatMap(context=>context.pages()),0,input.targetId);
        if(!frame.tabs.some(tab=>tab.id===input.targetId))throw new Error('Tab was not in the current browser image');
        if(!viewOnly){await this.protect(target);await target.bringToFront();}
        this.selected=input.targetId;
        break;
      }
      case 'navigate':await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:5000});break;
    }
    this.frames.clear();
  }
  clear():void {this.frames.clear();}
}
