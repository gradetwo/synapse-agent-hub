const fs = require("fs");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync("admin/index.html", "utf8");
const errs = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://synapse.wangda.today/console",
  beforeParse(w) {
    w.fetch = () => new Promise((_, rej) => rej(new Error("net-off")));
    w.localStorage.setItem("hub.token", "x");
    w.addEventListener("error", (e) => errs.push("ERR " + e.message));
    w.addEventListener("unhandledrejection", (e) => errs.push("REJ " + (e.reason && e.reason.message)));
    w.scrollTo = () => {};
  },
});
setTimeout(() => {
  const d = dom.window.document;
  console.log("tabs 容器:", !!d.getElementById("tabs"), "按钮数:", d.querySelectorAll("#tabs button").length);
  console.log("build:", d.getElementById("build")?.textContent);
  console.log("cards 可见:", [...d.querySelectorAll(".card")].filter(c=>c.style.display!=="none").map(c=>(c.querySelector("h2")?.textContent||"").trim().slice(0,6)));
  console.log("errors:", errs.slice(0,6));
  process.exit(0);
}, 1500);
