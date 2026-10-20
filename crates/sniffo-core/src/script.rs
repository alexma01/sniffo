//! JavaScript rules (QuickJS). A script defines either or both of:
//!
//! ```js
//! function onRequest(context, request) { request.headers["x-debug"] = "1"; return request; }
//! function onResponse(context, request, response) { response.body.injected = true; return response; }
//! ```
//!
//! `request`  = { method, url, headers, body }
//! `response` = { status, headers, body }
//! Headers are an object with lowercase names (repeated headers become arrays). JSON bodies
//! arrive parsed; returning an object body sends it back as JSON. `sharedState` persists
//! across calls and scripts; `console.log` goes to the script console.

use crate::flow::Headers;
use rquickjs::{Context, Function, Runtime};
use serde_json::{Map, Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

/// A runaway script (infinite loop) is interrupted after this long.
pub const TIMEOUT: Duration = Duration::from_secs(1);
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;

const PRELUDE: &str = r#"
globalThis.console = { log: (...a) => __log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
console.info = console.warn = console.error = console.debug = console.log;
const __fmt = e => String(e) + (e && e.stack ? "\n" + e.stack : "");
globalThis.__run = (code, fname, argsJson, sharedJson) => {
  try {
    globalThis.sharedState = JSON.parse(sharedJson);
    (0, eval)(code);
    const f = globalThis[fname];
    if (typeof f !== "function") { globalThis.__out = JSON.stringify({ value: null, shared: globalThis.sharedState }); return; }
    Promise.resolve(f(...JSON.parse(argsJson))).then(
      v => { globalThis.__out = JSON.stringify({ value: v === undefined ? null : v, shared: globalThis.sharedState }); },
      e => { globalThis.__err = __fmt(e); });
  } catch (e) { globalThis.__err = __fmt(e); }
};
"#;

#[derive(Debug, Default)]
pub struct Output {
    /// What the function returned (`None` = leave the message unchanged).
    pub value: Option<Value>,
    pub logs: Vec<String>,
    pub error: Option<String>,
}

/// Runs `function` from `code` with JSON `args`; `shared` is read and updated in place.
pub fn run(code: &str, function: &str, args: &Value, shared: &mut Value) -> Output {
    let logs = Rc::new(RefCell::new(Vec::new()));
    let mut out = Output::default();
    let started = Instant::now();
    let result = (|| -> rquickjs::Result<Option<String>> {
        let rt = Runtime::new()?;
        rt.set_memory_limit(MEMORY_LIMIT);
        let deadline = started + TIMEOUT;
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
        let ctx = Context::full(&rt)?;
        ctx.with(|ctx| -> rquickjs::Result<()> {
            let sink = logs.clone();
            ctx.globals().set("__log", Function::new(ctx.clone(), move |s: String| sink.borrow_mut().push(s))?)?;
            ctx.eval::<(), _>(PRELUDE)?;
            let g = ctx.globals();
            g.set("__code", code)?;
            g.set("__fname", function)?;
            g.set("__args", args.to_string())?;
            g.set("__shared", shared.to_string())?;
            ctx.eval::<(), _>("__run(__code, __fname, __args, __shared)")
        })?;
        while rt.is_job_pending() {
            if rt.execute_pending_job().is_err() || Instant::now() > deadline {
                break;
            }
        }
        ctx.with(|ctx| {
            let g = ctx.globals();
            if let Ok(err) = g.get::<_, String>("__err") {
                return Err(rquickjs::Error::new_from_js_message("script", "error", err));
            }
            Ok(g.get::<_, String>("__out").ok())
        })
    })();
    match result {
        Ok(Some(json)) => {
            if let Ok(v) = serde_json::from_str::<Value>(&json) {
                *shared = v["shared"].clone();
                out.value = Some(v["value"].clone()).filter(|v| !v.is_null());
            }
        }
        Ok(None) => out.error = Some(format!("script did not finish within {} ms", TIMEOUT.as_millis())),
        // The interrupt surfaces as an opaque, uncatchable exception.
        Err(_) if started.elapsed() >= TIMEOUT => out.error = Some(format!("script interrupted after {} ms", TIMEOUT.as_millis())),
        Err(e) => out.error = Some(e.to_string()),
    }
    out.logs = logs.take();
    out
}

pub fn headers_to_js(h: &Headers) -> Value {
    let mut map = Map::new();
    for (k, v) in h {
        let k = k.to_ascii_lowercase();
        match map.get_mut(&k) {
            Some(Value::Array(a)) => a.push(json!(v)),
            Some(prev) => *prev = json!([prev.take(), v]),
            None => {
                map.insert(k, json!(v));
            }
        }
    }
    Value::Object(map)
}

pub fn headers_from_js(v: &Value) -> Option<Headers> {
    let mut out = vec![];
    for (k, v) in v.as_object()? {
        match v {
            Value::Array(a) => out.extend(a.iter().map(|x| (k.clone(), scalar(x)))),
            Value::Null => {}
            x => out.push((k.clone(), scalar(x))),
        }
    }
    Some(out)
}

fn scalar(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())
}

/// Body for scripts: parsed JSON when it is JSON, text otherwise, null when binary/empty.
pub fn body_to_js(text: Option<&str>) -> Value {
    match text {
        Some(t) if !t.is_empty() => serde_json::from_str(t).ok().filter(|v: &Value| v.is_object() || v.is_array()).unwrap_or_else(|| json!(t)),
        _ => Value::Null,
    }
}

/// `None` = body unchanged (null or missing in the returned object).
pub fn body_from_js(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifies_request_and_keeps_shared_state() {
        let code = r#"
            function onRequest(context, request) {
              sharedState.count = (sharedState.count || 0) + 1;
              request.headers["x-count"] = String(sharedState.count);
              request.body.added = true;
              console.log("seen", request.url, { n: sharedState.count });
              return request;
            }"#;
        let mut shared = json!({});
        let req = json!({ "method": "POST", "url": "https://x/y", "headers": { "a": "1" }, "body": { "k": 1 } });
        let out = run(code, "onRequest", &json!([{}, req]), &mut shared);
        assert_eq!(out.error, None);
        let v = out.value.unwrap();
        assert_eq!(v["headers"]["x-count"], "1");
        assert_eq!(v["body"], json!({ "k": 1, "added": true }));
        assert_eq!(out.logs, [r#"seen https://x/y {"n":1}"#]);
        let out = run(code, "onRequest", &json!([{}, req]), &mut shared);
        assert_eq!(out.value.unwrap()["headers"]["x-count"], "2", "sharedState persists");
    }

    #[test]
    fn async_missing_errors_and_timeouts() {
        let mut shared = json!({});
        let out = run("async function onResponse(c, q, r) { r.status = 201; return r; }", "onResponse", &json!([{}, {}, { "status": 200 }]), &mut shared);
        assert_eq!(out.value.unwrap()["status"], 201, "async functions are awaited");
        assert!(run("function other() {}", "onRequest", &json!([]), &mut shared).value.is_none());
        assert!(run("function onRequest( {", "onRequest", &json!([]), &mut shared).error.unwrap().contains("SyntaxError"));
        assert!(run("function onRequest() { throw new Error('boom') }", "onRequest", &json!([]), &mut shared).error.unwrap().contains("boom"));
        let t = Instant::now();
        let out = run("function onRequest() { while (true) {} }", "onRequest", &json!([]), &mut shared);
        let err = out.error.unwrap();
        assert!(err.contains("interrupted"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn header_and_body_conversion() {
        let h: Headers = vec![("Set-Cookie".into(), "a=1".into()), ("set-cookie".into(), "b=2".into()), ("X".into(), "y".into())];
        let js = headers_to_js(&h);
        assert_eq!(js["set-cookie"], json!(["a=1", "b=2"]));
        assert_eq!(headers_from_js(&js).unwrap().len(), 3);
        assert_eq!(body_to_js(Some(r#"{"a":1}"#)), json!({ "a": 1 }));
        assert_eq!(body_to_js(Some("plain")), json!("plain"));
        assert_eq!(body_from_js(&json!({ "a": 1 })).as_deref(), Some(r#"{"a":1}"#));
    }
}
