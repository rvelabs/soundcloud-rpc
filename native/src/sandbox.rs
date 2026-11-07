use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

struct Command {
    method: &'static str,
    value: Value,
    reply: Option<oneshot::Sender<Result<Option<String>, String>>>,
}
pub struct Plugin {
    sender: SyncSender<Command>,
    stopped: Arc<AtomicBool>,
}

const PRELUDE: &str = r#"
globalThis.module = {exports:{}}; globalThis.exports = module.exports;
globalThis.console = Object.freeze({log(){},warn(){},error(){},debug(){},info(){}});
globalThis.__nativeTimers = new Map(); globalThis.__nativeTimerId = 0; globalThis.__nativeNow = 0;
globalThis.setTimeout = function(callback,delay,...args) {
    if(typeof callback !== 'function' || __nativeTimers.size >= 64) throw Error('Plugin timer limit exceeded');
    const id = ++__nativeTimerId;
    __nativeTimers.set(id,{callback,args,at:__nativeNow+Math.max(4,Math.min(3600000,Number(delay)||0)),repeat:0}); return id;
};
globalThis.setInterval = function(callback,delay,...args) {
    const id=setTimeout(callback,delay,...args); const timer=__nativeTimers.get(id);
    timer.repeat=Math.max(25,Math.min(3600000,Number(delay)||0)); timer.at=__nativeNow+timer.repeat; return id;
};
globalThis.clearTimeout=globalThis.clearInterval=function(id){__nativeTimers.delete(id)};
globalThis.__nativeRunTimers=function(now){
    __nativeNow=now;
    for(const [id,timer] of [...__nativeTimers]) if(timer.at<=now) {
        if(timer.repeat) timer.at=now+timer.repeat; else __nativeTimers.delete(id);
        timer.callback(...timer.args);
    }
};
globalThis.__nativeNextTimer=function(){
    let next=Infinity; for(const timer of __nativeTimers.values()) next=Math.min(next,timer.at);
    return next===Infinity ? -1 : Math.max(1,Math.min(3600000,next-__nativeNow));
};
"#;

impl Plugin {
    pub fn new(source: String, failed: impl Fn(String) + Send + 'static) -> Result<Self, String> {
        if source.len() > 512000 {
            return Err("Plugin file exceeds 512 KB".into());
        }
        let (sender, receiver) = mpsc::sync_channel::<Command>(8);
        let stopped = Arc::new(AtomicBool::new(false));
        let closed = stopped.clone();
        std::thread::Builder::new().name("soundcloud-plugin".into()).stack_size(2*1024*1024).spawn(move || {
            let result = (|| -> Result<(),String> {
                let runtime = Runtime::new().map_err(|_| "Could not create plugin runtime")?;
                runtime.set_memory_limit(32*1024*1024); runtime.set_max_stack_size(512*1024);
                let clock = Instant::now(); let deadline = Arc::new(AtomicU64::new(1000)); let limit = deadline.clone(); let stop = closed.clone();
                runtime.set_interrupt_handler(Some(Box::new(move || stop.load(Ordering::Acquire) || clock.elapsed().as_millis() as u64 > limit.load(Ordering::Relaxed))));
                let context = Context::full(&runtime).map_err(|_| "Could not create plugin context")?;
                let evaluate = |code: &str, budget: u64| -> Result<String,String> {
                    deadline.store(clock.elapsed().as_millis() as u64+budget,Ordering::Relaxed);
                    let value = context.with(|ctx| ctx.eval::<String,_>(code)).map_err(|_| "Plugin failed or exceeded its time/memory limit")?;
                    let mut jobs = 0;
                    while runtime.is_job_pending() {
                        jobs+=1; if jobs>1000 || clock.elapsed().as_millis() as u64 > deadline.load(Ordering::Relaxed) { return Err("Plugin promise limit exceeded".into()); }
                        runtime.execute_pending_job().map_err(|_| "Plugin promise failed")?;
                    }
                    Ok(value)
                };
                evaluate(&format!("{PRELUDE}\n{source}\nJSON.stringify(null)"),1000)?;
                loop {
                    if closed.load(Ordering::Acquire) { return Ok(()); }
                    let now=clock.elapsed().as_millis() as u64;
                    evaluate(&format!("__nativeRunTimers({now}); JSON.stringify(null)"),100)?;
                    let wait=evaluate("String(__nativeNextTimer())",100)?.parse::<i64>().map_err(|_| "Invalid plugin timer")?;
                    let message=if wait<0 { receiver.recv().ok() } else { match receiver.recv_timeout(Duration::from_millis(wait as u64)) { Ok(value)=>Some(value), Err(mpsc::RecvTimeoutError::Timeout)=>continue, Err(_)=>None } };
                    let Some(message)=message else { return Ok(()); };
                    if message.method=="stop" { return Ok(()); }
                    let method=serde_json::to_string(message.method).unwrap();
                    let code=format!("(()=>{{__nativeNow={}; const fn=module.exports[{method}]; const value=typeof fn==='function'?fn.call(module.exports,{}):null; if({method}==='contentScript' && value!=null && (typeof value!=='string'||value.length>256000))throw Error('Invalid content script');return JSON.stringify({method}==='contentScript'?(value??null):null)}})()",clock.elapsed().as_millis(),message.value);
                    let value=evaluate(&code,100).and_then(|text| serde_json::from_str::<Option<String>>(&text).map_err(|_| "Invalid plugin response".into())).and_then(|value| {
                        if let Some(code)=&value {if code.len()>256000{return Err("Plugin content script exceeds 256 KB".into());} evaluate(&format!("new Function({}); JSON.stringify(null)",serde_json::to_string(code).unwrap()),100)?;}
                        Ok(value)
                    });
                    let fatal=value.as_ref().err().cloned();
                    if let Some(reply)=message.reply { let _=reply.send(value); }
                    if let Some(error)=fatal { return Err(error); }
                }
            })();
            let intentional=closed.swap(true,Ordering::AcqRel);
            if let Err(error)=result && !intentional { failed(error); }
        }).map_err(|_| "Could not start plugin worker")?;
        Ok(Self { sender, stopped })
    }
    pub fn active(&self) -> bool {
        !self.stopped.load(Ordering::Acquire)
    }
    pub async fn call(&self, method: &'static str, value: Value) -> Result<Option<String>, String> {
        if ![
            "onEnable",
            "onDisable",
            "contentScript",
            "onTrackChange",
            "onThemeChange",
        ]
        .contains(&method)
            || !self.active()
        {
            return Err("Plugin is stopped or operation is unavailable".into());
        }
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(Command {
                method,
                value,
                reply: Some(tx),
            })
            .map_err(|_| "Plugin request capacity exceeded")?;
        tokio::time::timeout(Duration::from_millis(1500), rx)
            .await
            .map_err(|_| "Plugin response timed out")?
            .map_err(|_| "Plugin stopped")?
    }
    pub fn notify(&self, method: &'static str, value: Value) {
        if self.active() && ["onTrackChange", "onThemeChange"].contains(&method) {
            let _ = self.sender.try_send(Command {
                method,
                value,
                reply: None,
            });
        }
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.sender.try_send(Command {
            method: "stop",
            value: Value::Null,
            reply: None,
        });
    }
}
impl Drop for Plugin {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn runs_existing_commonjs_plugins_without_node_or_native_capabilities() {
        let plugin=Plugin::new("let n=0;module.exports={onEnable(){n=1},onTrackChange(){n++},contentScript(){return 'globalThis.result='+JSON.stringify({n,node:typeof process,files:typeof require,ipc:typeof __TAURI_INTERNALS__})}}".into(), |_|{}).unwrap();
        plugin.call("onEnable", Value::Null).await.unwrap();
        plugin.call("onTrackChange", Value::Null).await.unwrap();
        let data: Value = serde_json::from_str(
            plugin
                .call("contentScript", Value::Null)
                .await
                .unwrap()
                .unwrap()
                .trim_start_matches("globalThis.result="),
        )
        .unwrap();
        assert_eq!(data["n"], 2);
        assert_eq!(data["node"], "undefined");
        assert_eq!(data["files"], "undefined");
        assert_eq!(data["ipc"], "undefined");
    }
    #[tokio::test]
    async fn supports_timers_and_stops_a_nonreturning_hook() {
        let plugin=Plugin::new("let n=0;module.exports={onEnable(){setTimeout(()=>n++,5)},contentScript(){return String(n)},onDisable(){while(true){}}}".into(), |_|{}).unwrap();
        plugin.call("onEnable", Value::Null).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            plugin
                .call("contentScript", Value::Null)
                .await
                .unwrap()
                .unwrap(),
            "1"
        );
        assert!(plugin.call("onDisable", Value::Null).await.is_err());
    }
    #[tokio::test]
    async fn packaged_playback_speed_plugin_retains_its_content_script() {
        let plugin = Plugin::new(
            include_str!("../../plugins/playback-speed.js").into(),
            |_| {},
        )
        .unwrap();
        plugin.call("onEnable", Value::Null).await.unwrap();
        let code = plugin
            .call("contentScript", Value::Null)
            .await
            .unwrap()
            .unwrap();
        assert!(code.contains("preservesPitch"));
        assert!(code.contains("__scrpc_cleanup_playback_speed"));
    }
}
