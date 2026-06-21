import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LIME = "#4dff6e";
const C = {
  lime:LIME, bg0:"#0b0b0b", bg1:"#111111", bg2:"#181818",
  bg3:"#222222", border:"#2a2a2a", borderH:"#3c3c3c",
  text:"#dedede", muted:"#565656", dim:"#2e2e2e",
  warn:"#ffb347", err:"#ff6767",
};

const NODE_W = 980;
const NODE_H = Math.round(NODE_W * 9 / 16);

// ── Workflow node IDs ─────────────────────────────────────────────────────────
// Shared by both t2i_workflow.json and edit_workflow.json
const WF = {
  model:        "FK:165",   // UNETLoader
  kvCache:      null,       // No KV cache for Z-Image
  textEnc:      "FK:155",   // CLIPLoader
  vae:          "FK:153",   // VAELoader
  promptPos:    "FK:166",   // CLIPTextEncode positive
  promptNeg:    "FK:156",   // CLIPTextEncode negative
  sampling:     "FK:169",   // ModelSamplingAuraFlow — receives model input
  latent:       "FK:170",   // EmptySD3LatentImage (T2I) — width/height set here
  sampler:      "FK:171",   // KSampler — receives seed
  saveImage:    "FK:86",    // SaveImage
};

const LS_KEY = "one_node_z_image_state";
const DEFAULT_NEG_PROMPT = "low quality, deformed, blurry, watermark, ugly, bad anatomy, disfigured, mutated, extra limbs, poorly drawn face, bad proportions, gross proportions, jpeg artifacts, overexposed, underexposed";


// ── Resolution presets (Z-Image-friendly, divisible by 16) ──────────────────────
const RES_PRESETS = [
  { label:"1024 × 1024", w:1024, h:1024 },
  { label:"1920 × 1088", w:1920, h:1088 },
  { label:"1088 × 1920", w:1088, h:1920 },
  { label:"1280 × 720",  w:1280, h:720  },
  { label:"720 × 1280",  w:720,  h:1280 },
  { label:"Custom…",     w:0,    h:0    },
];
function snapRes(v){ return Math.max(16, Math.round(v/16)*16); }

// ── DOM helpers ───────────────────────────────────────────────────────────────
const mk  = (tag,css={},props={}) => { const e=document.createElement(tag); Object.assign(e.style,css); Object.assign(e,props); return e; };
const tx  = (e,t) => { e.textContent=t; return e; };
const cap = (t)   => tx(mk("div",{fontSize:"9px",fontWeight:"700",letterSpacing:".1em",
  textTransform:"uppercase",color:C.muted,marginBottom:"5px"}),t);

// ── Notification sound ────────────────────────────────────────────────────────
function playDone(){
  try{
    const AC=window.AudioContext||/** @type {any} */(window).webkitAudioContext;
    const ctx=new AC();
    // Two soft sine tones: a gentle rising chime
    [[660,0,0.09],[990,0.1,0.07]].forEach(([freq,delay,vol])=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.connect(gain);gain.connect(ctx.destination);
      osc.type="sine";osc.frequency.value=freq;
      gain.gain.setValueAtTime(0,ctx.currentTime+delay);
      gain.gain.linearRampToValueAtTime(vol,ctx.currentTime+delay+0.03);
      gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+delay+0.55);
      osc.start(ctx.currentTime+delay);osc.stop(ctx.currentTime+delay+0.6);
    });
  }catch(e){}
}

function fmtErr(v){
  try{
    if(!v) return "Unknown error.";
    if(typeof v === "string") return v;
    if(v.message) return String(v.message);
    if(v.error){
      if(typeof v.error === "string") return v.error;
      if(v.error.message) return String(v.error.message);
    }
    return JSON.stringify(v);
  }catch(e){ return String(v); }
}

// ── Dimmer ────────────────────────────────────────────────────────────────────
let _dim=null;
const showDimmer=()=>{ if(!_dim){_dim=mk("div",{position:"fixed",inset:"0",background:"rgba(0,0,0,.7)",zIndex:"999990",display:"none",pointerEvents:"none"});document.body.appendChild(_dim);} _dim.style.display="block"; };
const hideDimmer=()=>{ if(_dim)_dim.style.display="none"; };

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle(labelTxt,checked,onChange,activeColor){
  const onClr=activeColor||LIME;
  const onThumb=activeColor?"#fff":"#111";
  const wrap=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",
    padding:"9px 0",borderBottom:`1px solid ${C.border}`});
  const lbl=mk("span",{fontSize:"12px",color:C.text});tx(lbl,labelTxt);
  const track=mk("div",{width:"34px",height:"18px",borderRadius:"9px",
    background:checked?onClr:C.dim,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:"0"});
  const thumb=mk("div",{position:"absolute",top:"2px",left:checked?"16px":"2px",
    width:"14px",height:"14px",borderRadius:"50%",
    background:checked?onThumb:"#888",transition:"left .2s,background .2s"});
  track.appendChild(thumb);
  let val=checked;
  track.onclick=()=>{
    val=!val;track.style.background=val?onClr:C.dim;
    thumb.style.left=val?"16px":"2px";thumb.style.background=val?onThumb:"#888";onChange(val);
  };
  wrap.append(lbl,track);
  const _setChecked=(v)=>{
    val=v;track.style.background=val?onClr:C.dim;
    thumb.style.left=val?"16px":"2px";thumb.style.background=val?onThumb:"#888";
  };
  return{el:wrap,get value(){return val;},_setChecked};
}

// ── Dropdown ──────────────────────────────────────────────────────────────────
function DD(items,selected,onChange){
  let val=selected;
  const wrap=mk("div",{position:"relative",width:"100%",minWidth:"0",overflow:"hidden"});
  const trig=mk("div",{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:"7px",
    padding:"0 8px",height:"28px",display:"flex",alignItems:"center",
    justifyContent:"space-between",cursor:"pointer",boxSizing:"border-box",
    transition:"border-color .15s",userSelect:"none",overflow:"hidden"});
  const trigTxt=mk("span",{fontSize:"11px",color:C.text,overflow:"hidden",
    textOverflow:"ellipsis",whiteSpace:"nowrap",flex:"1",minWidth:"0"});
  tx(trigTxt,val); trigTxt.style.color=val?LIME:C.muted;
  const arr=mk("span",{fontSize:"8px",color:C.muted,marginLeft:"5px",flexShrink:"0",transition:"transform .18s"});
  tx(arr,"▾");
  trig.append(trigTxt,arr);
  const panel=mk("div",{display:"none",position:"fixed",background:C.bg1,
    border:`1px solid ${C.borderH}`,borderRadius:"8px",zIndex:"999999",
    flexDirection:"column",boxShadow:"0 8px 28px rgba(0,0,0,.9)",
    overflow:"hidden",minWidth:"140px",maxWidth:"400px"});
  const srch=mk("input",{background:C.bg2,border:"none",borderBottom:`1px solid ${C.border}`,
      padding:"7px 10px",color:C.text,fontSize:"11px",outline:"none",
      width:"100%",boxSizing:"border-box"},{type:"text",placeholder:"Type to filter…"});
  const list=mk("div",{overflowY:"auto",maxHeight:"200px"});
  const render=q=>{
    const _norm=(s)=>(s||"").replace(/\\/g,"/").toLowerCase();
    list.innerHTML="";
    items.filter(i=>!q||i.toLowerCase().includes(q.toLowerCase())).forEach(item=>{
      const isSel=_norm(item)===_norm(val);
      const r=mk("div",{padding:"7px 12px",fontSize:"11px",cursor:"pointer",
        color:isSel?LIME:C.text,background:isSel?C.bg2:"transparent",
        whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",transition:"background .1s"});
      tx(r,item);
      r.onmouseenter=()=>r.style.background=C.bg3;
      r.onmouseleave=()=>r.style.background=_norm(item)===_norm(val)?C.bg2:"transparent";
      r.onclick=()=>{val=item;tx(trigTxt,item);trigTxt.style.color=item?LIME:C.muted;close();onChange(item);};
      list.appendChild(r);
    });
  };
  const reposition=()=>{
    const rect=trig.getBoundingClientRect();
    panel.style.left=rect.left+"px";
    panel.style.width=Math.max(rect.width,140)+"px";
    const ph=Math.min(items.length*28+44,220);
    panel.style.top=(rect.top-ph-4>8?rect.top-ph-4:rect.bottom+4)+"px";
  };
  const open=()=>{
    document.body.appendChild(panel);panel.style.display="flex";
    reposition();arr.style.transform="rotate(180deg)";
    trig.style.borderColor=LIME;showDimmer();
    srch.value="";srch.focus();render("");
  };
  const close=()=>{
    panel.style.display="none";
    if(panel.parentNode)panel.parentNode.removeChild(panel);
    arr.style.transform="";trig.style.borderColor=C.border;hideDimmer();
  };
  srch.oninput=()=>render(srch.value);
  trig.onclick=e=>{e.stopPropagation();panel.style.display==="flex"?close():open();};
  document.addEventListener("click",e=>{if(!wrap.contains(e.target)&&!panel.contains(e.target))close();});
  trig.onmouseenter=()=>{if(panel.style.display!=="flex")trig.style.background=C.bg2;};
  trig.onmouseleave=()=>{if(panel.style.display!=="flex")trig.style.background=C.bg3;};
  panel.appendChild(srch);
  panel.appendChild(list);
  wrap.appendChild(trig);
  render("");
  return{
    el:wrap,get value(){return val;},
    set(v){val=v;tx(trigTxt,v);trigTxt.style.color=v?LIME:C.muted;render("");},
    updateItems(ni){items=ni;if(!ni.some(i=>(i||"").replace(/\\/g,"/").toLowerCase()===(val||"").replace(/\\/g,"/").toLowerCase())){val=ni[0]||val;tx(trigTxt,val);trigTxt.style.color=val?LIME:C.muted;onChange(val);}render(srch.value||"");},
  };
}

// ── Pill button ───────────────────────────────────────────────────────────────
function Pill(txt,active,onClick){
  const b=mk("button",{
    background:active?LIME:C.bg2,color:active?"#111":C.text,
    border:`1px solid ${active?LIME:C.border}`,
    borderRadius:"20px",padding:"3px 9px",fontSize:"9px",
    fontWeight:active?"700":"400",cursor:"pointer",
    transition:"all .14s",outline:"none",whiteSpace:"nowrap",
  });
  tx(b,txt);
  b.onmousedown=()=>b.style.transform="scale(.95)";
  b.onmouseup=()=>b.style.transform="";
  b.onmouseleave=()=>b.style.transform="";
  b.onclick=onClick;
  return b;
}

// ── Number input ──────────────────────────────────────────────────────────────
function NI(_label,val,min,max,_step,onChange,width="72px"){
  const wrap=mk("div",{
    width,height:"28px",background:C.bg2,border:`1px solid ${C.border}`,
    borderRadius:"6px",boxSizing:"border-box",display:"flex",alignItems:"center",
    padding:"0 7px",transition:"border-color .15s",overflow:"hidden",
  });
  const inp=mk("input",{
    flex:"1 1 0",minWidth:"0",background:"transparent",border:"none",outline:"none",
    color:C.text,fontSize:"11px",padding:"0",textAlign:"left",
  },{type:"number",min:String(min),max:String(max),value:String(val)});
  inp.oninput=()=>{ const v=Math.max(min,Math.min(max,parseFloat(inp.value)||min)); onChange(v); };
  inp.onfocus=()=>{ inp.select(); wrap.style.borderColor=LIME; };
  inp.onblur=()=>{ inp.value=String(Math.max(min,Math.min(max,parseFloat(inp.value)||min))); wrap.style.borderColor=C.border; };
  inp.addEventListener("keydown",e=>{
    if(e.key==="Enter"){ inp.blur(); return; }
    if(e.key==="ArrowUp"||e.key==="ArrowDown"){
      e.preventDefault();
      const step=wrap._arrowStep||8;
      const cur=Math.max(min,Math.min(max,parseFloat(inp.value)||min));
      const next=e.key==="ArrowUp"
        ? Math.min(max, Math.round((cur+step)/step)*step)
        : Math.max(min, Math.round((cur-step)/step)*step);
      inp.value=String(next); onChange(next);
    }
  });
  inp.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
  wrap.appendChild(inp);
  wrap.onclick=()=>inp.focus();
  wrap._inp=inp;
  wrap.setVal=(v)=>{inp.value=String(v);};
  Object.defineProperty(wrap,"numVal",{get(){return parseFloat(inp.value)||min;}});
  return wrap;
}

// ── Remove button ─────────────────────────────────────────────────────────────
function mkRmBtn(){
  const b=mk("button",{
    position:"absolute",top:"4px",right:"4px",width:"18px",height:"18px",
    borderRadius:"50%",background:"rgba(0,0,0,.85)",border:`1px solid ${C.border}`,
    color:"rgba(255,255,255,.7)",fontSize:"9px",cursor:"pointer",display:"none",
    alignItems:"center",justifyContent:"center",padding:"0",
    transition:"background .15s, color .15s, border-color .15s",lineHeight:"1",zIndex:"2",
  });
  tx(b,"✕");
  b.onmouseenter=()=>{ b.style.borderColor=LIME; b.style.color=LIME; };
  b.onmouseleave=()=>{ b.style.borderColor=C.border; b.style.color="rgba(255,255,255,.7)"; };
  return b;
}

// ── Global node-local fullscreen overlay factory (set per node instance) ─────
let _fkActiveFsFactory=null;

// ── Image upload slot ─────────────────────────────────────────────────────────
// Returns {el, name, hasFile(), setDimsLabel(w,h), _restorePreview(name)}
function ImgSlot(optional, onFile, onDims){
  const wrap=mk("div",{
    width:"88px",height:"88px",borderRadius:"12px",
    border:`1.5px dashed ${C.border}`,background:C.bg2,
    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
    cursor:"pointer",position:"relative",
    transition:"border-color .18s, background .18s",
    overflow:"hidden",flexShrink:"0",boxSizing:"border-box",
  });

  // Empty state
  const icoWrap=mk("div",{
    position:"absolute",inset:"0",
    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
    gap:"5px",pointerEvents:"none",
  });
  const ico=document.createElementNS("http://www.w3.org/2000/svg","svg");
  ico.setAttribute("viewBox","0 0 24 24");
  ico.setAttribute("width","24");ico.setAttribute("height","24");
  ico.setAttribute("fill","none");ico.setAttribute("stroke","currentColor");
  ico.setAttribute("stroke-width","1.4");ico.setAttribute("stroke-linecap","round");
  ico.setAttribute("stroke-linejoin","round");
  ico.style.color=C.muted;ico.style.transition="color .18s";ico.style.pointerEvents="none";
  ico.innerHTML=`<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`;
  const lbl=mk("div",{fontSize:"8px",color:C.muted,pointerEvents:"none",letterSpacing:".04em",fontWeight:"600",transition:"color .18s"});
  tx(lbl,"Add image");
  if(optional){
    const optPill=mk("div",{fontSize:"6px",color:C.muted,letterSpacing:".06em",fontWeight:"700",
      border:`1px solid ${C.border}`,borderRadius:"20px",padding:"1px 5px",pointerEvents:"none",
      textTransform:"uppercase",background:"transparent",lineHeight:"1.7"});
    tx(optPill,"Optional");icoWrap.append(ico,lbl,optPill);icoWrap._optPill=optPill;
  } else { icoWrap.append(ico,lbl); }

  // Preview image
  const prevEl=mk("img",{
    position:"absolute",inset:"0",width:"100%",height:"100%",
    objectFit:"cover",display:"none",borderRadius:"11px",
  });

  // Remove button (top-right)
  const rm=mkRmBtn();

  // Fullscreen button (top-right next to rm, circular, hidden until file loaded)
  const fsBtn=mk("button",{
    position:"absolute",top:"4px",right:"26px",width:"18px",height:"18px",
    borderRadius:"50%",background:"rgba(0,0,0,.85)",border:`1px solid ${C.border}`,
    color:"rgba(255,255,255,.7)",cursor:"pointer",display:"none",
    alignItems:"center",justifyContent:"center",padding:"0",
    transition:"border-color .15s, color .15s",lineHeight:"1",zIndex:"2",
  });
  fsBtn.innerHTML=`<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
  fsBtn.onmouseenter=()=>{ fsBtn.style.borderColor=LIME; fsBtn.style.color=LIME; };
  fsBtn.onmouseleave=()=>{ fsBtn.style.borderColor=C.border; fsBtn.style.color="rgba(255,255,255,.7)"; };

  const inp=mk("input",{display:"none"},{type:"file",accept:"image/*"});
  wrap.append(icoWrap,prevEl,fsBtn,rm,inp);

  wrap.onmouseenter=()=>{
    if(prevEl.style.display==="none"){ wrap.style.borderColor=LIME;wrap.style.background=C.bg1;ico.style.color=LIME;lbl.style.color=LIME;if(icoWrap._optPill){icoWrap._optPill.style.color=LIME;icoWrap._optPill.style.borderColor=LIME;} }
    else { wrap.style.borderColor=LIME; }
  };
  wrap.onmouseleave=()=>{ wrap.style.borderColor=C.border;wrap.style.background=C.bg2;ico.style.color=C.muted;lbl.style.color=C.muted;if(icoWrap._optPill){icoWrap._optPill.style.color=C.muted;icoWrap._optPill.style.borderColor=C.border;} };
  wrap.onclick=()=>inp.click();

  let _dragDepth=0;
  wrap.addEventListener("dragenter",e=>{e.preventDefault();e.stopPropagation();_dragDepth++;wrap.style.borderColor=LIME;wrap.style.background=C.bg1;});
  wrap.addEventListener("dragover",e=>{e.preventDefault();e.stopPropagation();});
  wrap.addEventListener("dragleave",()=>{ _dragDepth--;if(_dragDepth<=0){_dragDepth=0;wrap.style.borderColor=C.border;wrap.style.background=C.bg2;} });
  wrap.addEventListener("drop",e=>{
    e.preventDefault();e.stopPropagation();
    _dragDepth=0;wrap.style.borderColor=C.border;wrap.style.background=C.bg2;
    const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("image/"))_load(f);
  });

  let _currentName=null;
  let _fsSrc="", _fsFileName="";

  const _showLoaded=(src,fname)=>{
    prevEl.src=src;prevEl.style.display="block";
    icoWrap.style.display="none";rm.style.display="flex";fsBtn.style.display="flex";
    wrap.style.borderColor=LIME;
    _fsSrc=src;_fsFileName=fname;
    // Read natural dims once image loads
    const _tmpImg=new Image();
    _tmpImg.onload=()=>{ if(onDims) onDims(_tmpImg.naturalWidth,_tmpImg.naturalHeight); };
    _tmpImg.src=src;
  };

  fsBtn.onclick=e=>{
    e.stopPropagation();
    const factory=_fkActiveFsFactory;
    if(factory) factory()._open("image",_fsSrc,_fsFileName);
  };

  const _load=async(file)=>{
    const objUrl=URL.createObjectURL(file);
    _showLoaded(objUrl,file.name);
    // Use ComfyUI image upload endpoint
    const fd=new FormData();fd.append("image",file);fd.append("overwrite","true");
    try{
      const r=await api.fetchApi("/upload/image",{method:"POST",body:fd});
      const d=await r.json();_currentName=d.name||file.name;
      onFile(_currentName);
    }catch(err){console.warn("[ZImageOneNode] upload:",err);_currentName=file.name;onFile(_currentName);}
  };

  inp.onchange=()=>{if(inp.files[0])_load(inp.files[0]);};

  rm.onclick=e=>{
    e.stopPropagation();
    prevEl.src="";prevEl.style.display="none";
    rm.style.display="none";fsBtn.style.display="none";icoWrap.style.display="flex";
    wrap.style.borderColor=C.border;
    inp.value="";_currentName=null;onFile(null);
    if(onDims) onDims(0,0);
  };

  // Restore a previously-uploaded input image by name (state restore or programmatic set).
  // Calls onFile so hasFile() returns true and size controls update correctly.
  // Safe to call only after all dependents (resDD, updateSizeControls) are initialized.
  const _restorePreview=(name)=>{
    if(!name){ rm.onclick({stopPropagation:()=>{}}); return; }
    const src=api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=`);
    _currentName=name;
    _showLoaded(src,name);
    // onFile intentionally NOT called here — callers set S.imageXName directly and call
    // updateSizeControls/persist themselves to avoid initialization-order issues.
  };

  // Restore from a fully-formed URL (e.g. output images from gallery)
  // storedName is what gets written to S.image1Name — it must be usable with /upload/image later
  const _restorePreviewUrl=(url,displayName,storedName)=>{
    _currentName=storedName||displayName||url;
    _showLoaded(url,displayName||url);
  };

  return {
    el:wrap,
    get name(){return _currentName;},
    hasFile(){return !!_currentName;},
    _restorePreview,
    _restorePreviewUrl,
  };
}

// ── State helpers ─────────────────────────────────────────────────────────────
function loadState(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY)||"{}"); }catch(e){return{};}
}
function saveState(s){
  try{ localStorage.setItem(LS_KEY,JSON.stringify(s)); }catch(e){}
}

// ── Active refs for event handlers ────────────────────────────────────────────
let _activeS=null, _activeShowFinal=null, _activeResetBtn=null, _activeShowError=null, _activePromptIdRef=null, _activeShowPreview=null;

// ── API events ────────────────────────────────────────────────────────────────
(()=>{
  api.addEventListener("progress",(evt)=>{
    const {node,value,max}=evt.detail||{};
    if(!_activeS?.generating||!node) return;
    const pct=max>0?Math.round(value/max*100):0;
    if(_activeSetStage) _activeSetStage("Generating…",`Step ${value}/${max}`,pct);
  });

  api.addEventListener("execution_success",async()=>{
    if(!_activeS?.generating) return;
    try{
      const r=await api.fetchApi(`/z_image/gallery?offset=0&limit=20&subfolder=one-node-z-image`);
      const d=await r.json();
      const prev=_activeS?._preRunFiles||new Set();
      const v=(d.images||d.videos||[]).find(v=>!prev.has(v.key||((v.subfolder?`${v.subfolder}/`:"")+v.filename)))||(d.images||d.videos||[])[0];
      if(v){
        const cb=Date.now();
        const url=api.apiURL(`/view?filename=${encodeURIComponent(v.filename)}&type=output&subfolder=${encodeURIComponent(v.subfolder||"")}&t=${cb}`);
        _activeShowFinal?.(url,v.filename,v.subfolder||"");
      }else{
        _activeResetBtn?.();
      }
    }catch(e){
      console.error("[ZImageOneNode] execution_success:",e);
      _activeResetBtn?.();
    }
  });

  api.addEventListener("execution_error",evt=>{
    const errorPromptId=evt.detail?.prompt_id;
    if(errorPromptId && _activePromptIdRef && errorPromptId!==_activePromptIdRef()) return;
    const msg=fmtErr(evt.detail?.exception_message||evt.detail?.error||evt.detail||"Execution failed.");
    _activeShowError?.(msg);
    _activeResetBtn?.();
  });

  api.addEventListener("b_preview",evt=>{
    if(!_activeS?.generating) return;
    const blob=evt.detail;
    if(!blob) return;
    const url=URL.createObjectURL(blob);
    _activeShowPreview?.(url);
  });
})();

let _activeSetStage=null;

// ─────────────────────────────────────────────────────────────────────────────
app.registerExtension({
  name:"ZImagePlayground.v1",
  async beforeRegisterNodeDef(nodeType,nodeData){
    if(nodeData.name!=="ZImageOneNode") return;


    nodeType.prototype.onNodeCreated=function(){
      this.color=C.bg0;this.bgcolor=C.bg0;this.resizable=false;
      this.outputs=[];
      if(this.widgets)this.widgets=[];

      if(!window.__zimage_nodes) window.__zimage_nodes={};
      const nodeId=this.id;
      const cached=window.__zimage_nodes[nodeId];
      if(cached){
        _activeS=cached.S;
        _activeShowFinal=cached.fns.showFinal;
        _activeShowPreview=cached.fns.showPreview;
        _activeResetBtn=cached.fns.resetBtn;
        _activeShowError=cached.fns.showError;
        _activeSetStage=cached.fns.setStage;
        _activePromptIdRef=cached.fns.getPromptId;
        this.addDOMWidget("fk_ui","div",cached.root,{
          getValue(){return null;},setValue(){},serialize:false,
          computeSize(){const slotH=(LiteGraph.NODE_SLOT_HEIGHT||20);const n=(self.inputs||[]).length;return[NODE_W,NODE_H+n*slotH];},
        });
        this.setSize([NODE_W,NODE_H]);
        requestAnimationFrame(()=>{
          let el=cached.root;
          for(let i=0;i<6;i++){ el=el?.parentElement; if(!el)break; el.querySelectorAll("[class*='bg-node-component-surface']").forEach(b=>b.style.display="none"); }
        });
        return;
      }
      this._buildUI();
    };

    nodeType.prototype.onResize=function(){
      const slotH=(LiteGraph.NODE_SLOT_HEIGHT||20);
      const n=(this.inputs||[]).length;
      this.size=[NODE_W,NODE_H+n*slotH];
    };
    nodeType.prototype.onDrawConnections=function(){};
    nodeType.prototype.getSlotMenuOptions=function(){return[];};


    nodeType.prototype._buildUI=function(){
      const self=this;
      const saved=loadState();

      if(!self._fk_S){
        self._fk_S={
          // Settings
          modelVariant: saved.modelVariant||"9b",      // "9b" | "9b-kv"
          model:        saved.model||"",
          textEncoder:  saved.textEncoder||"",
          vae:          saved.vae||"",
          // Pill mode
          pill:         saved.pill||"t2i",              // "t2i" | "i2i"
          // Resolution
          resLabel:     saved.resLabel||RES_PRESETS[0].label,
          resW:         saved.resW||1024,
          resH:         saved.resH||1024,
          isCustomRes:  saved.isCustomRes||false,
          customW:      saved.customW||1024,
          customH:      saved.customH||1024,
          useSizeFromImage1: saved.useSizeFromImage1||false,
          // Seed
          randomizeSeed: saved.randomizeSeed!==undefined?saved.randomizeSeed:true,
          seed:          saved.seed||0,
          i2iImage:      saved.i2iImage||null,
          i2iDenoise:    saved.i2iDenoise!==undefined?saved.i2iDenoise:0.75,
          i2iResizeLonger: saved.i2iResizeLonger||0,
          promptI2i:     saved.promptI2i||"",
          advancedUI:    saved.advancedUI||false,
          steps:         saved.steps||4,
          cfg:           saved.cfg!==undefined?saved.cfg:1,
          sampler:       saved.sampler||"res_multistep",
          scheduler:     saved.scheduler||"simple",
          denoise:       saved.denoise!==undefined?saved.denoise:1,
          // Images
          image1Name:   saved.image1Name||null,
          image2Name:   saved.image2Name||null,
          bgRemovalModel: saved.bgRemovalModel||"",  // birefnet model for remove bg
          // Prompt — shared (active pill's value) + per-pill storage
          prompt:       saved.prompt||"",
          promptT2i:    saved.promptT2i!==undefined?saved.promptT2i:((!saved.pill||saved.pill==="t2i")?saved.prompt||"":""),
          // LoRAs
          userLoras:    saved.userLoras||[{name:"",strength:1.0},{name:"",strength:1.0},{name:"",strength:1.0}],
          // Generation state
          generating:   false,
          _pendingMeta: null,
          _preRunFiles: new Set(),
          soundEnabled: saved.soundEnabled!==undefined?saved.soundEnabled:true,
          extLoaders:   saved.extLoaders||false,
          previewUrl:   null,
        };
      }
      const S=self._fk_S;
      // Sync S.prompt to the active pill's slot on init (covers first load before _pillPromptKey is available)
      {
        const _initKey=S.pill==="i2i"?"promptI2i":"promptT2i";
        S.prompt=S[_initKey]||S.prompt||"";
        S[_initKey]=S.prompt;
      }
      let soundEnabled=S.soundEnabled;

      const persist=()=>{
        S.soundEnabled=soundEnabled;
        saveState({
          modelVariant:S.modelVariant, model:S.model,
          textEncoder:S.textEncoder, vae:S.vae,
          pill:S.pill,
          resLabel:S.resLabel, resW:S.resW, resH:S.resH,
          isCustomRes:S.isCustomRes, customW:S.customW, customH:S.customH,

          randomizeSeed:S.randomizeSeed, seed:S.seed,
          advancedUI:S.advancedUI, steps:S.steps, cfg:S.cfg, sampler:S.sampler, scheduler:S.scheduler, denoise:S.denoise,
          image1Name:S.image1Name, image2Name:S.image2Name,
          bgRemovalModel:S.bgRemovalModel,
          prompt:S.prompt, promptT2i:S.promptT2i, promptI2i:S.promptI2i,
          i2iImage:S.i2iImage, i2iDenoise:S.i2iDenoise, i2iResizeLonger:S.i2iResizeLonger,
          userLoras:S.userLoras, soundEnabled, extLoaders:S.extLoaders,
        });
      };

      // getW/getH: 0 = "use image size via GetImageSize node", otherwise explicit pixels
      const getW=()=>{
        return S.isCustomRes?snapRes(S.customW):S.resW;
      };
      const getH=()=>{
        return S.isCustomRes?snapRes(S.customH):S.resH;
      };
      // Returns actual pixel dims for metadata (reads from dims badge when using image size)
      const getEffectiveW=()=>{
        if(activePill==="i2i"){
          try{
            const d=_i2iDims._getDims();
            if(d.w&&d.h&&!_i2iUseOrigSize&&S.i2iResizeLonger>0){
              return Math.round(d.w*(S.i2iResizeLonger/Math.max(d.w,d.h))/16)*16;
            }
            return d.w||0;
          }catch(ex){}
          return S.resW;
        }
        return S.isCustomRes?snapRes(S.customW):S.resW;
      };
      const getEffectiveH=()=>{
        if(activePill==="i2i"){
          try{
            const d=_i2iDims._getDims();
            if(d.w&&d.h&&!_i2iUseOrigSize&&S.i2iResizeLonger>0){
              return Math.round(d.h*(S.i2iResizeLonger/Math.max(d.w,d.h))/16)*16;
            }
            return d.h||0;
          }catch(ex){}
          return S.resH;
        }
        return S.isCustomRes?snapRes(S.customH):S.resH;
      };

      // ── ROOT ────────────────────────────────────────────────────────────────
      if(!document.getElementById("fk-styles")){
        const styleEl=document.createElement("style");
        styleEl.id="fk-styles";
        styleEl.textContent=`
          @keyframes fk-gradient {
            0%   { background-position: 0% 50%; }
            50%  { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes fk-error-pulse {
            0%   { box-shadow: inset 0 0 0 1px rgba(255,103,103,.24), 0 0 0 0 rgba(255,103,103,.10); }
            50%  { box-shadow: inset 0 0 0 1px rgba(255,103,103,.46), 0 0 0 6px rgba(255,103,103,0); }
            100% { box-shadow: inset 0 0 0 1px rgba(255,103,103,.24), 0 0 0 0 rgba(255,103,103,0); }
          }
          @keyframes fk-light-sweep {
            0%   { left: -80%; opacity: 0; }
            15%  { opacity: 1; }
            85%  { opacity: 1; }
            100% { left: 120%; opacity: 0; }
          }
          @keyframes fk-heart-shake {
            0%  { transform: scale(1); }
            30% { transform: scale(1.22); }
            55% { transform: scale(0.95); }
            75% { transform: scale(1.1); }
            100%{ transform: scale(1); }
          }
          .fk-heart-anim { animation: fk-heart-shake .6s ease; }
          @keyframes fk-manage-flash {
            0%   { background: linear-gradient(135deg,rgba(26,20,60,0) 0%,rgba(15,52,96,0) 50%,rgba(83,52,131,0) 100%); }
            25%  { background: linear-gradient(135deg,rgba(26,20,60,.7) 0%,rgba(15,52,96,.5) 50%,rgba(83,52,131,.6) 100%); }
            60%  { background: linear-gradient(135deg,rgba(26,20,60,.5) 0%,rgba(15,52,96,.35) 50%,rgba(83,52,131,.45) 100%); }
            100% { background: linear-gradient(135deg,rgba(26,20,60,.35) 0%,rgba(15,52,96,.2) 50%,rgba(83,52,131,.3) 100%); }
          }
          .fk-manage-on { background: linear-gradient(135deg,rgba(26,20,60,.35) 0%,rgba(15,52,96,.2) 50%,rgba(83,52,131,.3) 100%) !important; }
          .fk-manage-flash { animation: fk-manage-flash .5s ease forwards; }
          input[type=number]::-webkit-inner-spin-button,
          input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
          input[type=number] { -moz-appearance:textfield; }
          /* Nodes 2.0: hide the auto-injected node-type label rendered below the DOM widget */
          .fk-root ~ .node_title, .fk-root + .node_title { display:none !important; }
        `;
        document.head.appendChild(styleEl);
      }

      const root=mk("div",{width:"100%",background:C.bg0,boxSizing:"border-box",
        fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        color:C.text,overflow:"hidden",position:"relative"});
      root.classList.add("fk-root");


      // Nodes 2.0 compatibility: inherit border-radius from the DOM widget wrapper so overlays
      // clip correctly. The wrapper gets its radius from the litegraph node shape.
      const _syncNodeRadius=()=>{
        const wrapper=root.parentElement;
        if(!wrapper) return;
        const r=getComputedStyle(wrapper).borderRadius;
        // Only apply if non-zero and different from current
        const effective=(r&&r!=="0px")?r:"0px";
        root.style.borderRadius=effective;
      };
      // Sync once after mount and observe changes (theme switches, etc.)
      requestAnimationFrame(()=>{
        _syncNodeRadius();
        if(typeof ResizeObserver!=="undefined"){
          new ResizeObserver(_syncNodeRadius).observe(root.parentElement||root);
        }
      });

      const titleH=(typeof LiteGraph!=="undefined"&&LiteGraph.NODE_TITLE_HEIGHT)||30;
      const _uiH=NODE_H-titleH-4;
      const scrollEl=mk("div",{
        width:"100%",height:_uiH+"px",
        overflowY:"hidden",overflowX:"hidden",boxSizing:"border-box",
      });
      const _fwdCv=document.querySelector("canvas.litegraph");
      scrollEl.addEventListener("wheel",e=>{
        // Always forward wheel to canvas for zoom — node content doesn't scroll
        if(_fwdCv) _fwdCv.dispatchEvent(new WheelEvent("wheel",{deltaY:e.deltaY,deltaX:e.deltaX,
          clientX:e.clientX,clientY:e.clientY,ctrlKey:e.ctrlKey,metaKey:e.metaKey,
          bubbles:true,cancelable:true}));
        e.preventDefault();
      },{passive:false});

      const pad=mk("div",{padding:"12px",display:"flex",flexDirection:"column",
        gap:"10px",boxSizing:"border-box",width:"100%",
        height:_uiH+"px"});

      // ── SETTINGS OVERLAY ──────────────────────────────────────────────────
      const settingsOverlay=mk("div",{
        position:"absolute",inset:"0",background:"#0a0a0a",
        display:"none",flexDirection:"column",padding:"16px",
        boxSizing:"border-box",zIndex:"50",borderRadius:"8px",
        overflowY:"auto",
        opacity:"0",transition:"opacity .22s ease, transform .22s ease",
        transform:"translateY(6px)",
      });

      const settHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:"16px",flexShrink:"0"});
      const settTitle=mk("div",{fontSize:"13px",fontWeight:"700",letterSpacing:".06em",
        textTransform:"uppercase",color:C.text});tx(settTitle,"Settings");
      const settClose=mk("button",{background:"transparent",border:`1px solid #e05555`,
        borderRadius:"6px",padding:"4px 14px",fontSize:"11px",color:"#e05555",
        cursor:"pointer",outline:"none",transition:"opacity .15s"});
      tx(settClose,"✕  Close");
      settClose.onmouseenter=()=>settClose.style.opacity=".7";
      settClose.onmouseleave=()=>settClose.style.opacity="1";
      const settRefresh=mk("button",{background:"transparent",border:`1px solid ${C.border}`,
        borderRadius:"6px",padding:"4px 14px",fontSize:"11px",color:C.muted,
        cursor:"pointer",outline:"none",transition:"opacity .15s",marginRight:"8px"});
      tx(settRefresh,"↻  Refresh models");
      settRefresh.onmouseenter=()=>settRefresh.style.opacity=".7";
      settRefresh.onmouseleave=()=>settRefresh.style.opacity="1";
      settRefresh.onclick=()=>{ tx(settRefresh,"↻  Refreshing…"); _loadModels().then(()=>tx(settRefresh,"↻  Refresh models")); };
      const settBtnRow=mk("div",{display:"flex",alignItems:"center",gap:"0"});
      settBtnRow.append(settRefresh,settClose);
      settHdr.append(settTitle,settBtnRow);


      // ── Model dropdowns ───────────────────────────────────────────────────
      const mkPathLabel=(txt)=>mk("div",{fontSize:"10px",color:C.muted,marginTop:"-2px",marginBottom:"5px",lineHeight:"1.3",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},{textContent:txt});
      const mkModDD=(capTxt,pathTxt,defVal,onCh,autoKeyword=null)=>{
        const wrap=mk("div",{minWidth:"0",overflow:"hidden"});
        wrap.appendChild(cap(capTxt));
        wrap.appendChild(mkPathLabel(pathTxt));
        const row=mk("div",{display:"flex",gap:"4px",alignItems:"center",minWidth:"0",overflow:"hidden"});
        const dd=DD([defVal||"—"],[defVal||"—"][0],v=>{onCh(v);persist();});
        dd.el.style.flex="1";dd.el.style.minWidth="0";
        dd._items=[defVal||""];
        const origUpdate=dd.updateItems.bind(dd);
        dd.updateItems=ni=>{
          dd._items=ni;
          const _norm=(s)=>(s||"").replace(/\\/g,"/").toLowerCase();
          const currentVal=dd.value||"";
          // If the current value exists in the new list, keep it — don't auto-select by keyword
          const existsInList=ni.some(i=>_norm(i)===_norm(currentVal));
          if(existsInList){
            origUpdate(ni); // keeps current selection
          } else {
            // Current value not in list — try keyword auto-select, else first item
            origUpdate(ni);
            if(autoKeyword&&ni.length){
              const kws=autoKeyword.split(',').map(k=>k.trim().toLowerCase());
              const best=ni.find(f=>kws.every(k=>f.toLowerCase().includes(k)));
              if(best){dd.set(best);onCh(best);persist();}
            }
          }
        };
        row.append(dd.el);
        wrap.appendChild(row);
        return{wrap,dd};
      };

      // Row 1: Model / Text Encoder / VAE
      const modGrid=mk("div",{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBottom:"4px"});
      const modelF  =mkModDD("Model",         "/models/diffusion_models", S.model,       v=>{S.model=v;if(typeof _kvUpdateNote==="function")_kvUpdateNote();},"z_image");
      const teF     =mkModDD("Text Encoder",  "/models/text_encoders",   S.textEncoder, v=>S.textEncoder=v, "qwen");
      const vaeF    =mkModDD("VAE",           "/models/vae",             S.vae,         v=>S.vae=v,         "");
      modGrid.append(modelF.wrap,teF.wrap,vaeF.wrap);
      // KV info note — shown below Model dropdown when selected model name contains "kv"
      const _isBaseModel=()=>(S.model||"").toLowerCase().includes("base");

      const _kvNote=mk("div",{fontSize:"9px",color:"#f0a040",marginTop:"0px",marginBottom:"4px",display:"none"});
      tx(_kvNote,"⚙ KV model version detected. Settings adjusted for KV model.");

      const _baseNote=mk("div",{fontSize:"9px",color:"#f0a040",marginTop:"0px",marginBottom:"8px",display:"none"});
      tx(_baseNote,"⚙ Base model detected. Settings adjusted for base model.");

      let _advControlsReady=false;
      const _kvUpdateNote=()=>{
        const name=(S.model||"").toLowerCase();
        _kvNote.style.display=name.includes("kv")?"block":"none";
        const isBase=name.includes("base");
        _baseNote.style.display=isBase?"block":"none";
        // Sync advanced control defaults when base model selected
        if(!_advControlsReady) return;
        if(isBase){
          if(S.steps===4||S.steps===20){ S.steps=20; stepsInp.setVal(20); }
          if(S.cfg===1||S.cfg===5){ S.cfg=5; cfgInp.setVal(5); }
        } else {
          if(S.steps===20){ S.steps=4; stepsInp.setVal(4); }
          if(S.cfg===5){ S.cfg=1; cfgInp.setVal(1); }
        }
      };
      _kvUpdateNote();

      // ── Trigger words system ───────────────────────────────────────────────
      // Custom trigger words stored in config.json under key "lora_triggers_custom"
      // key = lora basename (no path), value = user-saved trigger string
      if(!window.__fkCustomTriggers) window.__fkCustomTriggers=null; // null = not loaded yet

      const _loadCustomTriggers=async()=>{
        if(window.__fkCustomTriggers!==null) return window.__fkCustomTriggers;
        try{
          const r=await api.fetchApi("/z_image/config");
          const d=await r.json();
          window.__fkCustomTriggers=d.lora_triggers_custom||{};
        }catch(e){ window.__fkCustomTriggers={}; }
        return window.__fkCustomTriggers;
      };

      const _saveCustomTrigger=async(loraName,triggerText)=>{
        const base=loraName.split(/[\\/]/).pop();
        if(!window.__fkCustomTriggers) window.__fkCustomTriggers={};
        if(triggerText.trim()) window.__fkCustomTriggers[base]=triggerText.trim();
        else delete window.__fkCustomTriggers[base];
        try{
          await api.fetchApi("/z_image/config",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({lora_triggers_custom:window.__fkCustomTriggers}),
          });
        }catch(e){ console.warn("[ZImageOneNode] save custom trigger:",e); }
      };

      const _getCustomTrigger=(loraName)=>{
        if(!loraName||loraName==="none"||!window.__fkCustomTriggers) return "";
        const base=loraName.split(/[\\/]/).pop();
        return window.__fkCustomTriggers[base]||"";
      };



      // ── Preferences ───────────────────────────────────────────────────────
      const prefTitle=mk("div",{fontSize:"10px",fontWeight:"700",letterSpacing:".1em",
        textTransform:"uppercase",color:C.muted,padding:"10px 0 2px",
        borderBottom:`1px solid ${C.border}`,marginBottom:"4px"});
      tx(prefTitle,"Preferences");
      const soundToggle=Toggle("Notification sound on complete",soundEnabled,v=>{soundEnabled=v;persist();});
      const advUIToggle=Toggle("Advanced control (steps, CFG, sampler…)",S.advancedUI,v=>{S.advancedUI=v;persist();_advRefresh();},"#6450b4");

      const _slotH=LiteGraph.NODE_SLOT_HEIGHT||20;
      const _extInputNames=["model","clip","vae"];
      const _extInputColors=["#b39ddb","#80cbc4","#ef9a9a"];

      const _applyExtLoaders=(enabled)=>{
        const node=app.graph.getNodeById(self.id)||self;
        if(!node) return;
        if(enabled){
          const existing=(node.inputs||[]).filter(i=>_extInputNames.includes(i.name));
          if(existing.length===0){
            _extInputNames.forEach((name,i)=>{
              const type=i===0?"MODEL":i===1?"CLIP":"VAE";
              node.addInput(name,type);
              const slot=node.inputs[node.inputs.length-1];
              if(slot) slot.color_on=_extInputColors[i];
            });
          }
          const n=(node.inputs||[]).length;
          node.size=[NODE_W, NODE_H+n*_slotH];
          node.setDirtyCanvas(true,true);
        } else {
          if(node.inputs&&node.inputs.length>0){
            for(let i=node.inputs.length-1;i>=0;i--){
              if(_extInputNames.includes(node.inputs[i].name)) node.removeInput(i);
            }
          }
          node.size=[NODE_W, NODE_H];
          node.setDirtyCanvas(true,true);
        }
      };

      const extLoadersToggle=Toggle("External model/clip/vae inputs (for GGUF etc.)",S.extLoaders||false,v=>{
        S.extLoaders=v;persist();
        _applyExtLoaders(v);
        _refreshExtInputUI();
      });

      settingsOverlay.append(settHdr,modGrid,_kvNote,_baseNote,prefTitle,soundToggle.el,advUIToggle.el,extLoadersToggle.el);

      // ── Overlay helpers ───────────────────────────────────────────────────
      const openOverlay=(el)=>{
        el.style.display="flex";
        el.offsetHeight;
        el.style.opacity="1";
        el.style.transform="translateY(0)";
      };
      const closeOverlayFade=(el,cb)=>{
        el.style.opacity="0";
        el.style.transform="translateY(6px)";
        setTimeout(()=>{el.style.display="none";if(cb)cb();},220);
      };

      // ── TOP BAR ──────────────────────────────────────────────────────────
      const topBar=mk("div",{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"6px",marginBottom:"-2px"});

      // Gallery button (placeholder — will be wired when gallery is implemented)
      const galleryBtn=mk("button",{
        background:"linear-gradient(90deg,#1a1a2e,#0f3460,#533483)",
        border:"1.5px solid rgba(255,255,255,.15)",
        borderRadius:"6px",padding:"4px 11px",cursor:"pointer",color:"#e0e0ff",
        fontSize:"11px",fontWeight:"700",display:"flex",alignItems:"center",gap:"5px",
        transition:"opacity .15s, filter .15s",outline:"none",
      });
      const galleryIcon=mk("span",{fontSize:"12px"});tx(galleryIcon,"▦");
      const galleryLbl=mk("span");tx(galleryLbl,"Gallery");
      galleryBtn.append(galleryIcon,galleryLbl);
      galleryBtn.onmouseenter=()=>galleryBtn.style.filter="brightness(1.3)";
      galleryBtn.onmouseleave=()=>galleryBtn.style.filter="";
      galleryBtn.onclick=()=>{}; // TODO: gallery overlay

      // Simple credit
      const creditText=mk("div",{fontSize:"9px",color:C.muted,fontStyle:"italic",position:"absolute",bottom:"8px",left:"16px",right:"16px",textAlign:"center",pointerEvents:"none"});
      tx(creditText,"node by Adeliox");

      // Settings button
      const settingsBtn=mk("button",{
        background:"transparent",border:`1.5px solid ${C.borderH}`,
        borderRadius:"6px",padding:"4px 11px",
        cursor:"pointer",color:C.muted,fontSize:"11px",fontWeight:"700",
        display:"flex",alignItems:"center",gap:"5px",
        transition:"opacity .15s",outline:"none",
      });
      const settGear=mk("span",{fontSize:"12px",transition:"transform .3s",lineHeight:"1"});tx(settGear,"⚙");
      const settLblEl=mk("span");tx(settLblEl,"Settings");
      settingsBtn.append(settGear,settLblEl);
      settingsBtn.onmouseenter=()=>{settingsBtn.style.borderColor=C.text;settingsBtn.style.color=C.text;settGear.style.transform="rotate(30deg)";};
      settingsBtn.onmouseleave=()=>{settingsBtn.style.borderColor=C.borderH;settingsBtn.style.color=C.muted;settGear.style.transform="";};
      const _refreshExtInputUI=()=>{
        const n=app.graph.getNodeById(self.id);
        const isConn=(name)=>{
          if(!n||!n.inputs) return false;
          const slot=n.inputs.find(i=>i.name===name);
          return slot&&slot.link!=null;
        };
        const dim=(wrap,connected)=>{
          wrap.style.opacity=connected?"0.4":"1";
          wrap.style.pointerEvents=connected?"none":"";
          wrap.title=connected?"Connected externally — disconnect to use dropdown":"";
        };
        dim(modelF.wrap,isConn("model"));
        dim(teF.wrap,  isConn("clip"));
        dim(vaeF.wrap, isConn("vae"));
      };
      settingsBtn.onclick=e=>{e.stopPropagation();_refreshExtInputUI();openOverlay(settingsOverlay);};
      settClose.onclick=()=>closeOverlayFade(settingsOverlay);

      // Fullscreen node button
      const fsNodeBtn=mk("button",{
        background:"transparent",border:`1.5px solid ${C.borderH}`,
        borderRadius:"6px",padding:"4px 8px",
        cursor:"pointer",color:C.muted,
        display:"flex",alignItems:"center",gap:"4px",
        transition:"opacity .15s, border-color .15s, color .15s",outline:"none",
      });
      fsNodeBtn.title="Fullscreen";
      fsNodeBtn.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
      fsNodeBtn.onmouseenter=()=>{fsNodeBtn.style.borderColor=LIME;fsNodeBtn.style.color=LIME;};
      fsNodeBtn.onmouseleave=()=>{fsNodeBtn.style.borderColor=C.borderH;fsNodeBtn.style.color=C.muted;};

      let _inFullscreen=false;
      let _fsNodeOverlay=null;
      let _rootOrigParent=null,_rootOrigNextSibling=null;

      const _enterFullscreen=()=>{
        if(_inFullscreen) return;
        if(!_fsNodeOverlay){
          _fsNodeOverlay=mk("div",{
            position:"fixed",inset:"0",zIndex:"99990",
            background:"rgba(6,6,8,.97)",
            display:"none",flexDirection:"column",
            alignItems:"center",justifyContent:"center",
            boxSizing:"border-box",overflow:"hidden",
          });
          // No keydown handler — Esc is blocked globally via capture handler below
          document.body.appendChild(_fsNodeOverlay);
        }
        _rootOrigParent=root.parentNode;
        _rootOrigNextSibling=root.nextSibling;
        root.style.width=NODE_W+"px";
        root.style.height=NODE_H+"px";
        root.style.overflow="hidden";
        root.style.borderRadius="0";
        root.style.position="absolute";
        root.style.top="0";root.style.left="0";root.style.margin="0";
        const _vw=window.innerWidth,_vh=window.innerHeight;
        const _scale=Math.min(_vw/NODE_W,_vh/NODE_H)*0.97;
        root.style.transformOrigin="top left";
        root.style.transform=`scale(${_scale})`;
        const _scW=Math.round(NODE_W*_scale),_scH=Math.round(NODE_H*_scale);
        const _scWrap=mk("div",{width:_scW+"px",height:_scH+"px",position:"relative",flexShrink:"0",overflow:"hidden"});
        _scWrap.appendChild(root);
        _fsNodeOverlay.appendChild(_scWrap);
        _fsNodeOverlay._scWrap=_scWrap;
        _fsNodeOverlay.style.display="flex";
        _fsNodeOverlay.setAttribute("tabindex","-1");
        _fsNodeOverlay.focus();
        fsNodeBtn.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg>`;
        _inFullscreen=true;
      };

      const _exitFullscreen=()=>{
        if(!_inFullscreen) return;
        if(_rootOrigParent){
          if(_rootOrigNextSibling) _rootOrigParent.insertBefore(root,_rootOrigNextSibling);
          else _rootOrigParent.appendChild(root);
        }
        root.style.position="";root.style.inset="";root.style.width="100%";root.style.height="";
        root.style.borderRadius="";root.style.overflow="hidden";
        root.style.transform="";root.style.transformOrigin="";root.style.margin="";
        root.style.top="";root.style.left="";
        scrollEl.style.height=_uiH+"px";
        if(_fsNodeOverlay._scWrap) _fsNodeOverlay._scWrap.remove();
        _fsNodeOverlay._scWrap=null;
        _fsNodeOverlay.style.display="none";
        fsNodeBtn.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
        _inFullscreen=false;
      };

      fsNodeBtn.onclick=()=>{ if(_inFullscreen) _exitFullscreen(); else _enterFullscreen(); };

      const topBarLeft=mk("div",{display:"flex",gap:"3px",alignItems:"center",flexWrap:"nowrap"});
      const topBarRight=mk("div",{display:"flex",gap:"6px",alignItems:"center",flexShrink:"0"});
      topBarRight.append(galleryBtn,settingsBtn,fsNodeBtn);
      topBar.append(topBarLeft,topBarRight);

      // ── PILLS ─────────────────────────────────────────────────────────────
      let activePill=S.pill||"t2i";

      const pillT2I    =Pill("ZIMG",      activePill==="t2i",     ()=>setPill("t2i"));
      const pillI2I    =Pill("Z-I2I",     activePill==="i2i",     ()=>setPill("i2i"));
      topBarLeft.append(pillT2I,pillI2I);

      let _promptTARef=null; // set after promptTA is created

      const _pillPromptKey=(p)=>p==="i2i"?"promptI2i":"promptT2i";

      function setPill(p){
        if(_promptTARef&&activePill){
          S[_pillPromptKey(activePill)]=_promptTARef.value;
        }
        activePill=p;S.pill=p;
        S.prompt=S[_pillPromptKey(p)];
        if(_promptTARef){ _promptTARef.value=S.prompt; if(typeof _promptOvTA!=="undefined"&&_promptOvTA) _promptOvTA.value=S.prompt; }
        persist();
        [pillT2I,pillI2I].forEach(b=>{
          const isActive=
            (b===pillT2I&&p==="t2i")||
            (b===pillI2I&&p==="i2i");
          b.style.background=isActive?LIME:C.bg2;
          b.style.color=isActive?"#111":C.text;
          b.style.borderColor=isActive?LIME:C.border;
          b.style.fontWeight=isActive?"700":"400";
        });
        updatePillVisibility();
        updateSizeControls();
      }

      // ── MAIN ROW ─────────────────────────────────────────────────────────
      const mainRow=mk("div",{display:"flex",gap:"12px",alignItems:"stretch",flex:"1",minHeight:"0"});
      const leftPanel=mk("div",{display:"flex",flexDirection:"column",gap:"7px",
        width:"300px",flexShrink:"0"});

      // ── Node-local fullscreen overlay ────────────────────────────────────
      let _nodeFsOv=null;
      const _initNodeFsOverlay=()=>{
        if(_nodeFsOv) return _nodeFsOv;
        const ov=mk("div",{position:"absolute",inset:"0",zIndex:"9999",
          background:"rgba(28,28,32,.97)",display:"none",flexDirection:"column",
          alignItems:"stretch",borderRadius:"inherit",overflow:"hidden"});
        const _nfTopBar=mk("div",{display:"flex",alignItems:"center",
          padding:"10px 12px",gap:"10px",flexShrink:"0",
          background:"linear-gradient(to bottom,rgba(0,0,0,.7),rgba(0,0,0,0))",
          position:"absolute",top:"0",left:"0",right:"0",zIndex:"3"});
        const _nfName=mk("div",{fontSize:"11px",fontWeight:"700",color:"#fff",
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
          letterSpacing:".01em",textAlign:"center",width:"100%",padding:"0 36px",boxSizing:"border-box"});
        const _nfCloseBtn=mk("button",{width:"26px",height:"26px",borderRadius:"50%",
          position:"absolute",right:"12px",top:"10px",
          background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.15)",
          color:"rgba(255,255,255,.85)",fontSize:"10px",cursor:"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"0",outline:"none"});
        _nfCloseBtn.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
        _nfCloseBtn.onmouseenter=()=>{_nfCloseBtn.style.background="rgba(255,255,255,.2)";};
        _nfCloseBtn.onmouseleave=()=>{_nfCloseBtn.style.background="rgba(255,255,255,.08)";};
        _nfTopBar.append(_nfName,_nfCloseBtn);
        const _nfMediaWrap=mk("div",{width:"100%",height:"100%",display:"flex",
          alignItems:"center",justifyContent:"center",padding:"48px 16px 16px",boxSizing:"border-box"});
        const _nfPillRow=mk("div",{display:"flex",gap:"6px",justifyContent:"center",
          flexWrap:"wrap",marginTop:"8px"});
        const _nfPill=(t)=>{
          const p=mk("div",{fontSize:"9px",color:"rgba(255,255,255,.55)",fontWeight:"600",
            border:"1px solid rgba(255,255,255,.15)",borderRadius:"20px",
            padding:"2px 9px",letterSpacing:".04em",whiteSpace:"nowrap",background:"rgba(255,255,255,.05)"});
          tx(p,t);return p;
        };
        const _nfClose=()=>{
          if(ov._cleanupCmp){ov._cleanupCmp();ov._cleanupCmp=null;}
          
          ov.style.display="none";
          const img=_nfMediaWrap.querySelector("img");
          if(img) img.src="";
          _nfMediaWrap.innerHTML="";_nfPillRow.innerHTML="";
          // Restore preview action buttons
          if(typeof previewUseWrap!=="undefined") previewUseWrap.style.visibility="";
          if(typeof previewDelBtn!=="undefined") previewDelBtn.style.visibility="";
        };
        _nfCloseBtn.onclick=_nfClose;
        ov.addEventListener("keydown",e=>{if(e.key==="Escape")_nfClose();});
        ov.setAttribute("tabindex","-1");
        ov._close=_nfClose;
        ov.append(_nfTopBar,_nfMediaWrap);
        ov._open=(type,src,name,opts)=>{
          _nfMediaWrap.innerHTML="";_nfPillRow.innerHTML="";
          tx(_nfName,name||"");
          // Hide preview action buttons while fullscreen overlay is open (image-only mode)
          if(type==="image"){
            if(typeof previewUseWrap!=="undefined"&&previewUseWrap) previewUseWrap.style.visibility="hidden";
            if(typeof previewDelBtn!=="undefined"&&previewDelBtn) previewDelBtn.style.visibility="hidden";
          }
          if(type==="image"){
            const outer=mk("div",{display:"flex",flexDirection:"column",alignItems:"center",
              justifyContent:"center",gap:"8px",width:"100%",height:"100%"});
            const img=mk("img",{maxWidth:"100%",maxHeight:"calc(100% - 56px)",objectFit:"contain",
              borderRadius:"8px",boxShadow:"0 4px 24px rgba(0,0,0,.5)",display:"block"});
            img.src=src;
            img.onload=()=>{
              _nfPillRow.innerHTML="";
              _nfPillRow.appendChild(_nfPill(`${img.naturalWidth}×${img.naturalHeight} px`));
            };
            outer.append(img,_nfPillRow);
            _nfMediaWrap.appendChild(outer);
          } else if(type==="comparer"){
            // Full-screen before/after comparer with "Use as input" in top-right
            const {genSrc,baseSrc,onUse}=opts||{};
            const cWrap=mk("div",{position:"relative",width:"100%",height:"100%",
              overflow:"hidden",borderRadius:"8px",cursor:"col-resize",userSelect:"none",
              minHeight:"0",flex:"1"});
            const cBase=mk("img",{position:"absolute",inset:"0",width:"100%",height:"100%",objectFit:"contain"});
            cBase.src=baseSrc||"";
            const cGen=mk("div",{position:"absolute",top:"0",left:"0",bottom:"0",overflow:"hidden",width:"100%"});
            const cGenImg=mk("img",{position:"absolute",top:"0",left:"0",height:"100%",objectFit:"contain"});
            cGen.appendChild(cGenImg);
            cGenImg.src=genSrc||"";
            const cLine=mk("div",{position:"absolute",top:"0",bottom:"0",width:"2px",
              background:LIME,left:"calc(100% - 1px)",boxShadow:"0 0 8px rgba(240,255,65,.5)",
              display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:"4"});
            const cHandle=mk("div",{width:"30px",height:"30px",borderRadius:"50%",background:LIME,
              border:"2px solid #111",flexShrink:"0",display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:"0 2px 10px rgba(0,0,0,.7)",pointerEvents:"none"});
            cHandle.innerHTML=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round"><path d="M8 4l-4 8 4 8M16 4l4 8-4 8"/></svg>`;
            cLine.appendChild(cHandle);
            const _fsSetPct=(pct)=>{
              pct=Math.max(0,Math.min(100,pct));
              cGen.style.width=pct+"%";
              cLine.style.left=`calc(${pct}% - 1px)`;
              cGenImg.style.width=(cWrap.offsetWidth||900)+"px";
            };
            let _fsDrag=false;
            cWrap.addEventListener("mousedown",e=>{_fsDrag=true;e.preventDefault();});
            const _fsMM=(e)=>{if(!_fsDrag)return;const r=cWrap.getBoundingClientRect();_fsSetPct((e.clientX-r.left)/r.width*100);};
            const _fsMU=()=>{_fsDrag=false;};
            document.addEventListener("mousemove",_fsMM);
            document.addEventListener("mouseup",_fsMU);
            cWrap.addEventListener("touchstart",()=>{_fsDrag=true;},{passive:true});
            cWrap.addEventListener("touchmove",e=>{if(!_fsDrag)return;const r=cWrap.getBoundingClientRect();_fsSetPct((e.touches[0].clientX-r.left)/r.width*100);},{passive:true});
            cWrap.addEventListener("touchend",()=>{_fsDrag=false;});
            ov._cleanupCmp=()=>{document.removeEventListener("mousemove",_fsMM);document.removeEventListener("mouseup",_fsMU);};
            cWrap.append(cBase,cGen,cLine);
            _nfMediaWrap.style.position="relative";
            _nfMediaWrap.style.padding="0"; // comparer fills full area
            _nfMediaWrap.appendChild(cWrap);
            cGenImg.onload=()=>{ _fsSetPct(100); };
            // "Use as input" button — top-right corner of the overlay
            if(onUse){
              const useBtn=mk("button",{
                position:"absolute",top:"54px",right:"14px",zIndex:"10",
                background:"rgba(20,20,20,.82)",color:"rgba(255,255,255,.82)",
                border:"1px solid rgba(255,255,255,.18)",
                borderRadius:"6px",padding:"5px 12px",fontSize:"10px",fontWeight:"600",
                cursor:"pointer",outline:"none",whiteSpace:"nowrap",
                backdropFilter:"blur(4px)",letterSpacing:".04em",
                boxShadow:"0 2px 8px rgba(0,0,0,.5)",
                transition:"background .15s, color .15s, border-color .15s",
              });
              tx(useBtn,"Use as input");
              useBtn.onmouseenter=()=>{useBtn.style.background="rgba(40,40,40,.95)";useBtn.style.color="#fff";useBtn.style.borderColor="rgba(255,255,255,.35)";};
              useBtn.onmouseleave=()=>{useBtn.style.background="rgba(20,20,20,.82)";useBtn.style.color="rgba(255,255,255,.82)";useBtn.style.borderColor="rgba(255,255,255,.18)";};
              useBtn.onclick=(e)=>{e.stopPropagation();onUse();_nfClose();};
              ov.appendChild(useBtn);
              
            }
          }
          ov.style.display="flex";ov.focus();
        };
        root.appendChild(ov);
        _nodeFsOv=ov;
        return ov;
      };
      _fkActiveFsFactory=_initNodeFsOverlay;

      // ── I2I PANEL ─────────────────────────────────────────────────────────
      const i2iPanel=mk("div",{display:"none",flexDirection:"column",gap:"5px"});

      // _i2iDims: same helper pattern as _fsTargetDims
      const _i2iDims=(()=>{
        let _w=0,_h=0;
        const el=mk("div",{
          fontSize:"9px",fontWeight:"700",letterSpacing:".04em",
          textAlign:"center",cursor:"pointer",display:"none",
          borderRadius:"5px",padding:"2px 6px",boxSizing:"border-box",
          background:C.bg3,border:`1px solid ${C.borderH}`,color:LIME,
          background:"rgba(240,255,65,.13)",borderColor:"rgba(240,255,65,.5)",
        });
        el._getDims=()=>({w:_w,h:_h});
        el._set=(w,h)=>{ _w=w;_h=h; if(w&&h){ tx(el,`${w}×${h}`);el.style.display="block"; } else el.style.display="none"; };
        return el;
      })();

      let _i2iUseOrigSize=S.i2iResizeLonger<=0; // true = lime badge, locked; false = unlocked

      const _i2iResizePreview=mk("span",{fontSize:"9px",fontWeight:"700",color:LIME,letterSpacing:".03em",whiteSpace:"nowrap"});
      const _i2iResizeLongerInp=NI("px",S.i2iResizeLonger||1024,64,8192,8,v=>{
        S.i2iResizeLonger=Math.round(v)||1024;
        _i2iResizeUpdatePreview();
        persist();
      },52);

      const _i2iUseOrigNote=mk("div",{fontSize:"8px",color:LIME,display:"none",marginTop:"0"});
      tx(_i2iUseOrigNote,"Using size from Input image.");

      const _i2iResizeRow=mk("div",{display:"none",alignItems:"center",gap:"6px",marginTop:"2px"});
      const _i2iResizeRowLbl=mk("span",{fontSize:"8px",color:C.muted,whiteSpace:"nowrap",flexShrink:"0"});
      tx(_i2iResizeRowLbl,"Scale by longer side");
      _i2iResizeRow.append(_i2iResizeRowLbl,_i2iResizeLongerInp,_i2iResizePreview);

      const _i2iResizeUpdatePreview=()=>{
        const dims=_i2iDims._getDims();
        if(!_i2iUseOrigSize&&dims.w&&dims.h&&S.i2iResizeLonger>0){
          const scale=S.i2iResizeLonger/Math.max(dims.w,dims.h);
          const nw=Math.round(dims.w*scale/16)*16;
          const nh=Math.round(dims.h*scale/16)*16;
          tx(_i2iResizePreview,`→ ${nw}×${nh}`);
        } else {
          tx(_i2iResizePreview,"");
        }
      };

      const _i2iApplyState=()=>{
        const dims=_i2iDims._getDims();
        if(!dims.w||!dims.h) return;
        if(_i2iUseOrigSize){
          _i2iDims.style.color=LIME;
          _i2iDims.style.background="rgba(240,255,65,.13)";
          _i2iDims.style.borderColor="rgba(240,255,65,.5)";
          _i2iUseOrigNote.style.display="block";
          _i2iResizeRow.style.opacity="0.35";
          _i2iResizeRow.style.pointerEvents="none";
          _i2iResizeLongerInp._inp.disabled=true;
        } else {
          _i2iDims.style.color=C.text;
          _i2iDims.style.background=C.bg3;
          _i2iDims.style.borderColor=C.borderH;
          _i2iUseOrigNote.style.display="none";
          _i2iResizeRow.style.opacity="1";
          _i2iResizeRow.style.pointerEvents="auto";
          _i2iResizeLongerInp._inp.disabled=false;
          if(S.i2iResizeLonger<=0){ S.i2iResizeLonger=_i2iResizeLongerInp.numVal||1024; persist(); }
        }
        _i2iResizeUpdatePreview();
      };

      _i2iDims.onclick=()=>{
        const dims=_i2iDims._getDims();
        if(!dims.w||!dims.h) return;
        _i2iUseOrigSize=!_i2iUseOrigSize;
        if(_i2iUseOrigSize){ S.i2iResizeLonger=0; persist(); }
        _i2iApplyState();
      };

      const i2iSlotRow=mk("div",{display:"flex",gap:"10px",alignItems:"flex-start"});
      const i2iSlotCard=mk("div",{display:"flex",flexDirection:"column",gap:"3px",alignItems:"center"});
      const i2iSlot=ImgSlot(false,(name)=>{
        S.i2iImage=name||null;
        if(!name){
          _i2iDims._set(0,0);
          _i2iResizeRow.style.display="none";
          _i2iUseOrigNote.style.display="none";
          _i2iUseOrigSize=true;
          S.i2iResizeLonger=0;
        }
        if(name){ i2iSlot.el.style.borderColor=""; tx(i2iSlotLbl,"Input Image"); i2iSlotLbl.style.color=C.muted; }
        persist();
      },(w,h)=>{
        if(w&&h){
          _i2iDims._set(w,h);
          _i2iResizeRow.style.display="flex";
          _i2iApplyState();
        } else {
          _i2iDims._set(0,0);
          _i2iResizeRow.style.display="none";
          _i2iUseOrigNote.style.display="none";
        }
      });
      const i2iSlotLbl=mk("div",{fontSize:"8px",fontWeight:"700",color:C.muted,textTransform:"uppercase",letterSpacing:".07em",textAlign:"center"});
      tx(i2iSlotLbl,"Input Image");
      i2iSlotCard.append(i2iSlot.el,i2iSlotLbl,_i2iDims);
      i2iSlotRow.append(i2iSlotCard);

      // Denoise slider — 0 = no change, 100 = full generation
      const i2iSliderWrap=mk("div",{display:"flex",flexDirection:"column",gap:"2px"});
      const i2iSliderHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between"});
      const i2iSliderLbl=mk("div",{fontSize:"8px",fontWeight:"700",color:C.muted,letterSpacing:".05em",textTransform:"uppercase"});
      tx(i2iSliderLbl,"Change strength");
      const i2iSliderVal=mk("div",{fontSize:"9px",fontWeight:"700",color:LIME});
      tx(i2iSliderVal,`${Math.round((S.i2iDenoise||0.75)*100)}%`);
      i2iSliderHdr.append(i2iSliderLbl,i2iSliderVal);

      const i2iSlider=mk("input",{
        width:"100%",cursor:"pointer",accentColor:LIME,height:"18px",display:"block",
      },{type:"range",min:"0",max:"100",step:"1",value:String(Math.round((S.i2iDenoise||0.75)*100))});
      const _i2iSliderSet=(pct)=>{
        pct=Math.max(0,Math.min(100,pct));
        i2iSlider.value=String(pct);
        S.i2iDenoise=pct/100;
        tx(i2iSliderVal,`${pct}%`);
        persist();
      };
      i2iSlider.oninput=()=>_i2iSliderSet(parseInt(i2iSlider.value));
      i2iSlider.addEventListener("mouseup",()=>i2iSlider.blur());
      i2iSlider.addEventListener("touchend",()=>i2iSlider.blur());
      i2iSlider.addEventListener("wheel",(e)=>{
        e.preventDefault();e.stopPropagation();
        _i2iSliderSet(parseInt(i2iSlider.value)+(e.deltaY<0?1:-1)*(e.shiftKey?10:1));
      },{passive:false});

      i2iSliderWrap.append(i2iSliderHdr,i2iSlider);
      i2iPanel.append(i2iSlotRow,_i2iUseOrigNote,_i2iResizeRow,i2iSliderWrap);

      if(S.i2iImage) i2iSlot._restorePreview(S.i2iImage);



      // ── (paint/inpaint/sketch features removed) ──────────────────────────

      // ── RESOLUTION ───────────────────────────────────────────────────────
      const resSect=mk("div",{display:"flex",flexDirection:"column",gap:"4px"});
      const _sizeLabelRow=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
      _sizeLabelRow.appendChild(cap("Size"));
      resSect.appendChild(_sizeLabelRow);

      const resDD=DD(RES_PRESETS.map(p=>p.label),S.resLabel,val=>{
        const p=RES_PRESETS.find(r=>r.label===val);
        if(p&&p.w>0){
          S.resLabel=val;S.resW=p.w;S.resH=p.h;S.isCustomRes=false;
          customResRow.style.display="none";
        }else{
          S.resLabel=val;S.isCustomRes=true;
          customResRow.style.display="flex";
        }

        persist();_arRefreshDimsPreview();
      });
      resSect.appendChild(resDD.el);

      const customResRow=mk("div",{display:S.isCustomRes?"flex":"none",gap:"5px",alignItems:"center",marginTop:"5px"});

      // Swap W↔H button
      const _arSwapBtn=mk("button",{
        width:"18px",height:"22px",borderRadius:"4px",flexShrink:"0",
        background:"transparent",border:`1px solid ${C.border}`,
        color:C.muted,cursor:"pointer",outline:"none",padding:"0",
        display:"flex",alignItems:"center",justifyContent:"center",
        transition:"border-color .15s,color .15s",
      });
      _arSwapBtn.innerHTML=`<svg viewBox="0 0 10 14" width="9" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1L1 3.5L3 6"/><line x1="1" y1="3.5" x2="9" y2="3.5"/><path d="M7 8L9 10.5L7 13"/><line x1="9" y1="10.5" x2="1" y2="10.5"/></svg>`;
      _arSwapBtn.title="Swap W and H";
      _arSwapBtn.onmouseenter=()=>{_arSwapBtn.style.borderColor=LIME;_arSwapBtn.style.color=LIME;};
      _arSwapBtn.onmouseleave=()=>{_arSwapBtn.style.borderColor=C.border;_arSwapBtn.style.color=C.muted;};
      _arSwapBtn.onclick=()=>{
        const oldW=wInp.numVal||S.customW;
        const oldH=hInp.numVal||S.customH;
        S.customW=Math.max(1,Math.round(oldH));
        S.customH=Math.max(1,Math.round(oldW));
        wInp.setVal(S.customW);hInp.setVal(S.customH);
        if(_arLocked&&_arRatio) _arRatio=1/_arRatio;
        persist();_arRefreshDimsPreview();
      };

      // Aspect ratio lock
      let _arLocked=false;
      let _arRatio=null;
      const _arLockBtn=mk("button",{
        width:"22px",height:"22px",borderRadius:"5px",flexShrink:"0",
        background:"transparent",border:`1px solid ${C.border}`,
        color:C.muted,cursor:"pointer",outline:"none",padding:"0",
        display:"flex",alignItems:"center",justifyContent:"center",
        transition:"border-color .15s,color .15s,background .15s",
      });
      // Flat SVG lock icons
      const _lockIconOpen=`<svg viewBox="0 0 12 14" width="11" height="12" fill="currentColor"><rect x="1" y="6" width="10" height="8" rx="1.5"/><path d="M3.5 6V4a2.5 2.5 0 015 0" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`;
      const _lockIconClosed=`<svg viewBox="0 0 12 14" width="11" height="12" fill="currentColor"><rect x="1" y="6" width="10" height="8" rx="1.5"/><path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`;
      _arLockBtn.innerHTML=_lockIconOpen;
      const _arSetLocked=(locked)=>{
        _arLocked=locked;
        _arLockBtn.style.borderColor=locked?LIME:C.border;
        _arLockBtn.style.color=locked?LIME:C.muted;
        _arLockBtn.style.background=locked?"rgba(240,255,65,.08)":"transparent";
        _arLockBtn.innerHTML=locked?_lockIconClosed:_lockIconOpen;
      };
      // Get best available aspect ratio: current W/H
      const _arGetRatio=()=>{
        const cw=wInp.numVal||S.customW||1024;
        const ch=hInp.numVal||S.customH||1024;
        return cw/ch;
      };
      _arLockBtn.title="Lock aspect ratio";

      const snap8=(v)=>Math.max(16,Math.round(v/16)*16);

      // W/H inputs store raw values — no snapping in the field itself.
      // snap8 is applied only in getEffectiveW/H (workflow) and in the preview label.
      const _deactivateImgSize=()=>{};
      const wInp=NI("w",S.customW,1,8192,1,v=>{
        S.customW=Math.max(1,Math.round(v));
        if(_arLocked&&_arRatio){
          S.customH=Math.max(1,Math.round(S.customW/_arRatio));
          hInp.setVal(S.customH);
        }
        _deactivateImgSize();
        persist(); _arRefreshDimsPreview();
      },"80px");
      const xLbl=mk("span",{fontSize:"10px",color:C.muted,flexShrink:"0"});tx(xLbl,"×");
      const hInp=NI("h",S.customH,1,8192,1,v=>{
        S.customH=Math.max(1,Math.round(v));
        if(_arLocked&&_arRatio){
          S.customW=Math.max(1,Math.round(S.customH*_arRatio));
          wInp.setVal(S.customW);
        }
        _deactivateImgSize();
        persist(); _arRefreshDimsPreview();
      },"80px");

      wInp._inp.addEventListener("keydown",e=>{ if(e.key==="Tab"&&!e.shiftKey){ e.preventDefault(); hInp._inp.focus(); hInp._inp.select(); } });
      hInp._inp.addEventListener("keydown",e=>{ if(e.key==="Tab"&&e.shiftKey){ e.preventDefault(); wInp._inp.focus(); wInp._inp.select(); } });

      _arLockBtn.onclick=()=>{
        const nowLocked=!_arLocked;
        if(nowLocked) _arRatio=_arGetRatio();
        _arSetLocked(nowLocked);
        _arRefreshDimsPreview();
      };

      // Live dims preview — shows actual W×H after snap, lime colored
      const _arDimsPreview=mk("div",{
        fontSize:"9px",color:LIME,fontWeight:"600",whiteSpace:"nowrap",
        letterSpacing:".02em",opacity:"0.85",alignSelf:"center",
      });
      const _arRefreshDimsPreview=()=>{
        const rawW=S.isCustomRes?(wInp.numVal||S.customW||1024):S.resW;
        const rawH=S.isCustomRes?(hInp.numVal||S.customH||1024):S.resH;
        const sw=snap8(rawW), sh=snap8(rawH);
        // Show snapped dims (what will actually generate); dim if same as raw
        const changed=(sw!==rawW||sh!==rawH);
        tx(_arDimsPreview,`→ ${sw}×${sh}`);
        _arDimsPreview.style.opacity=changed?"1":"0.5";
        _arDimsPreview.title=changed?`Input: ${rawW}×${rawH} → snapped to ${sw}×${sh}`:"";
      };
      _arRefreshDimsPreview();

      customResRow.append(wInp,_arSwapBtn,hInp,_arLockBtn,_arDimsPreview);
      resSect.appendChild(customResRow);

      function updateSizeControls(){
        customResRow.style.display=S.isCustomRes?"flex":"none";
      }

      const seedInp=NI("seed",S.seed||0,0,999999999999,1,v=>{ S.seed=Math.round(v)||0; persist(); },"90px");

      // ── Advanced control panel ────────────────────────────────────────────
      let SAMPLERS=["euler","euler_cfg_pp","euler_ancestral","euler_ancestral_cfg_pp","heun","heunpp2","exp_heun_2_x0","exp_heun_2_x0_sde","dpm_2","dpm_2_ancestral","lms","dpm_fast","dpm_adaptive","dpmpp_2s_ancestral","dpmpp_2s_ancestral_cfg_pp","dpmpp_sde","dpmpp_sde_gpu","dpmpp_2m","dpmpp_2m_cfg_pp","dpmpp_2m_sde","dpmpp_2m_sde_gpu","dpmpp_2m_sde_heun","dpmpp_2m_sde_heun_gpu","dpmpp_3m_sde","dpmpp_3m_sde_gpu","ddpm","lcm","ipndm","ipndm_v","deis","res_multistep","res_multistep_cfg_pp","res_multistep_ancestral","res_multistep_ancestral_cfg_pp","gradient_estimation","gradient_estimation_cfg_pp","er_sde","seeds_2","seeds_3","sa_solver","sa_solver_pece","ddim","uni_pc","uni_pc_bh2"];
      let SCHEDULERS=["simple","sgm_uniform","karras","exponential","ddim_uniform","beta","normal","linear_quadratic","kl_optimal"];
      const ADV_BORDER="rgba(100,80,180,.5)";
      const ADV_BG="rgba(26,20,60,.55)";
      const ADV_LABEL="rgba(160,140,220,.7)";

      const advPanel=mk("div",{
        display:"none",flexDirection:"column",gap:"4px",
        border:`1px solid ${ADV_BORDER}`,borderRadius:"6px",
        padding:"5px",background:ADV_BG,
      });

      const _advNIStyle=(ni)=>{ ni._inp.style.fontSize="9px"; ni._inp.style.padding="1px 2px"; ni._inp.style.height="22px"; return ni; };
      const stepsInp=_advNIStyle(NI("steps",S.steps,1,150,1,v=>{S.steps=Math.round(v)||4;persist();},"100%"));
      const cfgInp=_advNIStyle(NI("cfg",S.cfg,0,30,0.1,v=>{S.cfg=parseFloat(v.toFixed(2));persist();},"100%"));
      _advControlsReady=true;

      const _advDDStyle=(dd)=>{
        const trig=dd.el.querySelector("div");
        if(trig){ trig.style.height="22px"; trig.style.fontSize="9px"; trig.style.padding="0 6px"; }
        return dd;
      };
      const samplerDD=_advDDStyle(DD(SAMPLERS,S.sampler,v=>{S.sampler=v;persist();}));
      const schedulerDD=_advDDStyle(DD(SCHEDULERS,S.scheduler,v=>{S.scheduler=v;persist();}));

      // Fetch available samplers/schedulers from ComfyUI (includes custom node samplers)
      api.fetchApi("/object_info/KSampler").then(r=>r.json()).then(d=>{
        const info=d?.KSampler?.input?.required;
        const slist=info?.sampler_name?.[0];
        const schlist=info?.scheduler?.[0];
        if(Array.isArray(slist)&&slist.length){
          SAMPLERS=slist;
          samplerDD.updateItems(slist);
          if(slist.includes(S.sampler)) samplerDD.set(S.sampler);
          else{ S.sampler=slist[0]; samplerDD.set(slist[0]); persist(); }
        }
        if(Array.isArray(schlist)&&schlist.length){
          SCHEDULERS=schlist;
          schedulerDD.updateItems(schlist);
          if(schlist.includes(S.scheduler)) schedulerDD.set(S.scheduler);
          else{ S.scheduler=schlist[0]; schedulerDD.set(schlist[0]); persist(); }
        }
      }).catch(()=>{});


      // Seed controls
      const _advSeedInp=_advNIStyle(NI("seed",S.seed||0,0,999999999999,1,v=>{
        S.seed=Math.round(v)||0; seedInp.setVal(S.seed); persist();
      },"60px"));
      _advSeedInp._inp.disabled=S.randomizeSeed;
      _advSeedInp.style.opacity=S.randomizeSeed?"0.4":"1";

      const _advSeedIconLock=`<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const _advSeedIconDice=`<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="16" cy="8" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="8" cy="16" r="1.3" fill="currentColor"/><circle cx="16" cy="16" r="1.3" fill="currentColor"/></svg>`;

      const _advSeedLockBtn=mk("button",{
        background:"transparent",border:"none",padding:"0 1px",cursor:"pointer",outline:"none",
        display:"flex",alignItems:"center",gap:"3px",flexShrink:"0",color:ADV_LABEL,transition:"color .15s",
      });
      const _advSeedStateLbl=mk("span",{fontSize:"7px",fontWeight:"700",letterSpacing:".06em",textTransform:"uppercase",whiteSpace:"nowrap",transition:"color .15s"});
      const _advSeedRefresh=()=>{
        _advSeedLockBtn.innerHTML="";
        const ico=mk("span"); ico.innerHTML=S.randomizeSeed?_advSeedIconDice:_advSeedIconLock;
        tx(_advSeedStateLbl,S.randomizeSeed?"Random":"Locked");
        const col=S.randomizeSeed?ADV_LABEL:"#c0a0ff";
        _advSeedLockBtn.style.color=col;
        _advSeedStateLbl.style.color=col;
        _advSeedLockBtn.append(ico,_advSeedStateLbl);
        _advSeedInp._inp.disabled=S.randomizeSeed;
        _advSeedInp.style.opacity=S.randomizeSeed?"0.4":"1";
      };
      _advSeedRefresh();
      _advSeedLockBtn.onclick=()=>{ S.randomizeSeed=!S.randomizeSeed; persist(); _advSeedRefresh(); _advRefresh(); };
      _advSeedLockBtn.onmouseenter=()=>{ _advSeedLockBtn.style.color="#d0b0ff"; _advSeedStateLbl.style.color="#d0b0ff"; };
      _advSeedLockBtn.onmouseleave=()=>_advSeedRefresh();

      // Helper: inline label+control pair
      const _mkInline=(lbl,el)=>{
        const w=mk("div",{display:"flex",alignItems:"center",gap:"3px",flexShrink:"0"});
        const l=mk("span",{fontSize:"7px",fontWeight:"700",color:ADV_LABEL,letterSpacing:".06em",textTransform:"uppercase",whiteSpace:"nowrap"});
        tx(l,lbl); w.append(l,el); return w;
      };

      // Single flat row: Steps · CFG · 🎲seed · Sampler · Scheduler
      const advRow1=mk("div",{display:"flex",gap:"5px",alignItems:"center",flexWrap:"wrap"});
      stepsInp.style.width="34px"; stepsInp.style.minWidth="0";
      cfgInp.style.width="30px"; cfgInp.style.minWidth="0";
      samplerDD.el.style.width="80px";
      schedulerDD.el.style.width="70px";
      const _advSeedGroup=mk("div",{display:"flex",alignItems:"center",gap:"2px",flexShrink:"0"});
      _advSeedGroup.append(_mkInline("Seed",_advSeedInp),_advSeedLockBtn);
      advRow1.append(
        _mkInline("Steps",stepsInp),
        _mkInline("CFG",cfgInp),
        _advSeedGroup,
        _mkInline("Sampler",samplerDD.el),
        _mkInline("Scheduler",schedulerDD.el),
      );

      advPanel.append(advRow1);

      // Seed locked warning — shown when advanced UI is off but seed is fixed
      const _seedLockedWarn=mk("div",{
        display:"none",alignItems:"center",gap:"8px",
        background:"rgba(160,120,255,.10)",border:"1px solid rgba(160,120,255,.35)",
        borderRadius:"6px",padding:"6px 10px",
      });
      const _seedLockedIcon=mk("span",{fontSize:"12px",flexShrink:"0"});tx(_seedLockedIcon,"🔒");
      const _seedLockedText=mk("div",{fontSize:"8px",color:"rgba(200,180,255,.9)",lineHeight:"1.5",flex:"1"});
      tx(_seedLockedText,"Seed is locked — you left it fixed.");
      const _seedLockedBtn=mk("button",{
        background:"rgba(160,120,255,.25)",border:"1px solid rgba(160,120,255,.6)",
        borderRadius:"4px",padding:"3px 8px",fontSize:"8px",fontWeight:"700",
        color:"#d0b8ff",cursor:"pointer",outline:"none",flexShrink:"0",
        transition:"background .15s,border-color .15s",whiteSpace:"nowrap",
      });
      tx(_seedLockedBtn,"Set to random");
      _seedLockedBtn.onmouseenter=()=>{_seedLockedBtn.style.background="rgba(160,120,255,.4)";};
      _seedLockedBtn.onmouseleave=()=>{_seedLockedBtn.style.background="rgba(160,120,255,.25)";};
      _seedLockedBtn.onclick=()=>{
        S.randomizeSeed=true; persist();
        _advSeedRefresh();
        _advRefresh();
      };
      _seedLockedWarn.append(_seedLockedIcon,_seedLockedText,_seedLockedBtn);

      const _advRefresh=()=>{
        advPanel.style.display=S.advancedUI?"flex":"none";
        _seedLockedWarn.style.display=(!S.advancedUI&&!S.randomizeSeed)?"flex":"none";
      };
      _advRefresh();

      const genRow=mk("div",{display:"flex",gap:"0",alignItems:"stretch",marginTop:"auto",width:"100%",boxSizing:"border-box"});
      const genBtn=mk("button",{
        background:LIME,color:"#111",border:"2px solid transparent",borderRadius:"8px",
        padding:"0",height:"38px",fontSize:"13px",fontWeight:"700",
        cursor:"pointer",flex:"1",letterSpacing:".02em",
        transition:"background .3s,color .3s,border-color .3s,box-shadow .15s,transform .1s",
        outline:"none",position:"relative",overflow:"hidden",
      });
      tx(genBtn,"Generate");
      const _genSweep=mk("div",{
        position:"absolute",top:"0",left:"-80%",width:"50%",height:"100%",
        background:"linear-gradient(90deg,transparent 0%,rgba(255,255,255,.75) 50%,transparent 100%)",
        transform:"skewX(-20deg)",pointerEvents:"none",opacity:"0",transition:"none",
      });
      genBtn.appendChild(_genSweep);
      genBtn.onmouseenter=()=>{
        if(!S.generating){
          _genSweep.style.animation="none";void _genSweep.offsetWidth;
          _genSweep.style.animation="fk-light-sweep 1s ease forwards";
        }
      };

      const stopBtn=mk("button",{
        background:"transparent",border:`1px solid ${C.border}`,borderRadius:"8px",
        color:C.muted,fontSize:"12px",cursor:"pointer",
        maxWidth:"0",minWidth:"0",width:"0",opacity:"0",padding:"0",height:"38px",
        transition:"max-width .25s ease, opacity .25s ease, padding .25s ease",outline:"none",
        overflow:"hidden",flexShrink:"0",whiteSpace:"nowrap",
      });
      tx(stopBtn,"■ Stop");
      stopBtn.onmouseenter=()=>{stopBtn.style.borderColor=C.err;stopBtn.style.color=C.err;};
      stopBtn.onmouseleave=()=>{stopBtn.style.borderColor=C.border;stopBtn.style.color=C.muted;};
      let _activePromptId=null;
      stopBtn.onclick=async()=>{
        // 1. Interrupt the currently running execution immediately
        try{ await api.fetchApi("/interrupt",{method:"POST"}); }catch(e){}
        // 2. Delete our prompt from the queue if it's still pending
        if(_activePromptId){
          try{
            await api.fetchApi("/queue",{
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({delete:[_activePromptId]}),
            });
          }catch(e){}
          _activePromptId=null;
        }
        resetBtn();
      };
      genRow.append(genBtn,stopBtn);

      // ── LEFT PANEL ASSEMBLY ──────────────────────────────────────────────

      leftPanel.append(i2iPanel,resSect,advPanel,_seedLockedWarn,genRow);

      // ── RIGHT PANEL — Preview area fills available height ──
      const rightPanel=mk("div",{flex:"1",minWidth:"0",display:"flex",flexDirection:"column",overflow:"hidden"});
      const previewBox=mk("div",{
        width:"100%",flex:"1",minHeight:"0",background:"#000",
        borderRadius:"10px",border:`1px solid ${C.border}`,
        position:"relative",overflow:"hidden",
      });

      // Placeholder
      const placeholder=mk("div",{
        position:"absolute",inset:"0",display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",gap:"10px",
      });
      const placeholderSvg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      placeholderSvg.setAttribute("viewBox","0 0 24 24");placeholderSvg.setAttribute("width","40");placeholderSvg.setAttribute("height","40");
      placeholderSvg.setAttribute("fill","none");placeholderSvg.setAttribute("stroke","currentColor");
      placeholderSvg.setAttribute("stroke-width","1");placeholderSvg.setAttribute("stroke-linecap","round");
      placeholderSvg.style.color=C.border;
      placeholderSvg.innerHTML=`<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`;
      const placeholderLbl=mk("div",{fontSize:"11px",color:C.muted});
      tx(placeholderLbl,"Generated image will appear here");
      placeholder.append(placeholderSvg,placeholderLbl);

      // Final image
      const finalImg=mk("img",{
        position:"absolute",inset:"0",width:"100%",height:"100%",
        objectFit:"contain",display:"none",borderRadius:"10px",
      });

      // Progress bar — overlaid at the bottom of the preview box
      const progWrap=mk("div",{
        position:"absolute",bottom:"0",left:"0",right:"0",
        background:"linear-gradient(transparent,rgba(0,0,0,.88))",
        padding:"16px 14px 12px",display:"none",
        flexDirection:"column",gap:"4px",boxSizing:"border-box",pointerEvents:"none",
      });
      const progTop=mk("div",{display:"flex",justifyContent:"space-between",alignItems:"center"});
      const progStageL=mk("div",{fontSize:"11px",fontWeight:"600",color:C.text,textAlign:"center",flex:"1"});
      tx(progStageL,"Generating…");
      const progPct=mk("div",{fontSize:"10px",color:C.muted,flexShrink:"0"});tx(progPct,"0%");
      progTop.append(progStageL,progPct);
      const progBar=mk("div",{height:"3px",borderRadius:"2px",background:"rgba(255,255,255,.15)",overflow:"hidden",marginTop:"4px"});
      const progFill=mk("div",{height:"100%",background:LIME,width:"0%",transition:"width .3s ease",borderRadius:"2px"});
      progBar.appendChild(progFill);
      const progDetailL=mk("div",{fontSize:"9px",color:"rgba(255,255,255,.5)",textAlign:"center",marginTop:"2px"});
      progWrap.append(progTop,progBar,progDetailL);

      const setStage=(l,d,p)=>{
        tx(progStageL,l);tx(progDetailL,d);
        progFill.style.width=p+"%";tx(progPct,Math.round(p)+"%");
      };

      // ── Image Comparer — always active after I2I generation ──────────────
      // Generated image fills the box; Image 1 revealed from the right by dragging divider left.
      // Divider starts at 100% (full generated shown), user drags left to reveal Image 1.
      const comparerWrap=mk("div",{
        position:"absolute",inset:"0",display:"none",cursor:"col-resize",
        userSelect:"none",borderRadius:"10px",overflow:"hidden",
      });

      // Image 1 (reference) — full-size background, visible on the right of divider
      const comparerBase=mk("img",{
        position:"absolute",inset:"0",width:"100%",height:"100%",objectFit:"contain",
      });

      // Generated image — clipped to left portion
      const comparerGen=mk("div",{
        position:"absolute",top:"0",left:"0",bottom:"0",overflow:"hidden",
        width:"100%", // starts at 100% so only generated is visible
      });
      const comparerGenImg=mk("img",{
        position:"absolute",top:"0",left:"0",height:"100%",objectFit:"contain",
      });
      comparerGen.appendChild(comparerGenImg);

      // Divider line
      const comparerLine=mk("div",{
        position:"absolute",top:"0",bottom:"0",width:"2px",
        background:LIME,left:"calc(100% - 1px)",
        boxShadow:"0 0 8px rgba(240,255,65,.5)",
        display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
        gap:"6px",zIndex:"4",
      });

      // Handle circle on divider
      const comparerHandle=mk("div",{
        width:"30px",height:"30px",borderRadius:"50%",background:LIME,
        border:"2px solid #111",flexShrink:"0",
        display:"flex",alignItems:"center",justifyContent:"center",
        boxShadow:"0 2px 10px rgba(0,0,0,.7)",pointerEvents:"none",
      });
      comparerHandle.innerHTML=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round"><path d="M8 4l-4 8 4 8M16 4l4 8-4 8"/></svg>`;
      comparerLine.append(comparerHandle);
      comparerWrap.append(comparerBase,comparerGen,comparerLine);

      // Drag logic
      let _cmpDragging=false;
      const _cmpSetPct=(pct)=>{
        pct=Math.max(0,Math.min(100,pct));
        comparerGen.style.width=pct+"%";
        comparerLine.style.left=`calc(${pct}% - 1px)`;
        comparerGenImg.style.width=(comparerWrap.offsetWidth||620)+"px";
      };

      comparerWrap.addEventListener("mousedown",e=>{
        _cmpDragging=true;e.preventDefault();
      });
      document.addEventListener("mousemove",e=>{
        if(!_cmpDragging) return;
        const r=comparerWrap.getBoundingClientRect();
        _cmpSetPct((e.clientX-r.left)/r.width*100);
      });
      document.addEventListener("mouseup",()=>{ _cmpDragging=false; });
      comparerWrap.addEventListener("touchstart",()=>{_cmpDragging=true;},{passive:true});
      comparerWrap.addEventListener("touchmove",e=>{
        if(!_cmpDragging) return;
        const r=comparerWrap.getBoundingClientRect();
        _cmpSetPct((e.touches[0].clientX-r.left)/r.width*100);
      },{passive:true});
      comparerWrap.addEventListener("touchend",()=>{ _cmpDragging=false; });

      // "Use as…" dropdown — top-right of previewBox, visible after generation
      const previewUseWrap=mk("div",{
        position:"absolute",top:"10px",right:"10px",zIndex:"5",display:"none",
      });
      const previewUseBtn=mk("button",{
        background:"rgba(20,20,20,.88)",color:"rgba(255,255,255,.88)",
        border:"1px solid rgba(255,255,255,.22)",
        borderRadius:"6px",padding:"4px 11px",fontSize:"9px",fontWeight:"600",
        cursor:"pointer",outline:"none",whiteSpace:"nowrap",
        backdropFilter:"blur(4px)",letterSpacing:".04em",
        boxShadow:"0 2px 8px rgba(0,0,0,.5)",
        display:"flex",alignItems:"center",gap:"5px",
        transition:"background .15s,color .15s,border-color .15s",
      });
      previewUseBtn.innerHTML=`Use as… <svg viewBox="0 0 10 6" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="1,1 5,5 9,1"/></svg>`;
      previewUseBtn.onmouseenter=()=>{previewUseBtn.style.background="rgba(40,40,40,.97)";previewUseBtn.style.color="#fff";previewUseBtn.style.borderColor="rgba(255,255,255,.4)";};
      previewUseBtn.onmouseleave=()=>{previewUseBtn.style.background="rgba(20,20,20,.88)";previewUseBtn.style.color="rgba(255,255,255,.88)";previewUseBtn.style.borderColor="rgba(255,255,255,.22)";};

      const previewUseDrop=mk("div",{
        position:"absolute",top:"calc(100% + 4px)",right:"0",
        background:C.bg1,border:`1px solid ${C.borderH}`,borderRadius:"8px",
        minWidth:"160px",overflow:"hidden",display:"none",zIndex:"200",
        boxShadow:"0 4px 20px rgba(0,0,0,.7)",flexDirection:"column",
      });
      const _mkPUSection=(label)=>{ const h=mk("div",{padding:"6px 12px 3px",fontSize:"8px",fontWeight:"700",letterSpacing:".08em",textTransform:"uppercase",color:C.muted,userSelect:"none"});tx(h,label);return h; };
      const _mkPUItem=(label,icon,fn)=>{ const row=mk("div",{padding:"7px 12px",fontSize:"10px",fontWeight:"500",color:C.text,cursor:"pointer",display:"flex",alignItems:"center",gap:"7px",transition:"background .1s,color .1s",userSelect:"none"});const ico=mk("span",{fontSize:"11px",width:"14px",textAlign:"center",flexShrink:"0",color:C.muted});tx(ico,icon);const lbl=mk("span");tx(lbl,label);row.append(ico,lbl);row.onmouseenter=()=>{row.style.background="rgba(240,255,65,.10)";row.style.color=LIME;ico.style.color=LIME;};row.onmouseleave=()=>{row.style.background="";row.style.color=C.text;ico.style.color=C.muted;};row.onclick=()=>{previewUseDrop.style.display="none";_puDropOpen=false;fn();};return row; };
      const _mkPUDivider=()=>mk("div",{height:"1px",background:C.border,margin:"2px 0"});

      const _getLastSrc=()=>_lastGenObj||(_galImages&&_galImages[0]);
      const _puUpload=async(fn)=>{ const v=_getLastSrc();if(!v)return;try{const n=await _uploadOutputToInput(v);fn(n);}catch(e){console.warn("[ZImageOneNode] use-as:",e);} };

      previewUseDrop.append(
        _mkPUSection("I2I"),
        _mkPUItem("I2I slot","⟳",()=>_puUpload(n=>{setPill("i2i");S.i2iImage=n;i2iSlot._restorePreview(n);persist();})),
      );

      let _puDropOpen=false;
      previewUseBtn.onclick=e=>{ e.stopPropagation();_puDropOpen=!_puDropOpen;previewUseDrop.style.display=_puDropOpen?"flex":"none"; };
      document.addEventListener("click",()=>{ if(_puDropOpen){previewUseDrop.style.display="none";_puDropOpen=false;} });
      previewUseDrop.addEventListener("click",e=>e.stopPropagation());
      previewUseWrap.append(previewUseBtn,previewUseDrop);

      // ── Delete helper ─────────────────────────────────────────────────────
      // Confirm popover for delete — shows "Sure? Yes / Keep" near the trigger button
      const _confirmPop=mk("div",{
        position:"fixed",zIndex:"99999",
        background:"#18181c",border:`1px solid rgba(255,80,80,.45)`,
        borderRadius:"10px",padding:"10px 14px",
        display:"none",flexDirection:"column",alignItems:"center",gap:"8px",
        boxShadow:"0 6px 24px rgba(0,0,0,.7)",
        minWidth:"110px",
      });
      const _confirmTxt=mk("div",{fontSize:"11px",fontWeight:"600",color:"rgba(255,200,200,.9)",
        letterSpacing:".02em",whiteSpace:"nowrap"});
      tx(_confirmTxt,"Sure?");
      const _confirmBtns=mk("div",{display:"flex",gap:"6px"});
      const _mkConfBtn=(label,bg,hoverBg,color,border)=>{
        const b=mk("button",{
          background:bg,border:`1px solid ${border}`,borderRadius:"6px",
          padding:"4px 13px",fontSize:"10px",fontWeight:"700",
          color,cursor:"pointer",outline:"none",letterSpacing:".04em",
          transition:"background .12s,border-color .12s",
        });
        tx(b,label);
        b.onmouseenter=()=>{b.style.background=hoverBg;};
        b.onmouseleave=()=>{b.style.background=bg;};
        return b;
      };
      const _confirmYes=_mkConfBtn("Yes","rgba(180,30,30,.8)","rgba(220,40,40,.95)","#ffb0b0","rgba(255,80,80,.5)");
      const _confirmKeep=_mkConfBtn("Keep","rgba(255,255,255,.06)","rgba(255,255,255,.13)","rgba(255,255,255,.7)","rgba(255,255,255,.18)");
      _confirmBtns.append(_confirmYes,_confirmKeep);
      _confirmPop.append(_confirmTxt,_confirmBtns);
      document.body.appendChild(_confirmPop);

      let _confirmResolve=null;
      const _showConfirm=(anchorEl)=>new Promise(res=>{
        _confirmResolve=res;
        const r=anchorEl.getBoundingClientRect();
        // Position above the button, centered
        _confirmPop.style.display="flex";
        const pw=_confirmPop.offsetWidth||120;
        let left=r.left+r.width/2-pw/2;
        let top=r.top-_confirmPop.offsetHeight-8;
        if(top<8) top=r.bottom+8;
        left=Math.max(8,Math.min(left,window.innerWidth-pw-8));
        _confirmPop.style.left=left+"px";
        _confirmPop.style.top=top+"px";
      });
      const _hideConfirm=()=>{ _confirmPop.style.display="none"; _confirmResolve=null; };
      _confirmYes.onclick=()=>{ const r=_confirmResolve; _hideConfirm(); r?.(true); };
      _confirmKeep.onclick=()=>{ const r=_confirmResolve; _hideConfirm(); r?.(false); };
      document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&_confirmPop.style.display!=="none"){ _hideConfirm(); _confirmResolve?.(false); } });
      document.addEventListener("click",e=>{ if(_confirmPop.style.display!=="none"&&!_confirmPop.contains(e.target)) { _hideConfirm(); _confirmResolve?.(false); } },{capture:true});

      const _deleteImage=async(imgObj,anchorEl,onSuccess)=>{
        if(!imgObj||!imgObj.filename) return;
        const ok=await _showConfirm(anchorEl);
        if(!ok) return;
        try{
          const r=await api.fetchApi("/z_image/delete",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({filename:imgObj.filename,subfolder:imgObj.subfolder||""}),
          });
          const d=await r.json();
          if(d.ok){ onSuccess?.(); }
          else{ console.warn("[ZImageOneNode] delete failed:",(d.error||"unknown")); }
        }catch(e){ console.warn("[ZImageOneNode] delete error:",fmtErr(e)); }
      };

      // Preview delete button — bottom-right of previewBox
      const previewDelBtn=mk("button",{
        position:"absolute",bottom:"10px",right:"10px",zIndex:"5",
        width:"28px",height:"28px",borderRadius:"8px",
        background:"rgba(180,30,30,.75)",border:"1px solid rgba(255,80,80,.35)",
        color:"rgba(255,200,200,.9)",cursor:"pointer",outline:"none",
        display:"none",alignItems:"center",justifyContent:"center",padding:"0",
        backdropFilter:"blur(4px)",transition:"background .15s,border-color .15s",
      });
      previewDelBtn.title="Delete image";
      previewDelBtn.innerHTML=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      previewDelBtn.onmouseenter=()=>{previewDelBtn.style.background="rgba(220,40,40,.95)";previewDelBtn.style.borderColor="rgba(255,80,80,.7)";};
      previewDelBtn.onmouseleave=()=>{previewDelBtn.style.background="rgba(180,30,30,.75)";previewDelBtn.style.borderColor="rgba(255,80,80,.35)";};
      previewDelBtn.onclick=()=>{
        const src=_getLastSrc();
        if(!src) return;
        _deleteImage(src,previewDelBtn,()=>{
          // Hide preview, show placeholder, clear _lastGenObj
          finalImg.src="";finalImg.style.display="none";
          comparerWrap.style.display="none";
          previewUseWrap.style.display="none";
          previewDelBtn.style.display="none";
          placeholder.style.display="flex";
          _lastGenObj=null;
          _galNeedsRefresh=true;
        });
      };

      // Comparer activates automatically in EDIT mode after generation

      previewBox.append(placeholder,finalImg,comparerWrap,previewUseWrap,previewDelBtn,progWrap);
      rightPanel.appendChild(previewBox);

      mainRow.append(leftPanel,rightPanel);

      // ── PROMPT ───────────────────────────────────────────────────────────
      const promptWrap=mk("div",{display:"flex",flexDirection:"column",gap:"5px"});
      const promptHdr=mk("div",{display:"flex",alignItems:"center",gap:"5px"});
      const promptCap=cap("Prompt");

      // ── LoRA overlay ──────────────────────────────────────────────────────
      const _ulOverlay=mk("div",{
        position:"fixed",inset:"0",zIndex:"99998",display:"none",
        alignItems:"center",justifyContent:"center",
      });
      const _ulBg=mk("div",{position:"absolute",inset:"0",background:"rgba(0,0,0,.7)"});
      const _ulPanel=mk("div",{
        position:"relative",
        background:"linear-gradient(145deg,#111 0%,#0d0d0d 100%)",
        border:`1px solid rgba(240,255,65,.18)`,
        borderRadius:"16px",padding:"20px 22px 22px",width:"520px",
        boxShadow:"0 20px 60px rgba(0,0,0,.95),inset 0 1px 0 rgba(255,255,255,.04)",
        display:"flex",flexDirection:"column",gap:"16px",
      });
      const _ulPHdr=mk("div",{display:"flex",alignItems:"center",gap:"8px"});
      const _ulPTitle=mk("div",{fontSize:"12px",fontWeight:"700",color:"#fff",flex:"1",
        letterSpacing:".06em",textTransform:"uppercase"});
      tx(_ulPTitle,"LoRA");
      const _ulPClose=mk("button",{background:"none",border:"none",cursor:"pointer",
        color:C.muted,fontSize:"16px",lineHeight:"1",padding:"0",outline:"none",flexShrink:"0"});
      tx(_ulPClose,"×");
      _ulPClose.onmouseenter=()=>_ulPClose.style.color="#fff";
      _ulPClose.onmouseleave=()=>_ulPClose.style.color=C.muted;
      _ulPClose.onclick=()=>{ _ulOverlay.style.display="none"; hideDimmer(); };
      _ulBg.onclick=()=>{ _ulOverlay.style.display="none"; hideDimmer(); };
      const _ulRefreshBtn=mk("button",{background:"none",border:"none",cursor:"pointer",
        color:C.muted,fontSize:"13px",lineHeight:"1",padding:"0 6px 0 0",outline:"none",flexShrink:"0"});
      tx(_ulRefreshBtn,"↻");
      _ulRefreshBtn.title="Refresh model list";
      _ulRefreshBtn.onmouseenter=()=>_ulRefreshBtn.style.color="#fff";
      _ulRefreshBtn.onmouseleave=()=>_ulRefreshBtn.style.color=C.muted;
      _ulRefreshBtn.onclick=()=>{ tx(_ulRefreshBtn,"↻"); _loadModels(); };
      _ulPHdr.append(_ulPTitle,_ulRefreshBtn,_ulPClose);
      const _ulPSub=mk("div",{width:"100%",height:"1px",background:"rgba(240,255,65,.10)",marginTop:"-6px"});
      const _ulRows=mk("div",{display:"flex",flexDirection:"column",gap:"10px"});

      const _mkULRow=(idx)=>{
        const row=mk("div",{display:"flex",flexDirection:"column",gap:"4px"});
        const rowLbl=mk("div",{fontSize:"7px",color:"rgba(240,255,65,.5)",fontWeight:"700",
          letterSpacing:".1em",textTransform:"uppercase"});
        tx(rowLbl,`SLOT ${idx+1}`);
        const rowCtrl=mk("div",{display:"flex",alignItems:"center",gap:"6px"});

        // Trigger words area — shown below the control row
        const trigRow=mk("div",{display:"none",flexDirection:"column",gap:"5px",
          marginTop:"2px",padding:"8px 10px",background:"rgba(240,255,65,.04)",
          border:`1px solid rgba(240,255,65,.12)`,borderRadius:"8px",
        });
        const trigTopRow=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
        const trigLbl=mk("div",{fontSize:"9px",fontWeight:"600",color:C.muted,whiteSpace:"nowrap",flexShrink:"0"});
        tx(trigLbl,"Trigger words:");
        const trigVal=mk("div",{fontSize:"10px",color:LIME,flex:"1",minWidth:"0",
          wordBreak:"break-word",lineHeight:"1.4"});
        tx(trigVal,"—");
        trigTopRow.append(trigLbl,trigVal);

        // Custom trigger input row
        const trigCustomRow=mk("div",{display:"flex",alignItems:"center",gap:"5px",marginTop:"2px"});
        const trigCustomLbl=mk("div",{fontSize:"8px",color:C.muted,whiteSpace:"nowrap",flexShrink:"0"});
        tx(trigCustomLbl,"Custom:");
        const trigCustomInp=mk("input",{
          flex:"1",background:"rgba(255,255,255,.06)",border:`1px solid rgba(255,255,255,.12)`,
          borderRadius:"5px",color:C.text,fontSize:"10px",padding:"3px 7px",
          outline:"none",transition:"border-color .15s",
        },{type:"text",placeholder:"Add custom trigger words…"});
        trigCustomInp.onfocus=()=>trigCustomInp.style.borderColor=LIME;
        trigCustomInp.onblur=()=>trigCustomInp.style.borderColor="rgba(255,255,255,.12)";
        const trigSaveBtn=mk("button",{
          background:"rgba(255,255,255,.07)",border:`1px solid rgba(255,255,255,.15)`,
          borderRadius:"5px",cursor:"pointer",color:C.muted,fontSize:"9px",fontWeight:"700",
          padding:"3px 9px",outline:"none",transition:"all .15s",flexShrink:"0",whiteSpace:"nowrap",
        });
        tx(trigSaveBtn,"Save");
        trigSaveBtn.onmouseenter=()=>{trigSaveBtn.style.background="rgba(240,255,65,.12)";trigSaveBtn.style.borderColor=LIME;trigSaveBtn.style.color=LIME;};
        trigSaveBtn.onmouseleave=()=>{trigSaveBtn.style.background="rgba(255,255,255,.07)";trigSaveBtn.style.borderColor="rgba(255,255,255,.15)";trigSaveBtn.style.color=C.muted;};
        trigSaveBtn.onclick=async()=>{
          const name=ulDD.value;
          if(!name||name==="none") return;
          const txt=trigCustomInp.value.trim();
          await _saveCustomTrigger(name,txt);
          // Update displayed value and clear input field
          tx(trigVal,txt||"—");
          trigCustomInp.value="";
          trigSaveBtn.style.color=LIME; tx(trigSaveBtn,"Saved ✓");
          setTimeout(()=>{ trigSaveBtn.style.color=C.muted; tx(trigSaveBtn,"Save"); },1500);
        };
        trigCustomRow.append(trigCustomLbl,trigCustomInp,trigSaveBtn);
        trigRow.append(trigTopRow,trigCustomRow);

        // Load and display trigger words when lora changes
        const _refreshTrigWords=async(loraName)=>{
          if(!loraName||loraName==="none"){ trigRow.style.display="none"; return; }
          trigRow.style.display="flex";
          tx(trigVal,"…");
          trigCustomInp.value="";
          await _loadCustomTriggers();
          const custom=_getCustomTrigger(loraName);
          if(custom){
            // Custom always wins over metadata
            tx(trigVal,custom);
          } else {
            try{
              const r=await api.fetchApi(`/z_image/lora_triggers?name=${encodeURIComponent(loraName)}`);
              const d=await r.json();
              tx(trigVal,(d.ok&&d.triggers?.length)?d.triggers.join(", "):"—");
            }catch(e){ tx(trigVal,"—"); }
          }
        };

        const ulDD=DD(["none"],"none",v=>{
          const has=v&&v!=="none";
          S.userLoras[idx].name=has?v:"";
          if(!has){ S.userLoras[idx].strength=0; ulStr.value="0"; }
          else if(S.userLoras[idx].strength===0){ S.userLoras[idx].strength=1; ulStr.value="1"; }
          _ulUpdateBtn();persist();
          _refreshTrigWords(v);
        });
        ulDD.el.style.flex="1";ulDD.el.style.minWidth="0";

        const ulStr=mk("input",{
          width:"44px",textAlign:"center",background:"rgba(255,255,255,.06)",
          border:`1px solid rgba(255,255,255,.1)`,borderRadius:"6px",
          color:LIME,fontSize:"10px",fontWeight:"700",
          padding:"5px 0",outline:"none",transition:"border-color .15s",flexShrink:"0",
        },{type:"number",step:"0.05",value:String(S.userLoras[idx].name&&S.userLoras[idx].name!=="none"?S.userLoras[idx].strength||1:0)});
        ulStr.onfocus=()=>ulStr.style.borderColor=LIME;
        ulStr.onblur=()=>{ S.userLoras[idx].strength=isNaN(+ulStr.value)?1:+ulStr.value;
          ulStr.value=String(S.userLoras[idx].strength);persist(); };
        ulStr.oninput=()=>{ S.userLoras[idx].strength=+ulStr.value||0;persist(); };

        const ulClr=mk("button",{
          background:"rgba(255,80,80,.08)",border:"1px solid rgba(255,80,80,.25)",borderRadius:"6px",
          cursor:"pointer",color:"rgba(255,100,100,.7)",fontSize:"9px",fontWeight:"700",
          padding:"5px 8px",outline:"none",transition:"all .15s",flexShrink:"0",
        });
        tx(ulClr,"CLR");
        ulClr.onmouseenter=()=>{ ulClr.style.background="rgba(255,80,80,.18)";ulClr.style.color="#ff6666"; };
        ulClr.onmouseleave=()=>{ ulClr.style.background="rgba(255,80,80,.08)";ulClr.style.color="rgba(255,100,100,.7)"; };
        ulClr.onclick=()=>{
          S.userLoras[idx]={name:"",strength:0};ulDD.set("none");ulStr.value="0";
          _ulUpdateBtn();persist();
          trigRow.style.display="none";
        };

        rowCtrl.append(ulDD.el,ulStr,ulClr);
        row.append(rowLbl,rowCtrl,trigRow);
        row._dd=ulDD;row._str=ulStr;

        // Restore trigger words display if lora already selected
        if(S.userLoras[idx].name&&S.userLoras[idx].name!=="none"){
          _refreshTrigWords(S.userLoras[idx].name);
        }
        return row;
      };
      const _ulRowEls=[_mkULRow(0),_mkULRow(1),_mkULRow(2)];
      _ulRowEls.forEach(r=>_ulRows.appendChild(r));

      // Info note at bottom of panel
      const _ulInfoNote=mk("div",{
        fontSize:"9px",color:C.muted,lineHeight:"1.5",
        padding:"8px 10px",background:"rgba(255,255,255,.03)",
        borderRadius:"6px",border:`1px solid ${C.border}`,
      });
      tx(_ulInfoNote,"✦ Trigger words are applied automatically if saved and set for the selected LoRA.");

      _ulPanel.append(_ulPHdr,_ulPSub,_ulRows,_ulInfoNote);
      _ulOverlay.append(_ulBg,_ulPanel);
      root.appendChild(_ulOverlay);

      // ── Collect trigger words for all active LoRAs at generate time ────────
      const _buildPromptWithTriggers=async(basePrompt)=>{
        await _loadCustomTriggers();
        const trigParts=[];
        for(const ul of S.userLoras){
          if(!ul.name||ul.name==="none"||!(+(ul.strength||0)>0)) continue;
          // Custom trigger words override metadata
          const custom=_getCustomTrigger(ul.name);
          if(custom){ trigParts.push(custom); continue; }
          // Try metadata
          try{
            const r=await api.fetchApi(`/z_image/lora_triggers?name=${encodeURIComponent(ul.name)}`);
            const d=await r.json();
            if(d.ok&&d.triggers?.length) trigParts.push(d.triggers.join(", "));
          }catch(e){}
        }
        if(!trigParts.length) return basePrompt;
        const prefix=trigParts.join(", ");
        return basePrompt.trim()?`${prefix}, ${basePrompt.trim()}`:prefix;
      };

      // ── Add LoRA button — identical style/layout to LTX node ─────────────
      const _ulBtn=mk("button",{
        background:"linear-gradient(135deg,rgba(240,255,65,.10),rgba(240,255,65,.04))",
        border:"1.5px solid rgba(240,255,65,.35)",cursor:"pointer",
        padding:"2px 8px 2px 6px",color:LIME,outline:"none",
        display:"flex",alignItems:"center",gap:"5px",borderRadius:"5px",
        transition:"all .15s",flexShrink:"0",marginLeft:"auto",
        boxShadow:"0 0 0 0 rgba(240,255,65,0)",
      });
      const _ulBtnIco=document.createElementNS("http://www.w3.org/2000/svg","svg");
      _ulBtnIco.setAttribute("viewBox","0 0 24 24");_ulBtnIco.setAttribute("width","9");_ulBtnIco.setAttribute("height","9");
      _ulBtnIco.setAttribute("fill","none");_ulBtnIco.setAttribute("stroke","currentColor");
      _ulBtnIco.setAttribute("stroke-width","2");_ulBtnIco.setAttribute("stroke-linecap","round");
      _ulBtnIco.innerHTML=`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`;
      const _ulBtnTxt=mk("span",{fontSize:"9px",fontWeight:"700",letterSpacing:".04em"});
      tx(_ulBtnTxt,"Add LoRA");
      const _ulBtnBadge=mk("span",{fontSize:"7px",fontWeight:"700",background:LIME,color:"#111",
        borderRadius:"20px",padding:"0 4px",lineHeight:"1.6",display:"none",flexShrink:"0"});
      _ulBtn.append(_ulBtnIco,_ulBtnTxt,_ulBtnBadge);
      _ulBtn.onmouseenter=()=>{ _ulBtn.style.background="linear-gradient(135deg,rgba(240,255,65,.18),rgba(240,255,65,.08))";_ulBtn.style.borderColor=LIME;_ulBtn.style.boxShadow="0 0 8px rgba(240,255,65,.12)"; };
      _ulBtn.onmouseleave=()=>{ _ulBtn.style.background="linear-gradient(135deg,rgba(240,255,65,.10),rgba(240,255,65,.04))";_ulBtn.style.borderColor="rgba(240,255,65,.35)";_ulBtn.style.boxShadow="0 0 0 0 rgba(240,255,65,0)"; };
      _ulBtn.onclick=()=>{ _ulOverlay.style.display="flex";showDimmer(); };

      const _ulUpdateBtn=()=>{
        const n=S.userLoras.filter(l=>l.name&&l.name!=="none").length;
        tx(_ulBtnBadge,String(n));
        _ulBtnBadge.style.display=n>0?"":"none";
        _ulBtn.style.borderColor=n>0?LIME:"rgba(240,255,65,.35)";
        _ulBtn.style.color=n>0?LIME:LIME;
      };
      _ulUpdateBtn();

      // ── Expand prompt button — identical style to LTX node ────────────────
      const _promptExpandBtn=mk("button",{
        background:"none",border:`1px solid ${C.border}`,cursor:"pointer",
        padding:"2px 7px 2px 5px",color:C.muted,outline:"none",
        display:"flex",alignItems:"center",gap:"5px",borderRadius:"5px",
        transition:"color .15s,border-color .15s",flexShrink:"0",
      });
      _promptExpandBtn.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span style="font-size:9px;font-weight:700;letter-spacing:.04em">Expand prompt</span>`;
      _promptExpandBtn.onmouseenter=()=>{ _promptExpandBtn.style.color="#fff";_promptExpandBtn.style.borderColor="#555"; };
      _promptExpandBtn.onmouseleave=()=>{ _promptExpandBtn.style.color=C.muted;_promptExpandBtn.style.borderColor=C.border; };

      // Error chip (shown when error is minimized)
      const errMinChip=mk("button",{
        display:"none",alignItems:"center",gap:"4px",
        background:"none",border:`1px solid rgba(255,103,103,.35)`,
        borderRadius:"5px",padding:"2px 7px",cursor:"pointer",outline:"none",
        color:"rgba(255,103,103,.8)",fontSize:"9px",fontWeight:"700",
        letterSpacing:".03em",transition:"border-color .15s,color .15s",flexShrink:"0",
      });
      tx(errMinChip,"⚠ Error");

      // ── Get Inspired overlay ──────────────────────────────────────────────
      // Per-pill prompt suggestions
      // INSPIRE_BY_PILL is loaded from config.json on first Discover open.
      // This object serves as the default — written to config.json if discover_prompts is empty.
      let INSPIRE_BY_PILL={
        t2i:{
          categories:[],
        },

        i2i:{categories:[{cat:"I2I",items:[]}]},
      };

      // ── Get Inspired overlay — inside root (position:absolute like _promptOverlay) ──
      const _inspireOverlay=mk("div",{
        position:"absolute",inset:"0",zIndex:"260",background:C.bg0,
        display:"none",flexDirection:"column",
        padding:"12px",boxSizing:"border-box",gap:"0",
        opacity:"0",transition:"opacity 0.15s ease",overflow:"hidden",
      });
      // Manage mode gradient flash layer — sits behind content, above bg0
      const _inspireManageFlash=mk("div",{
        position:"absolute",inset:"0",zIndex:"0",pointerEvents:"none",
        background:"transparent",transition:"background .4s ease",
      });
      _inspireOverlay.appendChild(_inspireManageFlash);

      const _closeInspire=()=>{
        _inspireOverlay.style.opacity="0";
        setTimeout(()=>_inspireOverlay.style.display="none",160);
      };

      // Header (static)
      const _inspireHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:"10px",flexShrink:"0"});
      const _inspireTitleEl=mk("div",{fontSize:"10px",fontWeight:"700",color:C.muted,
        letterSpacing:".07em",textTransform:"uppercase"});
      tx(_inspireTitleEl,"✦ Discover");
      let _inspireShowFull=false;
      let _t2iTemplates=[]; // persistent across _buildInspireBody rebuilds
      let _t2iTemplatesLoaded=false;
      const _inspireShowFullBtn=mk("button",{
        background:"rgba(83,52,131,.15)",border:"1px solid rgba(83,52,131,.4)",borderRadius:"5px",
        padding:"3px 8px",fontSize:"8px",fontWeight:"700",letterSpacing:".05em",textTransform:"uppercase",
        cursor:"pointer",outline:"none",color:"rgba(180,160,220,.7)",transition:"all .15s",marginRight:"6px",flexShrink:"0",
      });
      tx(_inspireShowFullBtn,"Edit mode (E)");
      _inspireShowFullBtn.style.display="none";
      const _inspireShowFullUpdate=()=>{
        tx(_inspireShowFullBtn,_inspireShowFull?"Exit edit mode":"Edit mode (E)");
        _inspireShowFullBtn.style.background=_inspireShowFull?"rgba(180,140,255,.15)":"rgba(83,52,131,.15)";
        _inspireShowFullBtn.style.borderColor=_inspireShowFull?"rgba(220,180,255,.8)":"rgba(83,52,131,.4)";
        _inspireShowFullBtn.style.color=_inspireShowFull?"#f0e8ff":"rgba(180,160,220,.7)";
      };
      _inspireShowFullBtn.onmouseenter=()=>{
        _inspireShowFullBtn.style.background="linear-gradient(90deg,rgba(26,26,46,.8),rgba(15,52,96,.6),rgba(83,52,131,.6))";
        _inspireShowFullBtn.style.borderColor="rgba(180,140,255,.8)";
        _inspireShowFullBtn.style.color="#e0e0ff";
      };
      _inspireShowFullBtn.onmouseleave=()=>_inspireShowFullUpdate();
      _inspireShowFullBtn.onclick=async()=>{
        _inspireShowFull=!_inspireShowFull; _inspireShowFullUpdate();
        await _loadDiscoverPrompts(); _buildInspireBody();
        if(_inspireShowFull){
          _inspireManageFlash.style.transition="none";
          _inspireManageFlash.style.background="linear-gradient(135deg,rgba(26,20,60,.9) 0%,rgba(15,52,96,.7) 50%,rgba(83,52,131,.8) 100%)";
          void _inspireManageFlash.offsetWidth;
          _inspireManageFlash.style.transition="background .6s ease";
          _inspireManageFlash.style.background="linear-gradient(135deg,rgba(26,20,60,.45) 0%,rgba(15,52,96,.25) 50%,rgba(83,52,131,.35) 100%)";
        } else {
          _inspireManageFlash.style.transition="background .3s ease";
          _inspireManageFlash.style.background="transparent";
        }
      };
      const _inspireCloseBtn=mk("button",{background:"none",border:"none",cursor:"pointer",
        color:C.muted,fontSize:"14px",lineHeight:"1",padding:"2px 4px",outline:"none",
        display:"flex",alignItems:"center",borderRadius:"4px",transition:"color .15s"});
      tx(_inspireCloseBtn,"×");
      _inspireCloseBtn.onmouseenter=()=>_inspireCloseBtn.style.color="#fff";
      _inspireCloseBtn.onmouseleave=()=>_inspireCloseBtn.style.color=C.muted;
      _inspireCloseBtn.onclick=_closeInspire;
      const _inspireHdrRight=mk("div",{display:"flex",alignItems:"center"});
      _inspireHdrRight.append(_inspireShowFullBtn,_inspireCloseBtn);
      _inspireHdr.append(_inspireTitleEl,_inspireHdrRight);

      // Dynamic content area — rebuilt each time overlay opens
      const _inspireBody=mk("div",{display:"flex",flexDirection:"column",flex:"1",minHeight:"0",gap:"0"});

      const _usePrompt=(p)=>{
        S.prompt=p;
        if(_promptTARef) _promptTARef.value=p;
        if(typeof _promptOvTA!=="undefined") _promptOvTA.value=p;
        persist();_closeInspire();
      };

      const _buildInspireBody=()=>{
        _inspireBody.innerHTML="";
        const def=INSPIRE_BY_PILL[activePill]||INSPIRE_BY_PILL.t2i;

        // ── Categories mode (new format) ────────────────────────────────────
        if(def.categories){
          const hasShortLabels=def.categories.some(({items})=>items.some(it=>typeof it==="object"&&it.label!==it.prompt));
          // T2I: show toggle for templates (name ≠ prompt). EDIT also has short labels.
          _inspireShowFullBtn.style.display=(hasShortLabels||activePill==="t2i"||activePill==="i2i")?"":"none";
          const scroll=mk("div",{
            flex:"1",overflowY:"auto",display:"flex",flexDirection:"column",gap:"12px",
            scrollbarWidth:"thin",scrollbarColor:`${C.border} transparent`,
          });
          scroll.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});

          // ── T2I Templates ────────────────────────────────────────────────
          if(activePill==="t2i"){
            // Use persistent vars so rebuilds don't lose state
            const _templates=_t2iTemplates;
            let _editIdx=-1;
            let _tmplPillsRow=null;

            const _saveTmpl=async()=>{
              try{ await api.fetchApi("/z_image/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t2i_templates:_templates})}); }
              catch(e){ console.warn("[ZImageOneNode] save templates:",e); }
            };

            // Form (create/edit) — framed, compact
            const tmplForm=mk("div",{
              display:"none",flexDirection:"column",gap:"6px",marginBottom:"6px",
              border:`1px solid rgba(240,255,65,.3)`,borderRadius:"16px",
              padding:"10px 12px",background:"rgba(240,255,65,.04)",boxSizing:"border-box",
            });
            const tmplFormTitle=mk("div",{fontSize:"8px",fontWeight:"700",color:LIME,letterSpacing:".08em",textTransform:"uppercase",marginBottom:"2px"});
            tx(tmplFormTitle,"New Template");
            const tmplNameInp=mk("input",{
              background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"999px",
              color:C.text,fontSize:"10px",padding:"6px 14px",outline:"none",
              transition:"border-color .15s",width:"100%",boxSizing:"border-box",
            },{placeholder:"Title…"});
            tmplNameInp.onfocus=()=>tmplNameInp.style.borderColor=LIME;
            tmplNameInp.onblur=()=>tmplNameInp.style.borderColor=C.border;
            const tmplPromptTA=mk("textarea",{
              background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"16px",
              color:C.text,fontSize:"10px",padding:"8px 14px",outline:"none",lineHeight:"1.5",
              resize:"vertical",minHeight:"60px",fontFamily:"inherit",
              transition:"border-color .15s",width:"100%",boxSizing:"border-box",
            },{placeholder:"Prompt…"});
            tmplPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
            tmplPromptTA.onfocus=()=>tmplPromptTA.style.borderColor=LIME;
            tmplPromptTA.onblur=()=>tmplPromptTA.style.borderColor=C.border;
            const tmplFormBtns=mk("div",{display:"flex",gap:"6px",justifyContent:"flex-end"});
            const tmplCancelBtn=mk("button",{
              background:"transparent",border:`1px solid ${C.borderH}`,borderRadius:"999px",
              padding:"5px 16px",fontSize:"9px",fontWeight:"700",color:C.muted,
              cursor:"pointer",outline:"none",transition:"border-color .15s,color .15s",
            });
            tx(tmplCancelBtn,"Cancel");
            tmplCancelBtn.onmouseenter=()=>{tmplCancelBtn.style.borderColor=C.text;tmplCancelBtn.style.color=C.text;};
            tmplCancelBtn.onmouseleave=()=>{tmplCancelBtn.style.borderColor=C.borderH;tmplCancelBtn.style.color=C.muted;};
            const tmplSaveBtn=mk("button",{
              background:LIME,color:"#111",border:"none",borderRadius:"999px",
              padding:"5px 16px",fontSize:"9px",fontWeight:"700",cursor:"pointer",outline:"none",
              transition:"opacity .15s",
            });
            tx(tmplSaveBtn,"Save");
            tmplSaveBtn.onmouseenter=()=>tmplSaveBtn.style.opacity=".85";
            tmplSaveBtn.onmouseleave=()=>tmplSaveBtn.style.opacity="1";
            tmplFormBtns.append(tmplCancelBtn,tmplSaveBtn);
            tmplFormBtns.style.justifyContent="flex-end";
            tmplForm.append(tmplFormTitle,tmplNameInp,tmplPromptTA,tmplFormBtns);

            // Header: "MY TEMPLATES" only
            const tmplHdr=mk("div",{display:"flex",alignItems:"center",marginBottom:"5px"});
            const tmplHdrLbl=mk("div",{fontSize:"9px",fontWeight:"700",letterSpacing:".1em",textTransform:"uppercase",color:C.muted});
            tx(tmplHdrLbl,"My Templates");
            tmplHdr.append(tmplHdrLbl);

            // Pills container + details area (same pattern as categories)
            _tmplPillsRow=mk("div",{display:"flex",flexWrap:"wrap",gap:"6px",minHeight:"16px"});
            const _tmplDetailsArea=mk("div",{display:"flex",flexDirection:"column",gap:"4px",marginTop:"2px"});
            let _tmplOpenIdx=-1;

            const _renderTmplPills=()=>{
              _tmplPillsRow.innerHTML=""; _tmplDetailsArea.innerHTML=""; _tmplOpenIdx=-1;
              _templates.forEach((t,idx)=>{
                // Pill
                const pill=mk("button",{padding:"7px 14px",borderRadius:"999px",cursor:"pointer",fontSize:"10px",fontWeight:"500",lineHeight:"1.5",border:`1px solid ${C.border}`,background:C.bg1,color:C.text,outline:"none",transition:"background .12s,border-color .12s,color .12s"});
                tx(pill,t.name);
                pill.onmouseenter=()=>{ if(_tmplOpenIdx!==idx){pill.style.background="rgba(240,255,65,.10)";pill.style.borderColor=LIME;pill.style.color=LIME;} };
                pill.onmouseleave=()=>{ if(_tmplOpenIdx!==idx){pill.style.background=C.bg1;pill.style.borderColor=C.border;pill.style.color=C.text;} };

                // Detail panel
                const detail=mk("div",{display:"none",flexDirection:"column",gap:"6px",border:`1px solid rgba(180,140,255,.4)`,borderRadius:"12px",padding:"10px 14px",background:"rgba(26,20,60,.55)",boxSizing:"border-box"});
                const detailTop=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
                const detailLbl=mk("span",{fontSize:"9px",fontWeight:"700",color:"rgba(255,255,255,.85)",flex:"1"});tx(detailLbl,t.name);
                // Copy
                const dCopyBtn=mk("button",{background:"transparent",border:`1px solid rgba(100,220,120,.4)`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(100,220,120,.8)",cursor:"pointer",outline:"none",transition:"all .15s",flexShrink:"0"});
                tx(dCopyBtn,"Copy");
                dCopyBtn.onmouseenter=()=>{dCopyBtn.style.background="rgba(100,220,120,.12)";dCopyBtn.style.borderColor="rgba(100,220,120,.8)";};
                dCopyBtn.onmouseleave=()=>{dCopyBtn.style.background="transparent";dCopyBtn.style.borderColor="rgba(100,220,120,.4)";};
                dCopyBtn.onclick=(e)=>{ e.stopPropagation(); navigator.clipboard.writeText(t.prompt).then(()=>{ tx(dCopyBtn,"✓ Copied"); setTimeout(()=>tx(dCopyBtn,"Copy"),1500); }).catch(()=>{}); };
                // Edit
                const dEditBtn=mk("button",{background:"transparent",border:`1px solid rgba(160,140,220,.4)`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(160,140,220,.8)",cursor:"pointer",outline:"none",transition:"all .15s",flexShrink:"0"});
                tx(dEditBtn,"Edit");
                dEditBtn.onmouseenter=()=>{dEditBtn.style.background="rgba(160,140,220,.1)";dEditBtn.style.borderColor="rgba(160,140,220,.8)";dEditBtn.style.color="#e0d0ff";};
                dEditBtn.onmouseleave=()=>{dEditBtn.style.background="transparent";dEditBtn.style.borderColor="rgba(160,140,220,.4)";dEditBtn.style.color="rgba(160,140,220,.8)";};
                // Delete
                const dDelWrap=mk("div",{position:"relative",display:"inline-flex",flexShrink:"0"});
                const dDelBtn=mk("button",{background:"transparent",border:"1px solid rgba(220,80,80,.4)",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(220,80,80,.8)",cursor:"pointer",outline:"none",transition:"all .15s"});
                tx(dDelBtn,"Delete");
                dDelBtn.onmouseenter=()=>{dDelBtn.style.background="rgba(220,80,80,.1)";dDelBtn.style.borderColor="rgba(220,80,80,.8)";};
                dDelBtn.onmouseleave=()=>{dDelBtn.style.background="transparent";dDelBtn.style.borderColor="rgba(220,80,80,.4)";};
                const dDelPop=mk("div",{display:"none",position:"absolute",right:"0",top:"calc(100% + 4px)",background:C.bg1,border:`1px solid ${C.borderH}`,borderRadius:"7px",padding:"6px 8px",zIndex:"10",whiteSpace:"nowrap",boxShadow:"0 4px 12px rgba(0,0,0,.5)",flexDirection:"column",gap:"5px",alignItems:"center"});
                const dDelQ=mk("div",{fontSize:"9px",color:C.text,fontWeight:"600"});tx(dDelQ,"Sure?");
                const dDelBtns=mk("div",{display:"flex",gap:"4px"});
                const dDelYes=mk("button",{background:"rgba(160,25,25,.7)",border:"1px solid rgba(255,80,80,.3)",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(255,180,180,.9)",cursor:"pointer",outline:"none"});tx(dDelYes,"Yes");
                const dDelNo=mk("button",{background:C.bg3,border:`1px solid ${C.borderH}`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:C.muted,cursor:"pointer",outline:"none"});tx(dDelNo,"Keep");
                dDelBtns.append(dDelYes,dDelNo); dDelPop.append(dDelQ,dDelBtns); dDelWrap.append(dDelBtn,dDelPop);
                dDelBtn.onclick=(e)=>{ e.stopPropagation(); dDelPop.style.display=dDelPop.style.display==="flex"?"none":"flex"; };
                dDelYes.onclick=async(e)=>{ e.stopPropagation(); dDelPop.style.display="none"; _templates.splice(idx,1); await _saveTmpl(); _renderTmplPills(); };
                dDelNo.onclick=(e)=>{ e.stopPropagation(); dDelPop.style.display="none"; };
                const dUseBtn=mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",cursor:"pointer",outline:"none",transition:"opacity .15s",flexShrink:"0"});
                tx(dUseBtn,"Use"); dUseBtn.onmouseenter=()=>dUseBtn.style.opacity=".85"; dUseBtn.onmouseleave=()=>dUseBtn.style.opacity="1";
                dUseBtn.onclick=(e)=>{ e.stopPropagation(); _usePrompt(t.prompt); };
                detailTop.append(detailLbl,dUseBtn,dCopyBtn,dEditBtn,dDelWrap);
                const detailPromptTxt=mk("div",{fontSize:"9px",color:"rgba(200,185,230,.7)",lineHeight:"1.55",fontStyle:"italic"});tx(detailPromptTxt,t.prompt);
                // Inline edit form
                const dEditForm=mk("div",{display:"none",flexDirection:"column",gap:"6px",borderTop:`1px solid rgba(180,140,255,.2)`,paddingTop:"8px"});
                const dETitleInp=mk("input",{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"999px",color:C.text,fontSize:"10px",padding:"6px 14px",outline:"none",transition:"border-color .15s",width:"100%",boxSizing:"border-box"},{placeholder:"Title…"});
                dETitleInp.onfocus=()=>dETitleInp.style.borderColor=LIME; dETitleInp.onblur=()=>dETitleInp.style.borderColor=C.border;
                const dEPromptTA=mk("textarea",{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"16px",color:C.text,fontSize:"10px",padding:"8px 14px",outline:"none",lineHeight:"1.5",resize:"vertical",minHeight:"60px",fontFamily:"inherit",transition:"border-color .15s",width:"100%",boxSizing:"border-box"},{placeholder:"Prompt…"});
                dEPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
                dEPromptTA.onfocus=()=>dEPromptTA.style.borderColor=LIME; dEPromptTA.onblur=()=>dEPromptTA.style.borderColor=C.border;
                const dECancelBtn=mk("button",{background:"transparent",border:`1px solid ${C.borderH}`,borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",color:C.muted,cursor:"pointer",outline:"none",transition:"all .15s"});
                tx(dECancelBtn,"Cancel"); dECancelBtn.onmouseenter=()=>{dECancelBtn.style.borderColor=C.text;dECancelBtn.style.color=C.text;}; dECancelBtn.onmouseleave=()=>{dECancelBtn.style.borderColor=C.borderH;dECancelBtn.style.color=C.muted;};
                const dEUpdateBtn=mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",cursor:"pointer",outline:"none",transition:"opacity .15s"});
                tx(dEUpdateBtn,"Update"); dEUpdateBtn.onmouseenter=()=>dEUpdateBtn.style.opacity=".85"; dEUpdateBtn.onmouseleave=()=>dEUpdateBtn.style.opacity="1";
                const dEBtmRow=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
                dEBtmRow.append(mk("div",{flex:"1"}),dECancelBtn,dEUpdateBtn);
                dEditForm.append(dETitleInp,dEPromptTA,dEBtmRow);
                const _tmplSetEditMode=(on)=>{ dUseBtn.style.display=on?"none":""; dCopyBtn.style.display=on?"none":""; dEditBtn.style.display=on?"none":""; dDelWrap.style.display=on?"none":"inline-flex"; };
                dEditBtn.onclick=(e)=>{ e.stopPropagation(); const opening=dEditForm.style.display!=="flex"; dETitleInp.value=t.name; dEPromptTA.value=t.prompt; dEditForm.style.display=opening?"flex":"none"; _tmplSetEditMode(opening); if(opening) setTimeout(()=>dETitleInp.focus(),30); };
                dECancelBtn.onclick=()=>{ dEditForm.style.display="none"; _tmplSetEditMode(false); };
                dEUpdateBtn.onclick=async()=>{ const n=dETitleInp.value.trim(),p=dEPromptTA.value.trim(); if(!n||!p) return; _templates[idx]={name:n,prompt:p}; await _saveTmpl(); _renderTmplPills(); _tmplOpenIdx=idx; const det=_tmplDetailsArea.children[idx]; if(det){det.style.display="flex";det.dataset.open="1";} const pil=_tmplPillsRow.querySelectorAll("button:not([data-addpill])")[idx]; if(pil){pil.style.background="rgba(180,140,255,.15)";pil.style.borderColor="rgba(180,140,255,.6)";pil.style.color="#e0d0ff";} };
                detail.append(detailTop,detailPromptTxt,dEditForm);
                _tmplDetailsArea.appendChild(detail);

                const _closeTmplDetail=()=>{ detail.style.display="none"; _tmplOpenIdx=-1; pill.style.background=C.bg1;pill.style.borderColor=C.border;pill.style.color=C.text; };
                pill.onclick=()=>{
                  if(!_inspireShowFull){ _usePrompt(t.prompt); return; }
                  if(_tmplOpenIdx===idx){ _closeTmplDetail(); return; }
                  _tmplDetailsArea.querySelectorAll("div[data-open]").forEach(d=>{d.style.display="none";delete d.dataset.open;});
                  _tmplPillsRow.querySelectorAll("button").forEach(p2=>{p2.style.background=C.bg1;p2.style.borderColor=C.border;p2.style.color=C.text;});
                  _tmplOpenIdx=idx; detail.style.display="flex"; detail.dataset.open="1";
                  pill.style.background="rgba(180,140,255,.15)";pill.style.borderColor="rgba(180,140,255,.6)";pill.style.color="#e0d0ff";
                };
                _tmplPillsRow.appendChild(pill);
              });
              // "+ Add" pill always at the end
              const tmplAddPill=mk("button",{
                padding:"5px 12px",borderRadius:"999px",cursor:"pointer",
                fontSize:"10px",fontWeight:"600",lineHeight:"1.5",
                border:`1px dashed rgba(240,255,65,.4)`,
                background:"rgba(240,255,65,.05)",color:"rgba(240,255,65,.6)",
                outline:"none",transition:"all .15s",flexShrink:"0",
              });
              tx(tmplAddPill,"+ Add"); tmplAddPill.dataset.addpill="1";
              tmplAddPill.onmouseenter=()=>{ tmplAddPill.style.borderColor=LIME;tmplAddPill.style.background="rgba(240,255,65,.12)";tmplAddPill.style.color=LIME; };
              tmplAddPill.onmouseleave=()=>{ tmplAddPill.style.borderColor="rgba(240,255,65,.4)";tmplAddPill.style.background="rgba(240,255,65,.05)";tmplAddPill.style.color="rgba(240,255,65,.6)"; };
              tmplAddPill.onclick=()=>{
                _editIdx=-1; tmplNameInp.value=""; tmplPromptTA.value=S.prompt||"";
                tx(tmplFormTitle,"New Template"); tx(tmplSaveBtn,"Save");
                tmplForm.style.display=tmplForm.style.display==="flex"?"none":"flex";
                if(tmplForm.style.display==="flex") setTimeout(()=>tmplNameInp.focus(),30);
              };
              _tmplPillsRow.appendChild(tmplAddPill);
            };


            tmplCancelBtn.onclick=()=>{ tmplForm.style.display="none"; };
            tmplSaveBtn.onclick=async()=>{
              const name=tmplNameInp.value.trim(), prompt=tmplPromptTA.value.trim();
              if(!name||!prompt) return;
              if(_editIdx>=0) _templates[_editIdx]={name,prompt};
              else _templates.push({name,prompt});
              await _saveTmpl();
              tmplForm.style.display="none";
              _editIdx=-1; _renderTmplPills();
            };

            // Load & render — only fetch from server once
            if(!_t2iTemplatesLoaded){
              _t2iTemplatesLoaded=true;
              (async()=>{
                try{ const r=await api.fetchApi("/z_image/config"); const d=await r.json(); _t2iTemplates.length=0; (d.t2i_templates||[]).forEach(t=>_t2iTemplates.push(t)); }
                catch(e){}
                _renderTmplPills();
              })();
            } else {
              _renderTmplPills();
            }

            const tmplSection=mk("div",{});
            tmplSection.append(tmplHdr,tmplForm,_tmplPillsRow,_tmplDetailsArea);
            scroll.appendChild(tmplSection);
          }

          let _hasDual=false;
          def.categories.forEach(({cat,items})=>{
            // Category label — if cat contains "(note)", render note part smaller without uppercase
            const catLbl=mk("div",{
              display:"flex",alignItems:"baseline",gap:"5px",flexWrap:"wrap",
              marginBottom:"5px",
            });
            const parenIdx=cat.indexOf("(");
            if(parenIdx>0){
              const mainPart=mk("span",{fontSize:"9px",fontWeight:"700",letterSpacing:".1em",textTransform:"uppercase",color:C.muted});
              tx(mainPart,cat.slice(0,parenIdx).trim());
              const notePart=mk("span",{fontSize:"8px",fontWeight:"400",color:C.muted,opacity:".7",textTransform:"none",letterSpacing:".01em"});
              tx(notePart,cat.slice(parenIdx));
              catLbl.append(mainPart,notePart);
            } else {
              catLbl.style.fontSize="9px";catLbl.style.fontWeight="700";
              catLbl.style.letterSpacing=".1em";catLbl.style.textTransform="uppercase";
              catLbl.style.color=C.muted;
              tx(catLbl,cat);
            }
            // Pills always render as pills; in preview mode click shows inline detail instead of inserting
            const pillsRow=mk("div",{display:"flex",flexWrap:"wrap",gap:"6px"});
            // Container for detail panels (below pills row)
            const detailsArea=mk("div",{display:"flex",flexDirection:"column",gap:"4px",marginTop:"2px"});
            let _openDetailIdx=-1; // which pill's detail is currently open

            items.forEach(({label,prompt,dual},itemIdx)=>{
              if(dual) _hasDual=true;
              const pill=mk("button",{
                padding:dual?"5px 10px 5px 8px":"7px 14px",
                borderRadius:"999px",cursor:"pointer",
                fontSize:"10px",fontWeight:"500",lineHeight:"1.5",
                border:`1px solid ${dual?"rgba(100,160,255,.35)":C.border}`,
                background:dual?"rgba(80,120,220,.08)":C.bg1,
                color:dual?"rgba(140,190,255,.9)":C.text,
                outline:"none",textAlign:"left",
                display:"flex",alignItems:"center",gap:"6px",
                transition:"background .12s,border-color .12s,color .12s",
              });
              if(dual){
                const badge=mk("span",{fontSize:"7px",fontWeight:"800",letterSpacing:".06em",background:"rgba(100,160,255,.2)",color:"rgba(140,190,255,.8)",border:"1px solid rgba(100,160,255,.3)",borderRadius:"4px",padding:"1px 4px",flexShrink:"0",lineHeight:"1.6"});
                tx(badge,"2 imgs"); const lbl=mk("span");tx(lbl,label); pill.append(badge,lbl);
                pill.onmouseenter=()=>{ pill.style.background="rgba(80,140,255,.18)";pill.style.borderColor="rgba(100,160,255,.7)";pill.style.color="#9bbfff"; };
                pill.onmouseleave=()=>{ if(_openDetailIdx!==itemIdx){pill.style.background="rgba(80,120,220,.08)";pill.style.borderColor="rgba(100,160,255,.35)";pill.style.color="rgba(140,190,255,.9)";} };
              } else {
                tx(pill,label);
                pill.onmouseenter=()=>{ if(_openDetailIdx!==itemIdx){pill.style.background="rgba(240,255,65,.10)";pill.style.borderColor=LIME;pill.style.color=LIME;} };
                pill.onmouseleave=()=>{ if(_openDetailIdx!==itemIdx){pill.style.background=C.bg1;pill.style.borderColor=C.border;pill.style.color=C.text;} };
              }

              // Detail panel (shown in preview mode)
              const detail=mk("div",{
                display:"none",flexDirection:"column",gap:"6px",
                border:`1px solid rgba(180,140,255,.4)`,borderRadius:"12px",
                padding:"10px 14px",background:"rgba(26,20,60,.55)",boxSizing:"border-box",
              });
              const detailTop=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
              const detailLbl=mk("span",{fontSize:"9px",fontWeight:"700",color:"rgba(255,255,255,.85)",flex:"1"});
              tx(detailLbl,label);
              // Copy button
              const detailCopyBtn=mk("button",{background:"transparent",border:`1px solid rgba(100,220,120,.4)`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(100,220,120,.8)",cursor:"pointer",outline:"none",transition:"all .15s",flexShrink:"0"});
              tx(detailCopyBtn,"Copy");
              detailCopyBtn.onmouseenter=()=>{detailCopyBtn.style.background="rgba(100,220,120,.12)";detailCopyBtn.style.borderColor="rgba(100,220,120,.8)";};
              detailCopyBtn.onmouseleave=()=>{detailCopyBtn.style.background="transparent";detailCopyBtn.style.borderColor="rgba(100,220,120,.4)";};
              detailCopyBtn.onclick=(e)=>{ e.stopPropagation(); navigator.clipboard.writeText(prompt).then(()=>{ tx(detailCopyBtn,"✓ Copied"); setTimeout(()=>tx(detailCopyBtn,"Copy"),1500); }).catch(()=>{}); };
              // Edit button
              const detailEditBtn=mk("button",{background:"transparent",border:`1px solid rgba(160,140,220,.4)`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(160,140,220,.8)",cursor:"pointer",outline:"none",transition:"all .15s",flexShrink:"0"});
              tx(detailEditBtn,"Edit");
              detailEditBtn.onmouseenter=()=>{detailEditBtn.style.background="rgba(160,140,220,.1)";detailEditBtn.style.borderColor="rgba(160,140,220,.8)";detailEditBtn.style.color="#e0d0ff";};
              detailEditBtn.onmouseleave=()=>{detailEditBtn.style.background="transparent";detailEditBtn.style.borderColor="rgba(160,140,220,.4)";detailEditBtn.style.color="rgba(160,140,220,.8)";};
              // Delete button with confirm popover
              const detailDelWrap=mk("div",{position:"relative",display:"inline-flex",flexShrink:"0"});
              const detailDelBtn=mk("button",{background:"transparent",border:"1px solid rgba(220,80,80,.4)",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(220,80,80,.8)",cursor:"pointer",outline:"none",transition:"all .15s"});
              tx(detailDelBtn,"Delete");
              detailDelBtn.onmouseenter=()=>{detailDelBtn.style.background="rgba(220,80,80,.1)";detailDelBtn.style.borderColor="rgba(220,80,80,.8)";};
              detailDelBtn.onmouseleave=()=>{detailDelBtn.style.background="transparent";detailDelBtn.style.borderColor="rgba(220,80,80,.4)";};
              const detailDelPop=mk("div",{display:"none",position:"absolute",right:"0",top:"calc(100% + 4px)",background:C.bg1,border:`1px solid ${C.borderH}`,borderRadius:"7px",padding:"6px 8px",zIndex:"10",whiteSpace:"nowrap",boxShadow:"0 4px 12px rgba(0,0,0,.5)",flexDirection:"column",gap:"5px",alignItems:"center"});
              const detailDelQ=mk("div",{fontSize:"9px",color:C.text,fontWeight:"600"});tx(detailDelQ,"Sure?");
              const detailDelBtns=mk("div",{display:"flex",gap:"4px"});
              const detailDelYes=mk("button",{background:"rgba(160,25,25,.7)",border:"1px solid rgba(255,80,80,.3)",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:"rgba(255,180,180,.9)",cursor:"pointer",outline:"none"});tx(detailDelYes,"Yes");
              const detailDelNo=mk("button",{background:C.bg3,border:`1px solid ${C.borderH}`,borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",color:C.muted,cursor:"pointer",outline:"none"});tx(detailDelNo,"Keep");
              detailDelBtns.append(detailDelYes,detailDelNo); detailDelPop.append(detailDelQ,detailDelBtns); detailDelWrap.append(detailDelBtn,detailDelPop);
              detailDelBtn.onclick=(e)=>{ e.stopPropagation(); detailDelPop.style.display=detailDelPop.style.display==="flex"?"none":"flex"; };
              detailDelYes.onclick=async(e)=>{ e.stopPropagation(); detailDelPop.style.display="none"; items.splice(itemIdx,1); await _saveDiscoverPrompts(); _inspirePromptsLoaded=false; _buildInspireBody(); };
              detailDelNo.onclick=(e)=>{ e.stopPropagation(); detailDelPop.style.display="none"; };
              const detailUseBtn=mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"999px",padding:"2px 10px",fontSize:"8px",fontWeight:"700",cursor:"pointer",outline:"none",transition:"opacity .15s",flexShrink:"0"});
              tx(detailUseBtn,"Use"); detailUseBtn.onmouseenter=()=>detailUseBtn.style.opacity=".85"; detailUseBtn.onmouseleave=()=>detailUseBtn.style.opacity="1";
              detailUseBtn.onclick=(e)=>{ e.stopPropagation(); _usePrompt(prompt); };
              detailTop.append(detailLbl,detailUseBtn,detailCopyBtn,detailEditBtn,detailDelWrap);
              const detailPromptTxt=mk("div",{fontSize:"9px",color:"rgba(200,185,230,.7)",lineHeight:"1.55",fontStyle:"italic"});
              tx(detailPromptTxt,prompt);
              // Edit form inside detail
              const editForm=mk("div",{display:"none",flexDirection:"column",gap:"6px",borderTop:`1px solid rgba(180,140,255,.2)`,paddingTop:"8px"});
              const editTitleInp=mk("input",{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"999px",color:C.text,fontSize:"10px",padding:"6px 14px",outline:"none",transition:"border-color .15s",width:"100%",boxSizing:"border-box"},{placeholder:"Title…"});
              editTitleInp.onfocus=()=>editTitleInp.style.borderColor=LIME; editTitleInp.onblur=()=>editTitleInp.style.borderColor=C.border;
              const editPromptTA=mk("textarea",{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"16px",color:C.text,fontSize:"10px",padding:"8px 14px",outline:"none",lineHeight:"1.5",resize:"vertical",minHeight:"60px",fontFamily:"inherit",transition:"border-color .15s",width:"100%",boxSizing:"border-box"},{placeholder:"Prompt…"});
              editPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
              editPromptTA.onfocus=()=>editPromptTA.style.borderColor=LIME; editPromptTA.onblur=()=>editPromptTA.style.borderColor=C.border;
              const editBtns=mk("div",{display:"flex",gap:"6px",justifyContent:"flex-end"});
              const editCancelBtn=mk("button",{background:"transparent",border:`1px solid ${C.borderH}`,borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",color:C.muted,cursor:"pointer",outline:"none",transition:"all .15s"});
              tx(editCancelBtn,"Cancel"); editCancelBtn.onmouseenter=()=>{editCancelBtn.style.borderColor=C.text;editCancelBtn.style.color=C.text;}; editCancelBtn.onmouseleave=()=>{editCancelBtn.style.borderColor=C.borderH;editCancelBtn.style.color=C.muted;};
              const editUpdateBtn=mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",cursor:"pointer",outline:"none",transition:"opacity .15s"});
              tx(editUpdateBtn,"Update"); editUpdateBtn.onmouseenter=()=>editUpdateBtn.style.opacity=".85"; editUpdateBtn.onmouseleave=()=>editUpdateBtn.style.opacity="1";
              let _editDualVal=false;
              const editDualChk={get checked(){return _editDualVal;},set checked(v){_editDualVal=v;_editDualRefresh();}};
              const editDualToggle=mk("button",{background:"transparent",border:`1px solid rgba(160,140,220,.35)`,borderRadius:"999px",padding:"3px 10px",fontSize:"8px",fontWeight:"600",color:"rgba(160,140,220,.6)",cursor:"pointer",outline:"none",transition:"all .15s",textAlign:"left"});
              tx(editDualToggle,"Requires 2 images");
              const _editDualRefresh=()=>{
                if(_editDualVal){editDualToggle.style.background="rgba(100,160,255,.15)";editDualToggle.style.borderColor="rgba(100,160,255,.7)";editDualToggle.style.color="#9bbfff";}
                else{editDualToggle.style.background="transparent";editDualToggle.style.borderColor="rgba(160,140,220,.35)";editDualToggle.style.color="rgba(160,140,220,.6)";}
              };
              editDualToggle.onclick=(e)=>{e.stopPropagation();_editDualVal=!_editDualVal;_editDualRefresh();};
              editBtns.append(editCancelBtn,editUpdateBtn);
              const editBottomRow=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
              if(activePill==="i2i") editDualToggle.style.display="none";
              editBottomRow.append(editDualToggle,mk("div",{flex:"1"}),editBtns);
              editForm.append(editTitleInp,editPromptTA,editBottomRow);
              const _setDetailEditMode=(on)=>{ detailUseBtn.style.display=on?"none":""; detailCopyBtn.style.display=on?"none":""; detailEditBtn.style.display=on?"none":""; detailDelWrap.style.display=on?"none":"inline-flex"; };
              detailEditBtn.onclick=(e)=>{ e.stopPropagation(); const opening=editForm.style.display!=="flex"; editTitleInp.value=label; editPromptTA.value=prompt; editDualChk.checked=!!dual; editForm.style.display=opening?"flex":"none"; _setDetailEditMode(opening); if(opening) setTimeout(()=>editTitleInp.focus(),30); };
              editCancelBtn.onclick=()=>{ editForm.style.display="none"; _setDetailEditMode(false); };
              editUpdateBtn.onclick=async()=>{
                const t=editTitleInp.value.trim(),p=editPromptTA.value.trim(); if(!t||!p) return;
                const entry={label:t,prompt:p}; if(editDualChk.checked) entry.dual=true;
                items[itemIdx]=entry; await _saveDiscoverPrompts(); _inspirePromptsLoaded=false; _buildInspireBody();
              };
              detail.append(detailTop,detailPromptTxt,editForm);
              detailsArea.appendChild(detail);

              const _closeDetail=()=>{
                detail.style.display="none"; _openDetailIdx=-1;
                pill.style.background=dual?"rgba(80,120,220,.08)":C.bg1;
                pill.style.borderColor=dual?"rgba(100,160,255,.35)":C.border;
                pill.style.color=dual?"rgba(140,190,255,.9)":C.text;
              };
              pill.onclick=()=>{
                if(!_inspireShowFull){ _usePrompt(prompt); return; }
                if(_openDetailIdx===itemIdx){ _closeDetail(); return; }
                // Close previously open detail
                detailsArea.querySelectorAll("div[data-detail-open]").forEach(d=>{ d.style.display="none"; delete d.dataset.detailOpen; });
                // Reset all pills in this category
                pillsRow.querySelectorAll("button").forEach(p2=>{ p2.style.background=C.bg1;p2.style.borderColor=C.border;p2.style.color=C.text; });
                _openDetailIdx=itemIdx;
                detail.style.display="flex"; detail.dataset.detailOpen="1";
                pill.style.background="rgba(180,140,255,.15)"; pill.style.borderColor="rgba(180,140,255,.6)"; pill.style.color="#e0d0ff";
              };
              pillsRow.appendChild(pill);
            });
            // ── + Add pill at end of each category ──────────────────────
            const addPill=mk("button",{
              padding:"5px 12px",borderRadius:"999px",cursor:"pointer",
              fontSize:"10px",fontWeight:"600",lineHeight:"1.5",
              border:`1px dashed rgba(240,255,65,.4)`,
              background:"rgba(240,255,65,.05)",color:"rgba(240,255,65,.6)",
              outline:"none",transition:"all .15s",flexShrink:"0",
            });
            tx(addPill,"+ Add");
            addPill.onmouseenter=()=>{ addPill.style.borderColor=LIME;addPill.style.background="rgba(240,255,65,.12)";addPill.style.color=LIME; };
            addPill.onmouseleave=()=>{ addPill.style.borderColor="rgba(240,255,65,.4)";addPill.style.background="rgba(240,255,65,.05)";addPill.style.color="rgba(240,255,65,.6)"; };

            // Inline form (hidden, appears below pills row)
            const addForm=mk("div",{
              display:"none",flexDirection:"column",gap:"6px",marginTop:"4px",
              border:`1px solid rgba(240,255,65,.3)`,borderRadius:"16px",
              padding:"10px 12px",background:"rgba(240,255,65,.04)",boxSizing:"border-box",
            });
            const addFormTitle=mk("div",{fontSize:"8px",fontWeight:"700",color:LIME,letterSpacing:".08em",textTransform:"uppercase",marginBottom:"2px"});
            tx(addFormTitle,"Add to "+cat.split("(")[0].trim());
            const addTitleInp=mk("input",{
              background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"999px",
              color:C.text,fontSize:"10px",padding:"6px 14px",outline:"none",
              transition:"border-color .15s",width:"100%",boxSizing:"border-box",
            },{placeholder:"Title…"});
            addTitleInp.onfocus=()=>addTitleInp.style.borderColor=LIME;
            addTitleInp.onblur=()=>addTitleInp.style.borderColor=C.border;
            const addPromptTA=mk("textarea",{
              background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"16px",
              color:C.text,fontSize:"10px",padding:"8px 14px",outline:"none",lineHeight:"1.5",
              resize:"vertical",minHeight:"60px",fontFamily:"inherit",
              transition:"border-color .15s",width:"100%",boxSizing:"border-box",
            },{placeholder:"Prompt…"});
            addPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
            addPromptTA.onfocus=()=>addPromptTA.style.borderColor=LIME;
            addPromptTA.onblur=()=>addPromptTA.style.borderColor=C.border;
            const addFormBtns=mk("div",{display:"flex",gap:"6px",justifyContent:"flex-end"});
            const addCancelBtn=mk("button",{background:"transparent",border:`1px solid ${C.borderH}`,borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",color:C.muted,cursor:"pointer",outline:"none",transition:"all .15s"});
            tx(addCancelBtn,"Cancel");
            addCancelBtn.onmouseenter=()=>{addCancelBtn.style.borderColor=C.text;addCancelBtn.style.color=C.text;};
            addCancelBtn.onmouseleave=()=>{addCancelBtn.style.borderColor=C.borderH;addCancelBtn.style.color=C.muted;};
            const addSaveBtn=mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"999px",padding:"5px 16px",fontSize:"9px",fontWeight:"700",cursor:"pointer",outline:"none",transition:"opacity .15s"});
            tx(addSaveBtn,"Save");
            addSaveBtn.onmouseenter=()=>addSaveBtn.style.opacity=".85";
            addSaveBtn.onmouseleave=()=>addSaveBtn.style.opacity="1";
            // Dual checkbox
            let _addDualVal=false;
            const addDualChk={get checked(){return _addDualVal;},set checked(v){_addDualVal=v;_addDualRefresh();}};
            const addDualToggle=mk("button",{background:"transparent",border:`1px solid rgba(160,140,220,.35)`,borderRadius:"999px",padding:"3px 10px",fontSize:"8px",fontWeight:"600",color:"rgba(160,140,220,.6)",cursor:"pointer",outline:"none",transition:"all .15s"});
            tx(addDualToggle,"Requires 2 images");
            const _addDualRefresh=()=>{
              if(_addDualVal){addDualToggle.style.background="rgba(100,160,255,.15)";addDualToggle.style.borderColor="rgba(100,160,255,.7)";addDualToggle.style.color="#9bbfff";}
              else{addDualToggle.style.background="transparent";addDualToggle.style.borderColor="rgba(160,140,220,.35)";addDualToggle.style.color="rgba(160,140,220,.6)";}
            };
            addDualToggle.onclick=(e)=>{e.stopPropagation();_addDualVal=!_addDualVal;_addDualRefresh();};
            addFormBtns.append(addCancelBtn,addSaveBtn);
            const addBottomRow=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
            if(activePill==="i2i") addDualToggle.style.display="none";
            addBottomRow.append(addDualToggle,mk("div",{flex:"1"}),addFormBtns);
            addForm.append(addFormTitle,addTitleInp,addPromptTA,addBottomRow);

            addPill.onclick=()=>{
              addTitleInp.value=""; addPromptTA.value=""; _addDualVal=false; _addDualRefresh();
              addForm.style.display=addForm.style.display==="flex"?"none":"flex";
              if(addForm.style.display==="flex") setTimeout(()=>addTitleInp.focus(),30);
            };
            addCancelBtn.onclick=()=>{ addForm.style.display="none"; };
            addSaveBtn.onclick=async()=>{
              const title=addTitleInp.value.trim(), prompt=addPromptTA.value.trim();
              if(!title||!prompt) return;
              const entry={label:title,prompt};
              if(addDualChk.checked) entry.dual=true;
              items.push(entry);
              await _saveDiscoverPrompts();
              _inspirePromptsLoaded=false;
              addForm.style.display="none";
              _buildInspireBody();
            };

            pillsRow.append(addPill);
            const section=mk("div",{});
            section.append(catLbl,pillsRow,detailsArea,addForm);
            scroll.appendChild(section);
          });
          _inspireBody.appendChild(scroll);
          // Legend for dual-input pills
          if(_hasDual){
            const legend=mk("div",{
              display:"flex",alignItems:"center",gap:"5px",
              marginTop:"8px",flexShrink:"0",
            });
            const badge=mk("span",{
              fontSize:"7px",fontWeight:"800",letterSpacing:".06em",
              background:"rgba(100,160,255,.2)",color:"rgba(140,190,255,.8)",
              border:"1px solid rgba(100,160,255,.3)",borderRadius:"4px",
              padding:"1px 4px",lineHeight:"1.6",flexShrink:"0",
            });
            tx(badge,"2 imgs");
            const legendTxt=mk("span",{fontSize:"9px",color:C.muted,lineHeight:"1.5"});
            tx(legendTxt,"requires both Image 1 and Image 2 to be loaded");
            legend.append(badge,legendTxt);
            _inspireBody.appendChild(legend);
          }
          // Optional note — shown below the prompt pills
          if(def.note){
            const noteLbl=mk("div",{
              fontSize:"9px",color:"#f0a040",lineHeight:"1.5",marginTop:"8px",flexShrink:"0",
            });
            tx(noteLbl,"⚠ "+def.note);
            _inspireBody.appendChild(noteLbl);
          }
          return;
        }

        // ── Tabs mode (original format) ─────────────────────────────────────
        _inspireShowFullBtn.style.display="";
        const tabs=def.tabs||[];
        const tabRow=mk("div",{display:"flex",gap:"4px",marginBottom:"8px",flexShrink:"0"});
        const showTabs=tabs.length>1;
        tabRow.style.display=showTabs?"flex":"none";

        const pages=tabs.map(({items},i)=>{
          const page=mk("div",{
            flex:"1",overflowY:"auto",display:i===0?"flex":"none",
            flexDirection:"column",gap:"4px",
            scrollbarWidth:"thin",scrollbarColor:`${C.border} transparent`,
          });
          page.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
          if(!items||items.length===0){
            const empty=mk("div",{fontSize:"11px",color:C.muted,padding:"20px 0",textAlign:"center"});
            tx(empty,"No suggestions for this mode yet.");
            page.appendChild(empty);
          } else {
            items.forEach(prompt=>{
              const row=mk("div",{
                padding:"8px 10px",borderRadius:"7px",cursor:"pointer",
                fontSize:"10px",lineHeight:"1.55",
                border:`1px solid ${C.border}`,background:C.bg1,
                transition:"background .12s,border-color .12s,color .12s",
                boxSizing:"border-box",
              });
              if(_inspireShowFull){
                row.style.color=C.text;
                tx(row,prompt);
                let _copied=false;
                row.onmouseenter=()=>{ row.style.background=C.bg3;row.style.borderColor="rgba(100,160,255,.6)";row.style.color="#9bbfff"; };
                row.onmouseleave=()=>{ row.style.background=C.bg1;row.style.borderColor=C.border;row.style.color=C.text; if(_copied){_copied=false;} };
                row.onclick=()=>{
                  navigator.clipboard.writeText(prompt).then(()=>{
                    row.style.borderColor="rgba(100,220,120,.7)";row.style.color="#7ddd9a";
                    setTimeout(()=>{ row.style.borderColor=C.border;row.style.color=C.text; },1200);
                  }).catch(()=>{});
                };
              } else {
                row.style.color=C.text;
                // In normal mode items are plain strings — show truncated label
                const short=prompt.length>72?prompt.slice(0,70).trimEnd()+"…":prompt;
                tx(row,short);
                row.title=prompt;
                row.onmouseenter=()=>{ row.style.background=C.bg3;row.style.borderColor=LIME;row.style.color="#fff"; };
                row.onmouseleave=()=>{ row.style.background=C.bg1;row.style.borderColor=C.border;row.style.color=C.text; };
                row.onclick=()=>_usePrompt(prompt);
              }
              page.appendChild(row);
            });
          }
          return page;
        });
        if(showTabs){
          tabs.forEach((_tab,i)=>{
            const cat=_tab.cat;
            const tab=mk("button",{
              border:`1px solid ${i===0?LIME:C.border}`,cursor:"pointer",
              padding:"3px 10px",fontSize:"9px",fontWeight:"700",letterSpacing:".04em",
              borderRadius:"5px",outline:"none",transition:"all .15s",
              color:i===0?LIME:C.muted,
              background:i===0?"rgba(240,255,65,.08)":"transparent",
            });
            tx(tab,cat);
            tab.onclick=()=>{
              tabRow.querySelectorAll("button").forEach((t,j)=>{
                t.style.color=j===i?LIME:C.muted;
                t.style.borderColor=j===i?LIME:C.border;
                t.style.background=j===i?"rgba(240,255,65,.08)":"transparent";
              });
              pages.forEach((p,j)=>p.style.display=j===i?"flex":"none");
            };
            tabRow.appendChild(tab);
          });
        }
        _inspireBody.append(tabRow,...pages);
      };

      let _inspirePromptsLoaded=false;
      const _saveDiscoverPrompts=async()=>{
        try{
          const toSave={};
          ["i2i"].forEach(pill=>{
            const d=INSPIRE_BY_PILL[pill];
            if(d&&d.categories) toSave[pill]={categories:d.categories};
            else if(d&&d.tabs) toSave[pill]={tabs:d.tabs};
          });
          await api.fetchApi("/z_image/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({discover_prompts:toSave})});
        }catch(e){ console.warn("[ZImageOneNode] save discover_prompts:",e); }
      };
      // Autofill prompts loaded from config.json — fallbacks used if config missing
      let _autofillPrompts={
        i2i:"Enhance, transform, or re-imagine this image based on your prompt while preserving the core composition.",
      };

      const _loadDiscoverPrompts=async()=>{
        if(_inspirePromptsLoaded) return;
        _inspirePromptsLoaded=true;
        try{
          const r=await api.fetchApi("/z_image/config");
          const d=await r.json();
          if(d.autofill_prompts&&Object.keys(d.autofill_prompts).length){
            _autofillPrompts={..._autofillPrompts,...d.autofill_prompts};
          }
          if(d.discover_prompts){
          ["i2i"].forEach(pill=>{
              if(d.discover_prompts[pill]) INSPIRE_BY_PILL[pill]=d.discover_prompts[pill];
            });
          }
        }catch(e){ console.warn("[ZImageOneNode] load discover_prompts:",e); }
      };

      const _openInspire=async()=>{
        await _loadDiscoverPrompts();
        _buildInspireBody();
        _inspireOverlay.style.display="flex";
        _inspireOverlay.getBoundingClientRect();
        _inspireOverlay.style.opacity="1";
      };

      _inspireHdr.style.position="relative"; _inspireHdr.style.zIndex="1";
      _inspireBody.style.position="relative"; _inspireBody.style.zIndex="1";
      _inspireOverlay.append(_inspireHdr,_inspireBody);

      // ── Get Inspired button ───────────────────────────────────────────────
      const _inspireBtn=mk("button",{
        background:"none",border:`1px solid ${C.border}`,cursor:"pointer",
        padding:"2px 7px",color:C.muted,outline:"none",
        display:"flex",alignItems:"center",gap:"4px",borderRadius:"5px",
        transition:"color .15s,border-color .15s",flexShrink:"0",
      });
      _inspireBtn.innerHTML=`<span style="font-size:9px;font-weight:700;letter-spacing:.04em">✦ Discover</span>`;
      _inspireBtn.onmouseenter=()=>{_inspireBtn.style.color="#fff";_inspireBtn.style.borderColor="#555";};
      _inspireBtn.onmouseleave=()=>{_inspireBtn.style.color=C.muted;_inspireBtn.style.borderColor=C.border;};
      _inspireBtn.onclick=_openInspire;

      // Order: cap | Get Inspired | errChip | [spacer via marginLeft:auto on _ulBtn] | Add LoRA | Expand prompt
      promptCap.style.marginBottom="0";
      promptHdr.append(promptCap,_inspireBtn,errMinChip,_ulBtn,_promptExpandBtn);
      promptWrap.appendChild(promptHdr);

      const promptTA=mk("textarea",{
        width:"100%",height:"80px",resize:"none",
        background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"8px",
        color:C.text,fontSize:"12px",padding:"9px 12px",
        boxSizing:"border-box",outline:"none",lineHeight:"1.55",
        fontFamily:"inherit",transition:"border-color .15s",display:"block",
      },{placeholder:"Describe what you want to generate…"});
      promptTA.value=S.prompt;
      _promptTARef=promptTA;
      promptTA.onfocus=()=>promptTA.style.borderColor=LIME;
      promptTA.onblur=()=>promptTA.style.borderColor=C.border;
      promptTA.oninput=()=>{S.prompt=promptTA.value;S[_pillPromptKey(activePill)]=promptTA.value;persist();};
      promptTA.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();promptTA.blur();}});
      promptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});

      // ── Error panel ───────────────────────────────────────────────────────
      const errPanel=mk("div",{display:"none",borderRadius:"8px",overflow:"hidden"});
      const errMain=mk("div",{background:"linear-gradient(180deg,rgba(255,103,103,.12),rgba(255,103,103,.05))",
        border:`1px solid rgba(255,103,103,.34)`,borderRadius:"8px",
        padding:"10px 12px",boxSizing:"border-box",
        animation:"fk-error-pulse 1.8s ease-in-out infinite"});
      const errTopRow=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"6px"});
      const errTitle=mk("div",{fontSize:"11px",fontWeight:"700",color:C.err});tx(errTitle,"Generation error");
      const _errMinBtn=mk("button",{
        background:"none",border:"none",cursor:"pointer",padding:"2px 6px",
        color:C.muted,fontSize:"9px",fontWeight:"700",letterSpacing:".04em",
        outline:"none",borderRadius:"4px",textTransform:"uppercase",
        border:`1px solid rgba(255,103,103,.25)`,transition:"color .15s,border-color .15s",
      });
      tx(_errMinBtn,"Hide");
      errTopRow.append(errTitle,_errMinBtn);
      const errMsg=mk("div",{fontSize:"11px",lineHeight:"1.55",color:C.text,whiteSpace:"pre-wrap",wordBreak:"break-word"});
      const errHint=mk("div",{fontSize:"10px",lineHeight:"1.5",color:C.warn,marginTop:"6px"});
      tx(errHint,"Check the console log for details and make sure the correct models are selected in Settings.");
      errMain.append(errTopRow,errMsg,errHint);
      errPanel.appendChild(errMain);

      let _errMinimized=false;
      const _toggleErrMin=()=>{
        _errMinimized=!_errMinimized;
        errPanel.style.display=_errMinimized?"none":"block";
        errMain.style.display=_errMinimized?"none":"block";
        errMinChip.style.display=_errMinimized?"flex":"none";
        promptTA.style.display=_errMinimized?"block":"none";
        tx(_errMinBtn,_errMinimized?"Show":"Hide");
      };
      _errMinBtn.onclick=_toggleErrMin;
      errMinChip.onclick=_toggleErrMin;

      function showError(msg){
        _errMinimized=false;tx(_errMinBtn,"Hide");
        errMsg.textContent=msg||"Unknown error.";
        errMain.style.display="block";errMinChip.style.display="none";
        promptTA.style.display="none";errPanel.style.display="block";
      }
      function clearError(){
        _errMinimized=false;errPanel.style.display="none";promptTA.style.display="block";
        errMinChip.style.display="none";
      }

      promptWrap.append(promptTA,errPanel);

      // ── Prompt expand overlay ─────────────────────────────────────────────
      const _promptOverlay=mk("div",{
        position:"absolute",inset:"0",zIndex:"250",background:C.bg0,
        display:"none",flexDirection:"column",
        padding:"14px",boxSizing:"border-box",gap:"8px",
        opacity:"0",transition:"opacity 0.15s ease",
      });
      const _promptOvHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:"0"});
      const _promptOvCap=mk("div",{fontSize:"10px",fontWeight:"700",color:C.muted,letterSpacing:".07em",textTransform:"uppercase"});
      tx(_promptOvCap,"Prompt");
      const _promptCollapseBtn=mk("button",{
        background:"none",border:"none",cursor:"pointer",padding:"2px 4px",
        color:C.muted,lineHeight:"1",outline:"none",
        display:"flex",alignItems:"center",borderRadius:"4px",transition:"color .15s",
      });
      _promptCollapseBtn.innerHTML=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
      _promptCollapseBtn.onmouseenter=()=>_promptCollapseBtn.style.color=LIME;
      _promptCollapseBtn.onmouseleave=()=>_promptCollapseBtn.style.color=C.muted;
      _promptOvHdr.append(_promptOvCap,_promptCollapseBtn);
      const _promptOvTA=mk("textarea",{
        flex:"1",width:"100%",resize:"none",minHeight:"0",
        background:C.bg2,border:`1px solid ${C.border}`,borderRadius:"8px",
        color:C.text,fontSize:"12px",padding:"10px 12px",
        boxSizing:"border-box",outline:"none",lineHeight:"1.6",
        fontFamily:"inherit",transition:"border-color .15s",
      },{placeholder:"Describe what you want to generate…"});
      _promptOvTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
      _promptOvTA.onfocus=()=>_promptOvTA.style.borderColor=LIME;
      _promptOvTA.onblur=()=>_promptOvTA.style.borderColor=C.border;
      _promptOvTA.oninput=()=>{S.prompt=_promptOvTA.value;S[_pillPromptKey(activePill)]=_promptOvTA.value;promptTA.value=_promptOvTA.value;persist();};
      const _openPromptOverlay=()=>{
        _promptOvTA.value=S.prompt;_promptOverlay.style.display="flex";
        _promptOverlay.getBoundingClientRect();_promptOverlay.style.opacity="1";
        setTimeout(()=>{_promptOvTA.focus();_promptOvTA.setSelectionRange(_promptOvTA.value.length,_promptOvTA.value.length);},50);
      };
      const _closePromptOverlay=()=>{
        S.prompt=_promptOvTA.value;promptTA.value=_promptOvTA.value;persist();
        _promptOverlay.style.opacity="0";
        setTimeout(()=>_promptOverlay.style.display="none",160);
      };
      _promptExpandBtn.onclick=_openPromptOverlay;
      _promptCollapseBtn.onclick=_closePromptOverlay;
      _promptOverlay.append(_promptOvHdr,_promptOvTA);
      _promptOverlay.addEventListener("keydown",e=>{if(e.key==="Escape")_closePromptOverlay();});

      // ── GENERATION ────────────────────────────────────────────────────────
      const _resetGenBtn=()=>{
        genBtn.disabled=false;tx(genBtn,"Generate");
        genBtn.style.background=LIME;genBtn.style.backgroundSize="";
        genBtn.style.animation="none";genBtn.style.color="#111";
        genBtn.style.border="2px solid transparent";
        stopBtn.style.maxWidth="0";stopBtn.style.minWidth="0";stopBtn.style.width="0";stopBtn.style.opacity="0";stopBtn.style.padding="0";stopBtn.style.marginLeft="0";
        progWrap.style.display="none";
        if(_lastGenObj) previewDelBtn.style.display="flex";
      };

      const resetBtn=()=>{
        S.generating=false;S._pendingMeta=null;_activePromptId=null;
        S._preRunFiles=new Set();persist();_resetGenBtn();
      };

      let _lastGenObj=null; // {filename, subfolder} of the most recently generated image

      let _previewBlobUrl=null;
      const showPreview=(url)=>{
        if(_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
        _previewBlobUrl=url;
        placeholder.style.display="none";
        finalImg.src=url;
        finalImg.style.display="block";
      };

      const showFinal=(url,filename,subfolder)=>{
        if(_previewBlobUrl){ URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl=null; }
        clearError();S.generating=false;S.previewUrl=null;_activePromptId=null;persist();
        _resetGenBtn();
        if(soundEnabled)playDone();
        _galNeedsRefresh=true;
        if(filename) _lastGenObj={filename,subfolder:subfolder||""};
        placeholder.style.display="none";

        // Save metadata — use snapshot captured at Generate click time
        const meta=S._pendingMeta?{v:1,...S._pendingMeta}:{v:1,prompt:S.prompt,w:getEffectiveW(),h:getEffectiveH(),mode:activePill};
        if(filename){
          api.fetchApi("/z_image/save_meta",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({filename,subfolder:subfolder||"",meta}),
          }).catch(e=>console.warn("[ZImageOneNode] save_meta:",e));
        }

        const _showComparer=(img1InputName)=>{
          finalImg.style.display="none";
          comparerGenImg.src=url;
          comparerGenImg.style.width=(previewBox.offsetWidth||620)+"px";
          comparerBase.src=api.apiURL(`/view?filename=${encodeURIComponent(img1InputName)}&type=input&subfolder=`);
          comparerWrap.style.display="block";
          previewUseWrap.style.display="block";
          _cmpSetPct(100);
        };
        // Use snapshot mode/image so switching pills mid-generation doesn't corrupt comparer
        const _snapMode=S._pendingMeta?.mode||activePill;
        const _snapImg1=S._pendingMeta?.image1||null;
        if(_snapMode==="i2i"&&_snapImg1){
          _showComparer(_snapImg1);
        } else {
          comparerWrap.style.display="none";
          finalImg.src=url;finalImg.style.display="block";
        }
        previewUseWrap.style.display="block";
        if(filename) previewDelBtn.style.display="flex";
      };

      const _slotErr=(slot,lbl)=>{ slot.el.style.borderColor="#e05555"; tx(lbl,"Required!"); lbl.style.color="#e05555"; };

      genBtn.onclick=async()=>{
        if(!S.prompt.trim()){showError("Please enter a prompt.");return;}
        if(activePill==="i2i"&&!i2iSlot.hasFile()){_slotErr(i2iSlot,i2iSlotLbl);return;}

        const _hasExtModel=(()=>{ const n=app.graph.getNodeById(self.id); const inputs=n?.inputs||[]; const slot=inputs.find(i=>i.name==="model"); return slot?.link!=null; })();
        if(!S.model&&!_hasExtModel){showError("No model selected. Open Settings and choose a model.");return;}

        clearError();S.generating=true;

        let _snapMode=activePill;
        S._pendingMeta={
          prompt:S.prompt,
          w:getEffectiveW(), h:getEffectiveH(),
          mode:_snapMode,
          image1:activePill==="i2i"?(S.i2iImage||null):null,
          i2iDenoise:activePill==="i2i"?S.i2iDenoise:undefined,
          userLoras:S.userLoras.filter(l=>l.name&&l.name!=="none"&&+(l.strength||0)>0).map(l=>({n:l.name.split(/[\\/]/).pop(),s:l.strength})),
          ...(S.advancedUI?{steps:S.steps||4, cfg:S.cfg!==undefined?S.cfg:1,
            sampler:S.sampler||"res_multistep", scheduler:S.scheduler||"simple",
            advancedUI:true}:{}),
          seed:S.seed||0, randomizeSeed:S.randomizeSeed,
        };

        S._preRunFiles=new Set();persist();

        // Keep existing image visible until the new one arrives
        const _hadImage=finalImg.style.display!=="none"||comparerWrap.style.display!=="none";
        if(!_hadImage) placeholder.style.display="none";
        progWrap.style.display="flex";
        setStage("Generating…","Preparing workflow…",0);

        genBtn.disabled=true;tx(genBtn,"Generating…");
        genBtn.style.background="linear-gradient(270deg,#4dff6e,#00e5ff,#a259ff,#4dff6e)";
        genBtn.style.backgroundSize="300% 300%";
        genBtn.style.animation="fk-gradient 2.4s ease infinite";
        genBtn.style.color=LIME;genBtn.style.border="2px solid transparent";
        previewDelBtn.style.display="none";
        requestAnimationFrame(()=>{
          stopBtn.style.maxWidth="120px";stopBtn.style.minWidth="";stopBtn.style.width="";stopBtn.style.opacity="1";stopBtn.style.padding="0 14px";stopBtn.style.marginLeft="6px";
        });

        // Snapshot pre-run gallery files so we can identify the new output
        try{
          const prevR=await api.fetchApi("/z_image/gallery?offset=0&limit=200&subfolder=one-node-z-image");
          const prevD=await prevR.json();
          S._preRunFiles=new Set((prevD.images||[]).map(v=>v.key||((v.subfolder?`${v.subfolder}/`:"")+v.filename)));
        }catch(e){ S._preRunFiles=new Set(); }

        // Load correct workflow
        const isI2IMode=activePill==="i2i";
        let wfUrl;
        if(isI2IMode) wfUrl="/z_image/workflow_i2i";
        else wfUrl="/z_image/workflow_t2i";

        let wfData;
        try{
          const r=await api.fetchApi(wfUrl);
          if(!r.ok) throw new Error("HTTP "+r.status);
          wfData=await r.json();
        }catch(e){
          showError("Could not load workflow (HTTP 404 = restart ComfyUI): "+fmtErr(e));resetBtn();return;
        }

        const prompt=JSON.parse(JSON.stringify(wfData));
        const set=(id,key,val)=>{ if(prompt[id]) prompt[id].inputs[key]=val; };
        const _isBase=_isBaseModel();
        const _setAdv=(samplerNodeId,skipDenoise)=>{
          const steps=S.advancedUI?(S.steps||4):(_isBase?20:4);
          const cfg=S.advancedUI?(S.cfg!==undefined?S.cfg:1):(_isBase?5:1);
          set(samplerNodeId,"steps",steps);
          set(samplerNodeId,"cfg",cfg);
          if(S.advancedUI){
            set(samplerNodeId,"sampler_name",S.sampler||"res_multistep");
            set(samplerNodeId,"scheduler",S.scheduler||"simple");
            if(!skipDenoise) set(samplerNodeId,"denoise",S.denoise!==undefined?S.denoise:1);
          }
        };

        // Build effective prompt — trigger words from all active LoRAs prepended
        const _effectivePrompt=await _buildPromptWithTriggers(S.prompt||"");

        const useKV=false; // KV cache not available for Z-Image

        // ── External model/clip/vae input detection ─────────────────────────
        // If the node has optional inputs wired from outside (e.g. a GGUF loader),
        // skip internal loaders and use the external node's output instead.
        // The external node is serialized and added to the prompt so ComfyUI can find it.
        const _selfNode=app.graph.getNodeById(self.id);
        const _extSlot=(name)=>{
          if(!_selfNode) return null;
          const inputs=_selfNode.inputs||[];
          const slot=inputs.find(i=>i.name===name);
          if(!slot||slot.link==null) return null;
          const link=app.graph.links[slot.link];
          if(!link) return null;
          // Serialize the external node and all its upstream dependencies into prompt
          const _addNodeToPrompt=(nodeId)=>{
            if(prompt[String(nodeId)]) return; // already added
            const extNode=app.graph.getNodeById(nodeId);
            if(!extNode) return;
            const serialized={class_type:extNode.comfyClass||extNode.type,inputs:{},_meta:{title:extNode.title||extNode.type}};
            // Add widget values as inputs
            (extNode.widgets||[]).forEach(w=>{ if(w.name) serialized.inputs[w.name]=w.value; });
            // Add connected inputs
            (extNode.inputs||[]).forEach((inp,i)=>{
              if(inp.link!=null){
                const l=app.graph.links[inp.link];
                if(l){ _addNodeToPrompt(l.origin_id); serialized.inputs[inp.name]=[String(l.origin_id),l.origin_slot||0]; }
              }
            });
            prompt[String(nodeId)]=serialized;
          };
          _addNodeToPrompt(link.origin_id);
          return [String(link.origin_id),link.origin_slot||0];
        };
        const extModel=_extSlot("model");
        const extClip =_extSlot("clip");
        const extVae  =_extSlot("vae");

        // ── LoRA chain helper ───────────────────────────────────────────────
        const _applyLoRAs=(chainSrc,idPrefix)=>{
          const toPrev=(p)=>typeof p==="string"?[p,0]:p;
          let prev=chainSrc;
          (S.userLoras||[]).forEach((ul,i)=>{
            if(!ul.name||ul.name==="none"||!(+(ul.strength||0)>0)) return;
            const id=`${idPrefix}UL${i+1}`;
            prompt[id]={
              inputs:{lora_name:ul.name,strength_model:+(ul.strength??1.0),model:toPrev(prev)},
              class_type:"LoraLoaderModelOnly",
              _meta:{title:`User LoRA ${i+1}`},
            };
            prev=[id,0];
          });
          return prev;
        };

        if(isI2IMode){
          // ── I2I workflow patching ──────────────────────────────────────────
          if(extModel){ delete prompt["FK:165"]; }
          else set("FK:165","unet_name",S.model||"z_image_turbo_bf16.safetensors");
          if(extClip){ delete prompt["FK:155"]; prompt["FK:166"].inputs.clip=extClip; prompt["FK:156"].inputs.clip=extClip; }
          else set("FK:155","clip_name",S.textEncoder||"qwen_3_4b.safetensors");
          if(extVae){ delete prompt["FK:153"]; prompt["FKI2I:vae"].inputs.vae=extVae; prompt["FK:152"].inputs.vae=extVae; }
          else set("FK:153","vae_name",S.vae||"ae.safetensors");
          set("FK:166","text",       _effectivePrompt);
          set("FKI2I:img","image",   S.i2iImage||"placeholder.png");
          set("FK:86","filename_prefix","one-node-z-image/FK");

          // Resize input image by longer side if enabled
          if(S.i2iResizeLonger>0){
            const dims=_i2iDims._getDims();
            if(dims.w&&dims.h){
              const scale=S.i2iResizeLonger/Math.max(dims.w,dims.h);
              const newW=Math.round(dims.w*scale/16)*16;
              const newH=Math.round(dims.h*scale/16)*16;
              prompt["FKI2I:scale"]={
                class_type:"ImageScale",
                inputs:{image:["FKI2I:img",0],upscale_method:"lanczos",width:newW,height:newH,crop:"center"},
                _meta:{title:"Scale I2I Input"},
              };
              prompt["FKI2I:vae"].inputs.pixels=["FKI2I:scale",0];
            }
          }

          // Model chain → ModelSamplingAuraFlow → KSampler
          let i2iModelSrc=extModel||"FK:165";
          const i2iLoraRef=_applyLoRAs(i2iModelSrc,"FK:");
          set("FK:169","model",typeof i2iLoraRef==="string"?[i2iLoraRef,0]:i2iLoraRef);

          const seed=S.randomizeSeed?Math.floor(Math.random()*999999999999):S.seed;
          if(S.randomizeSeed){S.seed=seed;seedInp.setVal(seed);_advSeedInp.setVal(seed);_advSeedRefresh();persist();}
          set("FK:171","seed",seed);
          set("FK:171","denoise",S.i2iDenoise!==undefined?S.i2iDenoise:0.75);
          _setAdv("FK:171",true); // skipDenoise=true — denoise controlled by slider, not advanced

        } else {
          // ── T2I: original model chain ─────────────────────────────────────
          if(extModel){ delete prompt[WF.model]; }
          else set(WF.model,"unet_name",S.model||"z_image_turbo_bf16.safetensors");
          if(extClip){ delete prompt[WF.textEnc]; prompt[WF.promptPos].inputs.clip=extClip; prompt[WF.promptNeg].inputs.clip=extClip; }
          else set(WF.textEnc,"clip_name",S.textEncoder||"qwen_3_4b.safetensors");
          if(extVae){ delete prompt[WF.vae]; if(prompt["FK:132"]) prompt["FK:132"].inputs.vae=extVae; if(prompt["FK:232"]) prompt["FK:232"].inputs.vae=extVae; prompt["FK:152"].inputs.vae=extVae; }
          else set(WF.vae,"vae_name",S.vae||"ae.safetensors");

          // Build chain: UNETLoader → (LoRAs?) → ModelSamplingAuraFlow
          let modelSrc=extModel||WF.model;
          const finalModelRef=_applyLoRAs(modelSrc,"FK:");
          set(WF.sampling,"model",typeof finalModelRef==="string"?[finalModelRef,0]:finalModelRef);

          const seed=S.randomizeSeed?Math.floor(Math.random()*999999999999):S.seed;
          if(S.randomizeSeed){S.seed=seed;seedInp.setVal(seed);_advSeedInp.setVal(seed);_advSeedRefresh();persist();}
          set(WF.sampler,"seed",seed); _setAdv(WF.sampler);

          set(WF.promptPos,"text",_effectivePrompt);
          set(WF.promptNeg,"text",DEFAULT_NEG_PROMPT);
          set(WF.saveImage,"filename_prefix","one-node-z-image/FK");

          // ── T2I ──────────────────────────────────────────────────────────
          if(activePill==="t2i"){
            const w=getW(), h=getH();
            set(WF.latent,"width",  w||1024);
            set(WF.latent,"height", h||1024);
          }


        }

        try{
          const resp=await api.fetchApi("/prompt",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({prompt,client_id:api.clientId,extra_data:{enable_previews:true}}),
          });
          const result=await resp.json();
          const wfErrs=Object.entries(result.node_errors||{}).filter(([k])=>k!==String(self.id));
          if(result.error){
            showError(fmtErr(result.error));resetBtn();
          }else if(wfErrs.length){
            showError(fmtErr(wfErrs[0][1]));resetBtn();
          }else{
            _activePromptId=result.prompt_id||null;
            console.log("[ZImageOneNode] queued:",result.prompt_id);
          }
        }catch(err){
          showError(fmtErr(err));resetBtn();
        }
      };

      // ── PILL VISIBILITY ───────────────────────────────────────────────────
      function updatePillVisibility(){
        i2iPanel.style.display=activePill==="i2i"?"flex":"none";
        resSect.style.display=activePill==="i2i"?"none":"flex";
        updateSizeControls();
      }

      // ── mkHeart helper (used by gallery) ─────────────────────────────────
      const _mkHeart=(size)=>{
        const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
        svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("width",size||"12px");svg.setAttribute("height",size||"12px");
        svg.style.fill="currentColor";svg.style.display="block";svg.style.flexShrink="0";
        const p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d","M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z");
        svg.appendChild(p);return svg;
      };

      // ── GALLERY OVERLAY ───────────────────────────────────────────────────
      const galleryOverlay=mk("div",{
        position:"absolute",inset:"0",background:"#0a0a0a",
        display:"none",flexDirection:"column",padding:"16px",
        boxSizing:"border-box",zIndex:"50",borderRadius:"8px",
        opacity:"0",transition:"opacity .22s ease, transform .22s ease",
        transform:"translateY(6px)",
      });

      // Gallery header
      const galHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",
        marginBottom:"12px",flexShrink:"0",gap:"8px"});
      const galTitle=mk("div",{fontSize:"13px",fontWeight:"700",letterSpacing:".06em",
        textTransform:"uppercase",color:C.text});tx(galTitle,"Gallery");

      const galHdrRight=mk("div",{display:"flex",gap:"6px",alignItems:"center"});

      // Favorites toggle
      let _galFavOnly=false;
      const galFavBtn=mk("button",{background:"transparent",border:`1px solid ${C.border}`,
        borderRadius:"6px",padding:"4px 10px",fontSize:"11px",color:C.muted,
        cursor:"pointer",outline:"none",transition:"border-color .15s,color .15s,background .15s",
        display:"flex",alignItems:"center",gap:"5px"});
      galFavBtn.appendChild(_mkHeart("11px"));
      const _galFavLbl=mk("span");tx(_galFavLbl,"Favorites");galFavBtn.appendChild(_galFavLbl);
      const _setGalFavBtn=(active)=>{
        _galFavOnly=active;
        galFavBtn.style.background=active?`rgba(240,255,65,.18)`:"transparent";
        galFavBtn.style.borderColor=active?LIME:C.border;
        galFavBtn.style.color=active?LIME:C.muted;
        galleryOverlay.style.background=active?
          "linear-gradient(180deg,rgba(240,255,65,.06) 0%,rgba(240,255,65,.02) 40%,rgba(0,0,0,0) 100%), #0a0a0a":
          "#0a0a0a";
      };
      galFavBtn.onmouseenter=()=>{if(!_galFavOnly){galFavBtn.style.borderColor=LIME;galFavBtn.style.color=LIME;}};
      galFavBtn.onmouseleave=()=>{if(!_galFavOnly){galFavBtn.style.borderColor=C.border;galFavBtn.style.color=C.muted;}};
      galFavBtn.onclick=()=>{ _setGalFavBtn(!_galFavOnly); galLoad(true); };

      const galRefreshBtn=mk("button",{background:C.bg3,border:`1px solid ${C.border}`,
        borderRadius:"6px",padding:"4px 10px",fontSize:"11px",color:C.muted,
        cursor:"pointer",outline:"none",transition:"border-color .15s,color .15s"});
      tx(galRefreshBtn,"↺ Refresh");
      galRefreshBtn.onmouseenter=()=>{galRefreshBtn.style.borderColor=C.text;galRefreshBtn.style.color=C.text;};
      galRefreshBtn.onmouseleave=()=>{galRefreshBtn.style.borderColor=C.border;galRefreshBtn.style.color=C.muted;};

      const galClose=mk("button",{background:"transparent",border:`1px solid #e05555`,
        borderRadius:"6px",padding:"4px 14px",fontSize:"11px",color:"#e05555",
        cursor:"pointer",outline:"none",transition:"opacity .15s"});
      tx(galClose,"✕  Close");
      galClose.onmouseenter=()=>galClose.style.opacity=".7";
      galClose.onmouseleave=()=>galClose.style.opacity="1";

      galHdrRight.append(galFavBtn,galRefreshBtn,galClose);
      galHdr.append(galTitle,galHdrRight);

      // Grid + scroll area
      const galScroll=mk("div",{flex:"1",overflowY:"auto",scrollbarWidth:"thin",
        scrollbarColor:`${C.border} transparent`});
      const galGrid=mk("div",{
        display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",
        gap:"6px",paddingBottom:"12px",
      });
      const galEmpty=mk("div",{fontSize:"12px",color:C.muted,textAlign:"center",
        padding:"40px 0",display:"none"});
      tx(galEmpty,"No images found.");
      // Infinite scroll sentinel inside galScroll — must be a child of the scroll container
      const galSentinel=mk("div",{height:"2px",flexShrink:"0",marginTop:"4px"});
      // Loading spinner shown below grid while fetching next page
      const galMoreWrap=mk("div",{display:"none",justifyContent:"center",alignItems:"center",
        padding:"14px 0",gap:"8px",flexShrink:"0"});
      const galSpinner=mk("div",{
        width:"16px",height:"16px",borderRadius:"50%",flexShrink:"0",
        border:"2px solid rgba(240,255,65,.2)",borderTopColor:LIME,
        animation:"fk-galSpin .7s linear infinite",
      });
      if(!document.getElementById("fk-galspin-style")){
        const ss=document.createElement("style");ss.id="fk-galspin-style";
        ss.textContent="@keyframes fk-galSpin{to{transform:rotate(360deg)}}";
        document.head.appendChild(ss);
      }
      const galMoreBtn=mk("div"); // kept for compatibility
      galMoreWrap.appendChild(galSpinner);
      // Sentinel and spinner are inside galScroll so IntersectionObserver root works correctly
      galScroll.append(galGrid,galEmpty,galMoreWrap,galSentinel);

      let _galLoading=false;
      const _galIo=new IntersectionObserver(entries=>{
        if(!entries[0].isIntersecting) return;
        if(_galLoading||_galFavOnly||_galOffset>=_galTotal) return;
        galLoad(false,GAL_MORE);
      },{root:galScroll,threshold:0});
      _galIo.observe(galSentinel);

      galleryOverlay.append(galHdr,galScroll);

      // ── LIGHTBOX ──────────────────────────────────────────────────────────
      const lightbox=mk("div",{
        position:"absolute",inset:"0",background:"#0a0a0a",
        display:"none",flexDirection:"column",zIndex:"60",borderRadius:"8px",
        boxSizing:"border-box",
      });

      // Top bar: filename (left) + close (right)
      const lbTop=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"8px 10px 4px",flexShrink:"0",gap:"8px"});
      const lbFilename=mk("div",{fontSize:"11px",color:C.muted,flex:"1",
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"});
      const lbClose=mk("button",{background:"transparent",border:`1px solid #e05555`,
        borderRadius:"6px",padding:"3px 12px",fontSize:"11px",color:"#e05555",
        cursor:"pointer",outline:"none",transition:"opacity .15s"});
      tx(lbClose,"✕");
      lbClose.onmouseenter=()=>lbClose.style.opacity=".7";
      lbClose.onmouseleave=()=>lbClose.style.opacity="1";
      lbTop.append(lbFilename,lbClose);

      // Body: arrows + image wrap as flex siblings (full-height arrows like LTX node)
      const lbBody=mk("div",{display:"flex",alignItems:"center",flex:"1",
        minHeight:"0",position:"relative",gap:"8px",padding:"0 8px"});
      const lbImgWrap=mk("div",{flex:"1",minWidth:"0",display:"flex",alignItems:"center",
        justifyContent:"center",overflow:"hidden",height:"100%",minHeight:"0"});
      const lbImg=mk("img",{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",
        borderRadius:"8px",display:"block"});
      lbImgWrap.appendChild(lbImg);
      // Prev / Next arrows — flex siblings, full height
      const lbArrowL=mk("button",{background:"rgba(255,255,255,.08)",border:"none",
        borderRadius:"6px",width:"36px",flexShrink:"0",alignSelf:"stretch",
        cursor:"pointer",fontSize:"18px",color:C.text,outline:"none",
        transition:"background .15s",display:"flex",alignItems:"center",justifyContent:"center"});
      tx(lbArrowL,"‹");
      lbArrowL.onmouseenter=()=>lbArrowL.style.background="rgba(255,255,255,.15)";
      lbArrowL.onmouseleave=()=>lbArrowL.style.background="rgba(255,255,255,.08)";
      const lbArrowR=mk("button",{background:"rgba(255,255,255,.08)",border:"none",
        borderRadius:"6px",width:"36px",flexShrink:"0",alignSelf:"stretch",
        cursor:"pointer",fontSize:"18px",color:C.text,outline:"none",
        transition:"background .15s",display:"flex",alignItems:"center",justifyContent:"center"});
      tx(lbArrowR,"›");
      lbArrowR.onmouseenter=()=>lbArrowR.style.background="rgba(255,255,255,.15)";
      lbArrowR.onmouseleave=()=>lbArrowR.style.background="rgba(255,255,255,.08)";
      lbBody.append(lbArrowL,lbImgWrap,lbArrowR);

      // Metadata panel — shown below image
      const lbMeta=mk("div",{
        flexShrink:"0",margin:"0 8px 4px",
        background:"linear-gradient(180deg,rgba(240,255,65,.07),rgba(240,255,65,.02))",
        border:"1px solid rgba(240,255,65,.2)",borderRadius:"10px",
        padding:"9px 12px",display:"none",flexDirection:"column",gap:"6px",
      });

      // Prompt row
      const lbPromptRow=mk("div",{display:"flex",flexDirection:"column",gap:"3px"});
      const lbPromptLbl=mk("div",{fontSize:"9px",color:C.muted,fontWeight:"700",
        letterSpacing:".08em",textTransform:"uppercase"});
      tx(lbPromptLbl,"Prompt");
      const lbPromptText=mk("div",{fontSize:"10px",color:C.text,lineHeight:"1.5",
        maxHeight:"42px",overflowY:"auto",scrollbarWidth:"thin"});
      lbPromptRow.append(lbPromptLbl,lbPromptText);

      // Info chips row: resolution chip + input thumb + restore btn + fav + open folder
      const lbInfoRow=mk("div",{display:"flex",gap:"6px",alignItems:"stretch",flexWrap:"wrap"});

      const _lbChip=(label,val)=>{
        const chip=mk("div",{display:"flex",flexDirection:"column",gap:"1px",
          background:C.bg3,borderRadius:"5px",padding:"4px 8px",minWidth:"50px"});
        const cl=mk("div",{fontSize:"8px",color:C.muted,fontWeight:"700",
          letterSpacing:".07em",textTransform:"uppercase"});
        tx(cl,label);
        const cv=mk("div",{fontSize:"10px",color:C.text,fontWeight:"600"});
        tx(cv,val||"—");
        chip.append(cl,cv);
        return chip;
      };
      const lbChipRes=_lbChip("Size","—");
      const lbChipMode=_lbChip("Mode","—");
      const lbChipAdv=mk("div",{
        display:"none",alignItems:"center",gap:"4px",
        background:C.bg3,borderRadius:"5px",padding:"4px 8px",
        fontSize:"9px",color:C.muted,fontWeight:"700",letterSpacing:".05em",
        cursor:"default",title:"Advanced settings saved",
      });
      lbChipAdv.innerHTML=`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg><span>ADV</span>`;

      // Input image thumbnails (shown when meta has image1 / image2)
      const lbImgThumb=mk("img",{height:"40px",borderRadius:"4px",objectFit:"cover",
        display:"none",alignSelf:"center",border:`1px solid ${C.border}`});
      const lbImgThumb2=mk("img",{height:"40px",borderRadius:"4px",objectFit:"cover",
        display:"none",alignSelf:"center",border:`1px solid ${C.border}`});

      // Restore button
      const lbRestoreBtn=mk("button",{
        background:LIME,color:"#111",border:"none",borderRadius:"5px",
        padding:"0 14px",fontSize:"11px",fontWeight:"700",
        cursor:"pointer",outline:"none",transition:"opacity .15s",
        display:"none",alignSelf:"stretch",whiteSpace:"nowrap",
        alignItems:"center",justifyContent:"center"});
      tx(lbRestoreBtn,"Load settings into UI");
      lbRestoreBtn.onmouseenter=()=>lbRestoreBtn.style.opacity=".85";
      lbRestoreBtn.onmouseleave=()=>lbRestoreBtn.style.opacity="1";

      // Fav button
      let _lbFavActive=false;
      const lbFavBtn=mk("button",{
        background:"rgba(20,20,30,.85)",border:"1px solid rgba(240,255,65,.2)",
        borderRadius:"6px",width:"40px",height:"40px",flexShrink:"0",
        cursor:"pointer",outline:"none",
        transition:"background .2s,border-color .2s,color .2s",
        display:"flex",alignItems:"center",justifyContent:"center",
        color:"rgba(240,255,65,.35)",alignSelf:"stretch"});
      const _lbFavApplyStyle=(hover)=>{
        if(_lbFavActive){
          lbFavBtn.style.background=hover?"rgba(240,255,65,.22)":"rgba(240,255,65,.15)";
          lbFavBtn.style.borderColor=hover?LIME:LIME;
          lbFavBtn.style.color=hover?"#fff":LIME;
          lbFavBtn.style.boxShadow=hover?"0 0 10px rgba(240,255,65,.3)":"0 0 6px rgba(240,255,65,.15)";
        } else {
          lbFavBtn.style.background=hover?"rgba(240,255,65,.08)":"rgba(20,20,30,.85)";
          lbFavBtn.style.borderColor=hover?"rgba(240,255,65,.5)":"rgba(240,255,65,.2)";
          lbFavBtn.style.color=hover?"rgba(240,255,65,.85)":"rgba(240,255,65,.35)";
          lbFavBtn.style.boxShadow="none";
        }
      };
      lbFavBtn.onmouseenter=()=>_lbFavApplyStyle(true);
      lbFavBtn.onmouseleave=()=>_lbFavApplyStyle(false);
      lbFavBtn.appendChild(_mkHeart("14px"));

      // Open folder button
      const lbOpenBtn=mk("button",{
        background:"transparent",border:`1px solid ${C.border}`,
        borderRadius:"6px",padding:"0 10px",fontSize:"10px",color:C.muted,
        cursor:"pointer",outline:"none",transition:"border-color .15s,color .15s",
        alignSelf:"stretch",display:"flex",alignItems:"center",gap:"4px",
        marginLeft:"auto",whiteSpace:"nowrap"});
      // Folder SVG icon
      const _lbFolderSvg=(()=>{
        const s=document.createElementNS("http://www.w3.org/2000/svg","svg");
        s.setAttribute("viewBox","0 0 24 24");s.setAttribute("width","12");s.setAttribute("height","12");
        s.style.fill="currentColor";s.style.flexShrink="0";
        const p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d","M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z");
        s.appendChild(p);return s;
      })();
      lbOpenBtn.appendChild(_lbFolderSvg);
      const _lbOpenLbl=mk("span");tx(_lbOpenLbl,"Show in folder");lbOpenBtn.appendChild(_lbOpenLbl);
      lbOpenBtn.onmouseenter=()=>{lbOpenBtn.style.borderColor=C.text;lbOpenBtn.style.color=C.text;};
      lbOpenBtn.onmouseleave=()=>{lbOpenBtn.style.borderColor=C.border;lbOpenBtn.style.color=C.muted;};
      lbOpenBtn.onclick=async()=>{
        const v=_lbActiveImg; if(!v) return;
        try{
          await api.fetchApi("/z_image/open_folder",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({filename:v.filename,subfolder:v.subfolder||""}),
          });
        }catch(e){ console.warn("[ZImageOneNode] open_folder:",e); }
      };

      // ── "Use as…" dropdown button ─────────────────────────────────────────
      const _lbUseWrap=mk("div",{position:"relative",alignSelf:"stretch",display:"flex"});

      const _lbUseBtn=mk("button",{
        background:C.bg3,color:C.text,border:`1px solid ${C.borderH}`,
        borderRadius:"5px",padding:"0 11px",fontSize:"10px",fontWeight:"600",
        cursor:"pointer",outline:"none",whiteSpace:"nowrap",
        display:"flex",alignItems:"center",gap:"5px",
        transition:"border-color .15s,color .15s,background .15s",
      });
      _lbUseBtn.innerHTML=`Use as… <svg viewBox="0 0 10 6" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="1,1 5,5 9,1"/></svg>`;

      // Dropdown panel — appears above the button (bottom-anchored)
      const _lbUseDrop=mk("div",{
        position:"absolute",bottom:"calc(100% + 5px)",left:"0",
        background:C.bg1,border:`1px solid ${C.borderH}`,borderRadius:"8px",
        minWidth:"170px",overflow:"hidden",display:"none",zIndex:"200",
        boxShadow:"0 4px 20px rgba(0,0,0,.7)",flexDirection:"column",
      });

      // Section header inside dropdown
      const _mkDropSection=(label)=>{
        const h=mk("div",{
          padding:"6px 12px 3px",fontSize:"8px",fontWeight:"700",letterSpacing:".08em",
          textTransform:"uppercase",color:C.muted,userSelect:"none",
        });
        tx(h,label);return h;
      };

      // Clickable slot item inside dropdown
      const _mkDropItem=(label,icon,onClick)=>{
        const row=mk("div",{
          padding:"7px 12px",fontSize:"10px",fontWeight:"500",color:C.text,
          cursor:"pointer",display:"flex",alignItems:"center",gap:"7px",
          transition:"background .1s,color .1s",userSelect:"none",
        });
        const ico=mk("span",{fontSize:"11px",width:"14px",textAlign:"center",flexShrink:"0",color:C.muted});
        tx(ico,icon);
        const lbl=mk("span",{}); tx(lbl,label);
        row.append(ico,lbl);
        row.onmouseenter=()=>{row.style.background="rgba(240,255,65,.10)";row.style.color=LIME;ico.style.color=LIME;};
        row.onmouseleave=()=>{row.style.background="";row.style.color=C.text;ico.style.color=C.muted;};
        row.onclick=()=>{ _lbCloseDrop(); onClick(); };
        return row;
      };

      // Thin divider between sections
      const _mkDropDivider=()=>mk("div",{height:"1px",background:C.border,margin:"2px 0"});

      // Build dropdown items
      _lbUseDrop.append(
        _mkDropSection("I2I"),
        _mkDropItem("I2I slot","⟳",()=>{ const v=_lbActiveImg;if(v)_loadIntoI2ISlot(v); }),
      );

      let _lbDropOpen=false;
      const _lbCloseDrop=()=>{
        _lbDropOpen=false;
        _lbUseDrop.style.display="none";
      };
      const _lbToggleDrop=()=>{
        _lbDropOpen=!_lbDropOpen;
        _lbUseDrop.style.display=_lbDropOpen?"flex":"none";
      };

      _lbUseBtn.onmouseenter=()=>{_lbUseBtn.style.borderColor=LIME;_lbUseBtn.style.color=LIME;_lbUseBtn.style.background=C.bg2;};
      _lbUseBtn.onmouseleave=()=>{_lbUseBtn.style.borderColor=C.borderH;_lbUseBtn.style.color=C.text;_lbUseBtn.style.background=C.bg3;};
      _lbUseBtn.onclick=(e)=>{ e.stopPropagation(); _lbToggleDrop(); };

      // Close dropdown when clicking outside
      document.addEventListener("click",()=>{ if(_lbDropOpen) _lbCloseDrop(); });
      _lbUseDrop.addEventListener("click",e=>e.stopPropagation());

      _lbUseWrap.append(_lbUseBtn,_lbUseDrop);

      // Delete button in lightbox
      const lbDelBtn=mk("button",{
        background:"rgba(160,25,25,.7)",border:"1px solid rgba(255,80,80,.3)",
        borderRadius:"6px",width:"42px",height:"40px",flexShrink:"0",
        cursor:"pointer",outline:"none",transition:"background .15s,border-color .15s",
        display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(255,180,180,.9)",
        alignSelf:"stretch"});
      lbDelBtn.title="Delete image";
      lbDelBtn.innerHTML=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      lbDelBtn.onmouseenter=()=>{lbDelBtn.style.background="rgba(210,35,35,.9)";lbDelBtn.style.borderColor="rgba(255,80,80,.6)";};
      lbDelBtn.onmouseleave=()=>{lbDelBtn.style.background="rgba(160,25,25,.7)";lbDelBtn.style.borderColor="rgba(255,80,80,.3)";};
      lbDelBtn.onclick=()=>{
        const v=_lbActiveImg; if(!v) return;
        const delIdx=_lbIdx;
        _deleteImage(v,lbDelBtn,()=>{
          // Remove from _galImages and _lbNavList
          const galIdx=_galImages.indexOf(v);
          if(galIdx!==-1){ _galImages.splice(galIdx,1); }
          _galTotal=Math.max(0,_galTotal-1);
          delete _galMetas[v.filename];
          // Remove from navList too (may differ from galImages in fav-only mode)
          const navIdx=_lbNavList.indexOf(v);
          if(navIdx!==-1){ _lbNavList.splice(navIdx,1); }
          // Rebuild grid
          galGrid.innerHTML="";
          if(_galFavOnly){
            const favs=_galImages.filter(img=>_galMetas[img.filename]?.favorite===true);
            _galAppend(favs,0);
            tx(galTitle,`Gallery  (${favs.length} fav)`);
            galEmpty.style.display=favs.length?"none":"block";
          } else {
            _galAppend(_galImages,0);
            tx(galTitle,`Gallery  (${_galTotal})`);
            galEmpty.style.display=_galImages.length?"none":"block";
          }
          // Navigate to next image or close
          if(_lbNavList.length===0){ _lbClose(); }
          else { _lbNav(Math.min(delIdx,_lbNavList.length-1)); }
        });
      };

      lbInfoRow.append(lbChipRes,lbChipMode,lbChipAdv,lbImgThumb,lbImgThumb2,lbRestoreBtn,_lbUseWrap,lbFavBtn,lbDelBtn,lbOpenBtn);

      // LoRA row — subtle, hidden when no loras
      const lbLoraRow=mk("div",{display:"none",gap:"4px",flexWrap:"wrap",alignItems:"center"});
      const lbLoraLbl=mk("span",{fontSize:"8px",color:C.muted,fontWeight:"700",
        letterSpacing:".07em",textTransform:"uppercase",marginRight:"2px"});
      tx(lbLoraLbl,"LoRA");
      lbLoraRow.appendChild(lbLoraLbl);

      lbMeta.append(lbPromptRow,lbLoraRow,lbInfoRow);

      // Bottom counter
      const lbBottom=mk("div",{display:"flex",justifyContent:"center",
        alignItems:"center",padding:"4px 10px 8px",flexShrink:"0",position:"relative"});
      const lbCounter=mk("div",{fontSize:"10px",color:C.muted});
      const lbFShortcut=mk("div",{
        position:"absolute",right:"12px",display:"flex",alignItems:"center",gap:"4px",
      });
      const _lbFKbd=mk("span",{fontSize:"7px",fontWeight:"700",color:"#111",background:C.muted,borderRadius:"3px",padding:"0px 3px",letterSpacing:".02em",lineHeight:"1.7"});
      tx(_lbFKbd,"F");
      const _lbFLbl=mk("span",{fontSize:"7px",color:C.muted,whiteSpace:"nowrap"});
      tx(_lbFLbl,"Fullscreen");
      lbFShortcut.append(_lbFKbd,_lbFLbl);
      lbBottom.append(lbCounter,lbFShortcut);

      lightbox.append(lbTop,lbBody,lbMeta,lbBottom);
      galleryOverlay.appendChild(lightbox);

      // ── Gallery state ────────────────────────────────────────────────────
      let _galImages=[];
      let _galTotal=0;
      let _galOffset=0;
      let _galNeedsRefresh=false;
      let _galMetas={};
      let _lbActiveImg=null;
      let _loraList=[];
      let _lbIdx=0;
      const GAL_LIMIT=50;
      const GAL_MORE=50;

      const _galImgUrl=(v)=>`/view?filename=${encodeURIComponent(v.filename)}&type=output&subfolder=${encodeURIComponent(v.subfolder||"")}`;

      const _fetchMeta=async(v,force=false)=>{
        const key=v.filename;
        if(!force&&_galMetas[key]!==undefined) return _galMetas[key];
        try{
          const r=await api.fetchApi(`/z_image/meta?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder||"")}`);
          const d=await r.json();
          _galMetas[key]=d.ok?d.meta:null;
        }catch(e){ _galMetas[key]=null; }
        return _galMetas[key];
      };

      const _setLbFav=(isFav)=>{
        _lbFavActive=isFav;
        _lbFavApplyStyle(false);
        lightbox.style.background=isFav?
          "linear-gradient(180deg,rgba(240,255,65,.18) 0%,rgba(240,255,65,.06) 50%,rgba(0,0,0,0) 100%), #0a0a0a":
          "#0a0a0a";
      };

      const _lbClose=()=>{ lightbox.style.display="none"; _lbActiveImg=null; };

      // Active navigation list — all images or favorites-only depending on current filter
      let _lbNavList=[];

      const _lbNav=async(i)=>{
        if(!_lbNavList.length) return;
        // Load more when reaching end in non-fav mode
        if(i>=_lbNavList.length&&_galOffset<_galTotal&&!_galFavOnly){
          await galLoad(false,GAL_MORE);
          _lbNavList=_galImages; // refresh after load
        }
        i=Math.max(0,Math.min(_lbNavList.length-1,i));
        lbShow(_lbNavList[i],i);
      };
      lbArrowL.onclick=()=>_lbNav(_lbIdx-1);
      lbArrowR.onclick=()=>_lbNav(_lbIdx+1);

      // Keyboard handler for lightbox — capture phase so we beat ComfyUI canvas handlers
      document.addEventListener("keydown",(e)=>{
        if(lightbox.style.display!=="flex") return;
        if(e.key==="Escape"){ e.preventDefault(); e._lbHandled=true; _lbClose(); return; }
        if(e.key==="ArrowLeft"){ e.preventDefault(); e.stopPropagation(); _lbNav(_lbIdx-1); return; }
        if(e.key==="ArrowRight"){ e.preventDefault(); e.stopPropagation(); _lbNav(_lbIdx+1); return; }
        if(e.key==="f"||e.key==="F"){
          e.preventDefault();
          if(!document.fullscreenElement) lbImg.requestFullscreen().catch(()=>{});
          else document.exitFullscreen().catch(()=>{});
        }
      },{capture:true});

      // Open lightbox
      const lbShow=async(v,idx)=>{
        _lbActiveImg=v;
        _lbIdx=idx??0;
        tx(lbFilename,v.filename);
        lbImg.src=_galImgUrl(v)+"&t="+v.mtime;
        lbMeta.style.display="none";lbRestoreBtn.style.display="none";
        lbPromptText.textContent="";
        lightbox.style.display="flex";
        const total=_lbNavList.length||_galImages.length;
        tx(lbCounter,`${_lbIdx+1} / ${total}`);
        lbArrowL.style.opacity=_lbIdx>0?"1":".25";
        lbArrowR.style.opacity=_lbIdx<total-1?"1":".25";

        const meta=await _fetchMeta(v);
        // Reset lora row
        while(lbLoraRow.children.length>1) lbLoraRow.removeChild(lbLoraRow.lastChild);
        lbLoraRow.style.display="none";
        if(meta){
          lbPromptText.textContent=meta.prompt||"(no prompt saved)";
          const w=meta.w,h=meta.h;
          tx(lbChipRes.querySelector("div:last-child"),w&&h?`${w}×${h}`:"—");
          tx(lbChipMode.querySelector("div:last-child"),(meta.mode||"").toUpperCase()||"—");
          const _hasAdv=meta.advancedUI===true;
          lbChipAdv.style.display=_hasAdv?"flex":"none";
          if(_hasAdv) lbChipAdv.title=`Steps:${meta.steps||8} CFG:${meta.cfg??1} Sampler:${meta.sampler||"res_multistep"}`;
          if(meta.image1){
            lbImgThumb.src=api.apiURL(`/view?filename=${encodeURIComponent(meta.image1)}&type=input&subfolder=`);
            lbImgThumb.style.display="block";
          } else { lbImgThumb.style.display="none"; }
          if(meta.image2){
            lbImgThumb2.src=api.apiURL(`/view?filename=${encodeURIComponent(meta.image2)}&type=input&subfolder=`);
            lbImgThumb2.style.display="block";
          } else { lbImgThumb2.style.display="none"; }
          // LoRA chips
          if(Array.isArray(meta.userLoras)&&meta.userLoras.length){
            meta.userLoras.forEach(ul=>{
              const chip=mk("span",{
                fontSize:"9px",color:C.muted,background:C.bg3,
                borderRadius:"4px",padding:"2px 6px",lineHeight:"1.6",
                border:`1px solid ${C.border}`,whiteSpace:"nowrap",
              });
              const name=(ul.n||"").replace(/\.safetensors$/i,"");
              chip.textContent=`${name} ×${+(ul.s??1).toFixed(2)}`;
              lbLoraRow.appendChild(chip);
            });
            lbLoraRow.style.display="flex";
          }
          lbMeta.style.display="flex";
          lbRestoreBtn.style.display="flex";
          lbRestoreBtn.onclick=()=>_lbApplyMeta(meta);
          _setLbFav(meta.favorite===true);
        } else {
          lbPromptText.textContent="⚠ No metadata.";
          tx(lbChipRes.querySelector("div:last-child"),"—");
          tx(lbChipMode.querySelector("div:last-child"),"—");
          lbChipAdv.style.display="none";
          lbImgThumb.style.display="none";
          lbImgThumb2.style.display="none";
          lbMeta.style.display="flex";
          _setLbFav(false);
        }
      };


      // Resolve an image name from metadata: if it's an output path (contains "/"), upload to input first.
      const _resolveMetaImage=async(name)=>{
        if(!name) return null;
        if(!name.includes("/")) return name;
        const parts=name.split("/");
        const filename=parts[parts.length-1];
        const subfolder=parts.slice(0,-1).join("/");
        try{
          return await _uploadOutputToInput({filename,subfolder});
        }catch(e){
          console.warn("[ZImageOneNode] resolveMetaImage:",e);
          return filename;
        }
      };

      // Apply meta — restores prompt, mode, resolution AND image slots (the source images stored in metadata).
      // "Use as Image 1/2" buttons handle loading the currently-viewed gallery image into a slot instead.
      const _lbApplyMeta=async(meta)=>{
        // Close gallery immediately — don't wait for async image uploads
        lightbox.style.display="none"; _lbActiveImg=null;
        closeOverlayFade(galleryOverlay);

        try{
          const mode=meta.mode||"t2i";
          // Map meta.mode → pill name
          const pillMap={"i2i":"i2i","t2i":"t2i"};
          const pill=pillMap[mode]||"t2i";
          // Prompt
          if(meta.prompt){
            S.prompt=meta.prompt; S[_pillPromptKey(pill)]=meta.prompt;
            promptTA.value=meta.prompt; _promptOvTA.value=meta.prompt;
          }
          // Pill
          setPill(pill);
          // Resolution (T2I / Edit only)
          if(meta.w&&meta.h&&pill==="t2i"){
            const preset=RES_PRESETS.find(r=>r.w===meta.w&&r.h===meta.h);
            if(preset){ S.resLabel=preset.label;S.resW=preset.w;S.resH=preset.h;S.isCustomRes=false;
              resDD.set(preset.label);customResRow.style.display="none"; }
            else { S.isCustomRes=true;S.customW=meta.w;S.customH=meta.h;S.resLabel="Custom…";
              resDD.set("Custom…");customResRow.style.display="flex";
              wInp.setVal(meta.w);hInp.setVal(meta.h); }
          }
          // Image slots — by mode
          const _ri=async(name)=>{ try{ return await _resolveMetaImage(name); }catch(e){ return null; } };
          if(mode==="i2i"){
            if(meta.image1){ const n=await _ri(meta.image1); if(n){S.i2iImage=n;i2iSlot._restorePreview(n);} }
            if(meta.i2iDenoise!==undefined){ S.i2iDenoise=meta.i2iDenoise; _i2iSliderSet(Math.round(meta.i2iDenoise*100)); }
          }
          // Advanced params — only restore if explicitly saved with advancedUI:true
          if(meta.advancedUI===true){
            if(meta.steps){ S.steps=meta.steps; stepsInp.setVal(meta.steps); }
            if(meta.cfg!==undefined){ S.cfg=meta.cfg; cfgInp.setVal(meta.cfg); }
            if(meta.sampler){ S.sampler=meta.sampler; samplerDD.set(meta.sampler); }
            if(meta.scheduler){ S.scheduler=meta.scheduler; schedulerDD.set(meta.scheduler); }
            if(!S.advancedUI){ S.advancedUI=true; _advRefresh(); advUIToggle._setChecked(true); }
          }
          if(meta.seed!==undefined&&meta.randomizeSeed===false){
            S.randomizeSeed=false; S.seed=meta.seed;
            seedInp.setVal(meta.seed); _advSeedInp.setVal(meta.seed); _advSeedRefresh();
          }
          // LoRAs — always reset all slots first, then apply what meta has
          _ulRowEls.forEach((r,i)=>{
            S.userLoras[i]={name:"",strength:0};
            r._dd.set("none"); r._str.value="0";
          });
          if(Array.isArray(meta.userLoras)&&meta.userLoras.length&&_loraList.length){
            const nd=(s)=>(s||"").replace(/\\/g,"/").toLowerCase();
            const loraOpts=["none",..._loraList];
            meta.userLoras.forEach((ul,i)=>{
              if(i>=_ulRowEls.length) return;
              const basename=nd(ul.n||"").split("/").pop();
              const match=loraOpts.find(o=>nd(o)===nd(ul.n||""))||
                loraOpts.find(o=>nd(o).split("/").pop()===basename);
              if(match&&match!=="none"){
                S.userLoras[i].name=match; S.userLoras[i].strength=+(ul.s??1);
                _ulRowEls[i]._dd.set(match); _ulRowEls[i]._str.value=String(S.userLoras[i].strength);
              }
            });
          }
          _ulUpdateBtn();
          updateSizeControls(); persist();
        }catch(err){
          console.warn("[ZImageOneNode] _lbApplyMeta error:",err);
        }
      };

      lbFavBtn.onclick=async()=>{
        const v=_lbActiveImg; if(!v) return;
        const newFav=!(_galMetas[v.filename]?.favorite===true);
        try{
          const r=await api.fetchApi("/z_image/update_meta",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({filename:v.filename,subfolder:v.subfolder||"",patch:{favorite:newFav}}),
          });
          const d=await r.json();
          if(d.ok){
            const cached=_galMetas[v.filename]||{};
            cached.favorite=newFav;_galMetas[v.filename]=cached;
            _setLbFav(newFav);
            lbFavBtn.classList.remove("fk-heart-anim");
            void lbFavBtn.offsetWidth;
            lbFavBtn.classList.add("fk-heart-anim");
            galGrid.querySelectorAll("[data-filename]").forEach(cell=>{
              if(cell.dataset.filename===v.filename){
                const ico=cell.querySelector("._favico");
                if(ico){ ico.style.opacity=newFav?"1":"0"; }
              }
            });
            if(_galFavOnly&&!newFav) galGrid.querySelector(`[data-filename="${CSS.escape(v.filename)}"]`)?.remove();
          }
        }catch(e){ console.warn("[ZImageOneNode] fav:",e); }
      };

      lbClose.onclick=_lbClose;

      // Upload an output image into ComfyUI's input folder so LoadImage can reference it.
      // Returns the uploaded input filename, or null on failure.
      const _uploadOutputToInput=async(v)=>{
        const outputUrl=api.apiURL(`/view?filename=${encodeURIComponent(v.filename)}&type=output&subfolder=${encodeURIComponent(v.subfolder||"")}`);
        const resp=await fetch(outputUrl);
        if(!resp.ok) throw new Error("fetch "+resp.status);
        const blob=await resp.blob();
        const fd=new FormData();
        fd.append("image",new File([blob],v.filename,{type:blob.type||"image/png"}));
        fd.append("overwrite","true");
        const up=await api.fetchApi("/upload/image",{method:"POST",body:fd});
        const upd=await up.json();
        return upd.name||v.filename;
      };

      const _loadIntoI2ISlot=async(v)=>{
        if(activePill!=="i2i") setPill("i2i");
        let inputName;
        try{ inputName=await _uploadOutputToInput(v); }
        catch(err){ console.warn("[ZImageOneNode] load-into-i2i:",err); inputName=v.filename; }
        S.i2iImage=inputName; i2iSlot._restorePreview(inputName);
        persist();
        lightbox.style.display="none";_lbActiveImg=null;
        closeOverlayFade(galleryOverlay);
      };

      // mkApplyIcon for Load button (same as LTX node)
      const _mkApplyIcon=(size)=>{
        size=size||"13px";
        const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
        svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("width",size);svg.setAttribute("height",size);
        svg.style.fill="currentColor";svg.style.display="block";svg.style.flexShrink="0";
        const r1=document.createElementNS("http://www.w3.org/2000/svg","rect");
        r1.setAttribute("x","3");r1.setAttribute("y","3");r1.setAttribute("width","13");r1.setAttribute("height","13");
        r1.setAttribute("rx","2");r1.setAttribute("fill","none");r1.setAttribute("stroke","currentColor");r1.setAttribute("stroke-width","2");
        const r2=document.createElementNS("http://www.w3.org/2000/svg","rect");
        r2.setAttribute("x","8");r2.setAttribute("y","8");r2.setAttribute("width","13");r2.setAttribute("height","13");r2.setAttribute("rx","2");
        svg.appendChild(r1);svg.appendChild(r2);return svg;
      };

      // Build / append grid cells
      const _galAppend=(images,startIdx)=>{
        images.forEach((v,i)=>{
          const idx=startIdx+i;
          const cell=mk("div",{
            position:"relative",borderRadius:"8px",overflow:"hidden",
            background:C.bg2,border:`1px solid ${C.border}`,
            cursor:"pointer",transition:"border-color .15s",
            aspectRatio:"1/1",
          });
          cell.dataset.filename=v.filename;
          cell.dataset.idx=String(idx);

          // Thumbnail
          const thumb=mk("img",{
            width:"100%",height:"100%",objectFit:"cover",
            display:"block",background:C.bg3,position:"absolute",inset:"0",
          });
          thumb.loading="lazy";
          thumb.src=_galImgUrl(v)+"&t="+v.mtime;

          // Hover overlay
          const ov=mk("div",{position:"absolute",inset:"0",background:"rgba(0,0,0,.35)",
            opacity:"0",transition:"opacity .15s",pointerEvents:"none"});

          // Filename strip at bottom
          const strip=mk("div",{
            position:"absolute",bottom:"0",left:"0",right:"0",
            padding:"3px 6px",fontSize:"8px",color:"#ccc",
            background:"rgba(0,0,0,.65)",
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
          });
          tx(strip,v.filename);

          // Fav indicator
          const favIco=mk("div",{
            position:"absolute",bottom:"22px",right:"5px",
            opacity:"0",transition:"opacity .15s",
            color:LIME,pointerEvents:"none",
            textShadow:"0 1px 2px rgba(0,0,0,.9)",
          });
          favIco.className="_favico";
          favIco.appendChild(_mkHeart("11px"));

          cell.append(thumb,ov,strip,favIco);

          cell.onmouseenter=()=>{ cell.style.borderColor=LIME;ov.style.opacity="1"; };
          cell.onmouseleave=()=>{ cell.style.borderColor=C.border;ov.style.opacity="0"; };

          cell.onclick=()=>{ _lbNavList=images; lbShow(v,idx); };

          if(v.favorite===true){
            favIco.style.opacity="1";
            cell.style.background="linear-gradient(180deg,rgba(240,255,65,.12) 0%,rgba(240,255,65,.04) 100%)";
            cell.style.borderColor="rgba(240,255,65,.4)";
          }

          galGrid.appendChild(cell);
        });
      };

      const galLoad=async(reset=true,limit=GAL_LIMIT)=>{
        if(_galLoading&&!reset) return;
        _galLoading=true;
        galMoreWrap.style.display="flex";
        if(reset){ _galImages=[];_galMetas={};_galOffset=0;galGrid.innerHTML=""; }
        tx(galTitle,`Gallery  (loading…)`);
        try{
          if(_galFavOnly){
            // Fast path: single request, server resolves favorites index
            const r=await api.fetchApi(`/z_image/gallery?offset=${_galOffset}&limit=${limit}&subfolder=one-node-z-image&favonly=1`);
            const d=await r.json();
            const newImgs=d.images||[];
            _galTotal=d.total||0;
            _galImages.push(...newImgs);
            _galOffset=_galImages.length;
            _galAppend(newImgs,_galImages.length-newImgs.length);
            galEmpty.style.display=_galImages.length?"none":"block";
            tx(galTitle,`Gallery  (${_galTotal} fav)`);
            galMoreWrap.style.display=_galOffset<_galTotal?"flex":"none";
          } else {
            const r=await api.fetchApi(`/z_image/gallery?offset=${_galOffset}&limit=${limit}&subfolder=one-node-z-image`);
            const d=await r.json();
            const newImgs=d.images||[];
            _galTotal=d.total||0;
            const startIdx=_galImages.length;
            _galImages.push(...newImgs);
            _galOffset=_galImages.length;
            galEmpty.style.display=_galImages.length?"none":"block";
            _galAppend(newImgs,startIdx);
            tx(galTitle,`Gallery  (${_galTotal})`);
            galMoreWrap.style.display=_galOffset<_galTotal?"flex":"none";
          }
        }catch(e){
          tx(galTitle,"Gallery  (error)");
          console.warn("[ZImageOneNode] gallery:",e);
        }finally{
          _galLoading=false;
          if(_galOffset>=_galTotal) galMoreWrap.style.display="none";
        }
      };

      galMoreBtn.onclick=()=>galLoad(false,GAL_MORE); // kept for compatibility
      galRefreshBtn.onclick=()=>galLoad(true);
      galClose.onclick=()=>closeOverlayFade(galleryOverlay,()=>{ lightbox.style.display="none"; _lbActiveImg=null; });
      galleryBtn.onclick=e=>{
        e.stopPropagation();
        openOverlay(galleryOverlay);
        if(_galNeedsRefresh||_galImages.length===0){ galLoad(true); _galNeedsRefresh=false; }
      };

      // Mark gallery as needing refresh after a successful generation
      // _galNeedsRefresh is set to true in showFinal so gallery auto-refreshes on next open

      // ── ASSEMBLE ─────────────────────────────────────────────────────────
      pad.append(topBar,mainRow,promptWrap,creditText);
      root.appendChild(settingsOverlay);
      root.appendChild(galleryOverlay);
      root.appendChild(_promptOverlay);
      root.appendChild(_inspireOverlay);
      scrollEl.appendChild(pad);
      root.appendChild(scrollEl);

      // ── Esc in any number/text input → blur (dismiss focus) ──────────────
      root.addEventListener("keydown",(e)=>{
        if(e.key!=="Escape") return;
        const t=e.target;
        if(t&&(t.tagName==="INPUT")&&t.type!=="range"){ e.stopPropagation(); t.blur(); }
      },true);

      const _creditEl=mk("div",{
        position:"absolute",bottom:"5px",left:"12px",right:"12px",
        fontSize:"8px",color:"#555",pointerEvents:"none",
        letterSpacing:".04em",userSelect:"none",zIndex:"1",
        display:"flex",alignItems:"center",justifyContent:"space-between",
      });
      const _shortcutsEl=mk("span",{color:"#444",letterSpacing:".03em"});
      tx(_shortcutsEl,"D · discover  G · gallery  Space · generate  F · fullscreen");
      const _creditTxt=mk("div",{fontSize:"8px",color:"#555",letterSpacing:".04em",whiteSpace:"nowrap"});
      tx(_creditTxt,"created by Adeliox");
      _creditEl.style.justifyContent="";
      _creditEl.innerHTML="";
      _creditEl.style.pointerEvents="auto";

      // Left: shortcuts toggle button + expanded bar
      const _scLeft=mk("div",{flex:"1",display:"flex",alignItems:"center",gap:"6px"});
      const _scToggleBtn=mk("button",{
        background:"transparent",border:`1px solid ${C.border}`,borderRadius:"4px",
        padding:"1px 6px",fontSize:"7px",fontWeight:"600",color:C.muted,
        cursor:"pointer",outline:"none",letterSpacing:".05em",textTransform:"uppercase",
        transition:"border-color .15s,color .15s",whiteSpace:"nowrap",flexShrink:"0",
      });
      tx(_scToggleBtn,"Shortcuts");
      _scToggleBtn.onmouseenter=()=>{_scToggleBtn.style.borderColor=C.text;_scToggleBtn.style.color=C.text;};
      _scToggleBtn.onmouseleave=()=>{_scToggleBtn.style.borderColor=C.border;_scToggleBtn.style.color=C.muted;};

      const _scBar=mk("div",{display:"none",alignItems:"center",flexShrink:"0",gap:"0",cursor:"pointer"});
      [["D","Discover"],["F","Fullscreen preview"],["G","Gallery"],["Esc","Exit prompt"],["Space","Generate"]].forEach(([key,desc],idx)=>{
        if(idx>0){ const sep=mk("div",{width:"1px",height:"8px",background:C.border,margin:"0 6px",flexShrink:"0"});_scBar.appendChild(sep); }
        const item=mk("div",{display:"flex",alignItems:"center",gap:"3px"});
        const kbd=mk("span",{fontSize:"7px",fontWeight:"700",color:"#111",background:C.muted,borderRadius:"3px",padding:"0px 3px",letterSpacing:".02em",flexShrink:"0",lineHeight:"1.7"});
        tx(kbd,key);
        const lbl=mk("span",{fontSize:"7px",color:C.muted,whiteSpace:"nowrap"});
        tx(lbl,desc);
        item.append(kbd,lbl);
        _scBar.appendChild(item);
      });
      _scBar.onclick=()=>{ _scBar.style.display="none"; _scToggleBtn.style.display=""; };
      _scToggleBtn.onclick=()=>{ _scToggleBtn.style.display="none"; _scBar.style.display="flex"; };

      _scLeft.append(_scToggleBtn,_scBar);

      // Right: credit
      const _creditRight=mk("div",{flex:"1",display:"flex",justifyContent:"flex-end",pointerEvents:"none"});
      _creditRight.appendChild(_creditTxt);

      _creditEl.append(_scLeft,_creditRight);
      root.appendChild(_creditEl);


      // Initialize visibility
      updatePillVisibility();
      updateSizeControls();

      // ── F key → fullscreen current preview image inside the node overlay ──
      // Listen on document; only fire when mouse is over this node's root element.
      let _mouseOverRoot=false;
      root.addEventListener("mouseenter",()=>{ _mouseOverRoot=true; });
      root.addEventListener("mouseleave",()=>{ _mouseOverRoot=false; });

      const _fKeyHandler=(e)=>{
        if(e.key!=="f"&&e.key!=="F") return;
        if(!_mouseOverRoot) return;
        // Don't fire when typing in a text field
        const tag=(document.activeElement||{}).tagName||"";
        if(tag==="INPUT"||tag==="TEXTAREA") return;
        // Don't fire when any overlay is open inside the node
        if(settingsOverlay.style.display!=="none") return;
        if(galleryOverlay.style.display!=="none") return;
        if(_promptOverlay.style.display!=="none") return;
        if(_inspireOverlay.style.display!=="none") return;
        if(_nodeFsOv&&_nodeFsOv.style.display!=="none"){_nodeFsOv._close();return;}

        // Get currently visible image
        let src="", name="", fsType="image", fsOpts=null;
        if(comparerWrap.style.display!=="none"&&comparerGenImg.src){
          src=comparerGenImg.src;
          name="Before / After";
          fsType="comparer";
          fsOpts={
            genSrc:comparerGenImg.src,
            baseSrc:comparerBase.src,
          };
        } else if(finalImg.style.display!=="none"&&finalImg.src){
          src=finalImg.src;
          name=finalImg.src.split("/").pop().split("?")[0]||"Image";
        }
        if(!src) return;

        e.preventDefault();
        e.stopPropagation();
        _initNodeFsOverlay()._open(fsType,src,name,fsOpts);
      };
      document.addEventListener("keydown",_fKeyHandler);

      // ── D key → open/close Discover (Get Inspired) ───────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="d"&&e.key!=="D") return;
        if(!_mouseOverRoot) return;
        const tag=(document.activeElement||{}).tagName||"";
        if(tag==="INPUT"||tag==="TEXTAREA") return;
        if(settingsOverlay.style.display!=="none") return;
        if(galleryOverlay.style.display!=="none") return;
        if(_nodeFsOv&&_nodeFsOv.style.display!=="none") return;
        e.preventDefault();e.stopPropagation();
        if(_inspireOverlay.style.display!=="none"){ _closeInspire(); }
        else { _openInspire(); }
      });

      // ── G key → open Gallery (grid view) ─────────────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="g"&&e.key!=="G") return;
        if(!_mouseOverRoot) return;
        const tag=(document.activeElement||{}).tagName||"";
        if(tag==="INPUT"||tag==="TEXTAREA") return;
        if(settingsOverlay.style.display!=="none") return;
        if(_promptOverlay.style.display!=="none") return;
        if(_inspireOverlay.style.display!=="none") return;
        if(_nodeFsOv&&_nodeFsOv.style.display!=="none") return;
        // If gallery is open (grid view, no lightbox) → close it
        if(galleryOverlay.style.display!=="none"&&lightbox.style.display==="none"){
          closeOverlayFade(galleryOverlay,()=>{ lightbox.style.display="none"; _lbActiveImg=null; });
          e.preventDefault();e.stopPropagation();return;
        }
        if(galleryOverlay.style.display!=="none") return;
        e.preventDefault();e.stopPropagation();
        galleryBtn.click();
      });

      // ── Space → trigger Generate (main UI only) ───────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.code!=="Space") return;
        if(!_mouseOverRoot) return;
        const tag=(document.activeElement||{}).tagName||"";
        if(tag==="INPUT"||tag==="TEXTAREA") return;
        if(settingsOverlay.style.display!=="none") return;
        if(galleryOverlay.style.display!=="none") return;
        if(_promptOverlay.style.display!=="none") return;
        if(_inspireOverlay.style.display!=="none") return;
        if(_nodeFsOv&&_nodeFsOv.style.display!=="none") return;
        e.preventDefault();e.stopPropagation();
        genBtn.click();
      });

      // (fullscreen Esc guard is applied per-handler below)

      // ── Escape → close Get Inspired overlay ──────────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="Escape") return;
        if(_inspireOverlay.style.display==="none") return;
        e.preventDefault();e.stopPropagation();
        _closeInspire();
      });

      // ── E → toggle Edit mode in Discover overlay ──────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="e"&&e.key!=="E") return;
        if(_inspireOverlay.style.display==="none") return;
        const tag=(document.activeElement||{}).tagName||"";
        if(tag==="INPUT"||tag==="TEXTAREA") return;
        e.preventDefault();e.stopPropagation();
        _inspireShowFullBtn.click();
      });

      // ── Escape in gallery grid → close gallery ────────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="Escape") return;
        if(!_mouseOverRoot) return;
        if(galleryOverlay.style.display==="none") return;
        if(e._lbHandled) return; // lightbox already handled this Escape — stay in grid
        e.preventDefault();e.stopPropagation();
        closeOverlayFade(galleryOverlay,()=>{ lightbox.style.display="none"; _lbActiveImg=null; });
      });

      // ── Escape → close Settings / Help overlays ──────────────────────────
      document.addEventListener("keydown",(e)=>{
        if(e.key!=="Escape") return;
        if(settingsOverlay.style.display!=="none"){ e.preventDefault();e.stopPropagation();closeOverlayFade(settingsOverlay);return; }

      });

      // Fetch models
      const _loadModels=()=>api.fetchApi("/z_image/models")
        .then(r=>r.json())
        .then(d=>{
          const _norm=(s)=>(s||"").replace(/\\/g,"/").toLowerCase();
          // pick: saved value takes priority; keyword auto-select only when no saved value matches
          const pick=(list,saved,kw)=>{
            if(!list?.length) return saved;
            const ns=_norm(saved||"");
            // 1. exact match
            let r=list.find(i=>_norm(i)===ns);
            if(r) return r;
            // 2. basename match
            if(ns){
              const base=ns.split("/").pop();
              r=list.find(i=>_norm(i).split("/").pop()===base);
              if(r) return r;
            }
            // 3. no saved value — use keyword auto-select
            if(kw){
              const kws=kw.split(',').map(k=>k.trim().toLowerCase());
              r=list.find(f=>kws.every(k=>_norm(f).includes(k)));
              if(r) return r;
            }
            // 4. fallback: first item
            return list[0]||saved;
          };
          const modelList=(d.diffusion_models||[]).filter(f=>f!=="none");
          if(modelList.length){const v=pick(modelList,S.model,"z_image");S.model=v;modelF.dd.updateItems(modelList);modelF.dd.set(v);}
          else{S.model="";modelF.dd.updateItems(["none"]);modelF.dd.set("none");}
          const teList=(d.text_encoders||[]).filter(f=>f!=="none");
          if(teList.length){const v=pick(teList,S.textEncoder,"qwen");S.textEncoder=v;teF.dd.updateItems(teList);teF.dd.set(v);}
          else{S.textEncoder="";teF.dd.updateItems(["none"]);teF.dd.set("none");}
          const vaeList=(d.vaes||[]).filter(f=>f!=="none");
          if(vaeList.length){const v=pick(vaeList,S.vae,"");S.vae=v;vaeF.dd.updateItems(vaeList);vaeF.dd.set(v);}
          else{S.vae="";vaeF.dd.updateItems(["none"]);vaeF.dd.set("none");}
          persist();
          // Populate LoRA dropdowns
          const loraList=(d.loras||[]).filter(f=>f!=="none");
          _loraList=loraList;
          const loraOpts=["none",...loraList];
          _ulRowEls.forEach((r,i)=>{
            r._dd.updateItems(loraOpts);
            const saved=S.userLoras[i].name;
            if(saved&&saved!=="none"&&loraList.length){
              const nd=(s)=>s.replace(/\\/g,"/").toLowerCase();
              const match=loraOpts.find(o=>nd(o)===nd(saved))||
                loraOpts.find(o=>nd(o).split("/").pop()===nd(saved).split("/").pop());
              if(match){r._dd.set(match);S.userLoras[i].name=match;}
              else{r._dd.set("none");S.userLoras[i].name="";}
            } else{r._dd.set("none");S.userLoras[i].name="";}
          });
          _ulUpdateBtn();
          persist();
        })
        .catch(e=>console.warn("[ZImageOneNode] models:",e));
      _loadModels();
      if(S.extLoaders) _applyExtLoaders(true);

      // Auto-refresh Settings dropdowns when connections change
      self.onConnectionsChange=function(){ _refreshExtInputUI(); };



      const _slotHInit=(self.inputs||[]).length*(LiteGraph.NODE_SLOT_HEIGHT||20);
      this.addDOMWidget("fk_ui","div",root,{
        getValue(){return null;},setValue(){},serialize:false,
        computeSize(){const slotH=(LiteGraph.NODE_SLOT_HEIGHT||20);const n=(self.inputs||[]).length;return[NODE_W,NODE_H+n*slotH];},
      });
      this.setSize([NODE_W,NODE_H+_slotHInit]);

      // Nodes 2.0: hide the auto-injected node-type name badge rendered in the node footer.
      // The badge has class "bg-node-component-surface" (Tailwind) and contains the node type string.
      const _hideNodes2Badge=()=>{
        // Walk up from root to find the node-level container (up to 6 levels)
        let el=root;
        for(let i=0;i<6;i++){
          el=el?.parentElement;
          if(!el) break;
          el.querySelectorAll("[class*='bg-node-component-surface']").forEach(badge=>{
            badge.style.display="none";
          });
        }
      };
      requestAnimationFrame(()=>{
        _hideNodes2Badge();
        if(typeof MutationObserver!=="undefined"){
          let obs=root;
          for(let i=0;i<4;i++) obs=obs?.parentElement||obs;
          new MutationObserver(_hideNodes2Badge).observe(obs,{childList:true,subtree:true});
        }
      });

      if(!window.__zimage_nodes) window.__zimage_nodes={};
      window.__zimage_nodes[this.id]={
        root,S,
        fns:{showFinal,showPreview,resetBtn,setStage,showError,clearError,getPromptId:()=>_activePromptId},
      };
      _activeS=S;
      _activeShowFinal=showFinal;
      _activeShowPreview=showPreview;
      _activeResetBtn=resetBtn;
      _activeSetStage=setStage;
      _activeShowError=showError;
      _activePromptIdRef=()=>_activePromptId;
    };
  },
});
