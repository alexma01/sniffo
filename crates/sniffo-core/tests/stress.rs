//! Load test on the multi-threaded runtime the app uses (unit tests run single-threaded).
//! `cargo test --test stress -- --ignored --nocapture`
mod common;

use common::*;
use std::time::Instant;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn many_concurrent_http_and_https_requests() {
    let up = upstream_http().await;
    let (ups, pem) = upstream_https().await;
    let s = start(vec![pem]).await;
    let t = Instant::now();
    // Browsers cap concurrent connections; an unbounded burst only overflows the accept backlog.
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(100));
    let mut tasks = vec![];
    for round in 0..40 {
        for i in 0..100 {
            let c = client(&s, None);
            let limit = limit.clone();
            let url = if i % 2 == 0 { format!("http://{up}/r{round}/{i}") } else { format!("https://localhost:{}/r{round}/{i}", ups.port()) };
            tasks.push(tokio::spawn(async move {
                let _permit = limit.acquire_owned().await.unwrap();
                // Mix of read-to-end and dropped-early responses, like a browser cancelling loads.
                match c.get(&url).send().await {
                    Ok(r) => { if i % 7 != 0 { let _ = r.text().await; } None }
                    Err(e) => Some(format!("{e:?}").chars().take(160).collect::<String>()),
                }
            }));
        }
    }
    let mut errors = vec![];
    for t in tasks { if let Some(e) = t.await.unwrap() { errors.push(e); } }
    println!("4000 requests in {:?}, {} flows, {} client errors", t.elapsed(), s.engine.summaries().len(), errors.len());
    if let Some(e) = errors.first() { println!("first error: {e}"); }
    assert!(errors.is_empty());
    assert_eq!(s.engine.summaries().len(), 4000, "every request recorded");
    s.proxy.stop().await;
}
