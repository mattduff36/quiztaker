/** One comparison after a fresh helper heartbeat per return to Operations. */
export class BrowserRefreshGate {
  private eligible=true;private baseline:string|null=null;
  activate(heartbeat?:string|null){this.eligible=true;this.baseline=heartbeat??null;}
  check(input:{paused:boolean;busy:boolean;visible:boolean;focused:boolean;heartbeat?:string;helperToken?:string;snapshotToken?:string|null}){
    if(!this.eligible||input.paused||input.busy||!input.visible||!input.focused||!input.helperToken)return false;
    if(this.baseline&&input.heartbeat===this.baseline)return false;
    this.eligible=false;return input.helperToken!==input.snapshotToken;
  }
}
