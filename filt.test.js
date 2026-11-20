const fs=require("fs"); const {JSDOM}=require("jsdom");
const html=fs.readFileSync("admin/index.html","utf8");
const AG=[{agent_id:"live-1",alive:"alive",work:{state:"work",phase:"画图"},load:{cpu_pct:37,mem_used_mb:589,mem_total_mb:4032,disk:[{used_pct:78,free_gb:12}]},env:{git_head:"b34ec2"},age_s:4},
          {agent_id:"dead-1",alive:"offline",work:{state:"idle",phase:"等待"},load:{},env:{},age_s:7200}];
const SUBS=[{submission_id:"sub-a",agent_id:"live-1",base_sha:"b1",kind:"patch",state:"delivered",created_at:1},
            {submission_id:"sub-b",agent_id:"dead-1",base_sha:"b2",kind:"patch",state:"collected",created_at:2}];
const MSGS=[{seq:1,topic:"ack",sender:"live-1",ts:"2026-11-19T06:00:00Z",payload:{}},
            {seq:2,topic:"task",sender:"admin",to:"live-1",ts:"2026-11-19T06:01:00Z",payload:{title:"跑一下"}}];
const J=(o)=>({ok:true,status:200,json:async()=>o,text:async()=>JSON.stringify(o),headers:{get:()=>null}});
const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://x/console",beforeParse(w){
  w.scrollTo=()=>{}; w.localStorage.setItem("hub.token","t");
  w.fetch=(u)=>{ const s=String(u);
    if(s.includes("/projects")) return Promise.resolve(J({projects:[{project:"yanshi",display_name:"yanshi"}],policy:{mode:"all",projects:["yanshi"]}}));
    if(s.includes("/agents")) return Promise.resolve(J({agents:AG}));
    if(s.includes("/submissions")) return Promise.resolve(J(SUBS));
    if(s.includes("/messages")) return Promise.resolve(J({messages:MSGS}));
    if(s.includes("/enrollments")) return Promise.resolve(J({enrollments:[{id:"e1",agent_id:"new",project:"yanshi",scopes:"poll",created_at:1}]}));
    if(s.includes("/stats")) return Promise.resolve(J({agents_online:1,agents_active:2,enrollments_pending:1,submissions_pending:1,projects:1}));
    return Promise.resolve(J({}));
  };
  w.addEventListener("error",e=>console.log("ERR",e.message));
}});
setTimeout(()=>{
  const d=dom.window.document;
  const card=(t)=>[...d.querySelectorAll(".card")].find(c=>(c.querySelector("h2")?.textContent||"").trim().startsWith(t));
  const vis=(c)=>[...c.querySelectorAll("tbody tr")].filter(r=>r.style.display!=="none"&&!r.querySelector(".empty")).length;
  const test=(title,val)=>{
    const c=card(title); const sel=c.querySelector("select");
    console.log(title,"下拉存在:",!!sel,"选项:",sel?sel.options.length:0,"总行:",vis(c));
    if(!sel)return;
    sel.value=val; sel.dispatchEvent(new dom.window.Event("change"));
    console.log("  → 选",val,"后可见行:",vis(c));
  };
  console.log("页面文案:", (d.body.innerText||"").replace(/\n+/g," | ").slice(0,220));
  console.log("body class:", d.body.className, "| #agents:", (d.getElementById("agents")?.innerHTML||"").slice(0,60));
  console.log("#subs:", (d.getElementById("subs")?.innerHTML||"").slice(0,60));
  console.log("#msgs:", (d.getElementById("msgs")?.innerHTML||"").slice(0,60));
  // 失联节点不应落进"忙/闲"
  const ros=[...d.querySelectorAll(".card")].find(c=>(c.querySelector("h2")?.textContent||"").trim().startsWith("名册"));
  const rowTxt=[...ros.querySelectorAll("tbody tr")].map(r=>r.textContent.replace(/\s+/g," ").trim());
  console.log("名册行:", rowTxt);
  const sel=ros.querySelector("select"); sel.value="work:work"; sel.dispatchEvent(new dom.window.Event("change"));
  console.log("选「忙」可见:",[...ros.querySelectorAll("tbody tr")].filter(r=>r.style.display!=="none"&&!r.querySelector(".empty")).length);
  sel.value="work:idle"; sel.dispatchEvent(new dom.window.Event("change"));
  console.log("选「闲」可见:",[...ros.querySelectorAll("tbody tr")].filter(r=>r.style.display!=="none"&&!r.querySelector(".empty")).length);
  sel.value="all"; sel.dispatchEvent(new dom.window.Event("change"));
  test("名册","alive:offline");
  test("交付箱","delivered");
  test("消息流","task");
  // 再验证：刷新重绘后过滤是否保持
  const proj=d.getElementById("proj");
  proj.dispatchEvent(new dom.window.Event("change"));
  setTimeout(()=>{
    const c=d.querySelectorAll(".card");
    const find=(t)=>[...c].find(x=>(x.querySelector("h2")?.textContent||"").trim().startsWith(t));
    const vis=(cc)=>[...cc.querySelectorAll("tbody tr")].filter(r=>r.style.display!=="none"&&!r.querySelector(".empty")).length;
    console.log("重绘后 → 名册:",vis(find("名册")),"交付箱:",vis(find("交付箱")),"消息流:",vis(find("消息流")));
    process.exit(0);
  },600);
},1200);
