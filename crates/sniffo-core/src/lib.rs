//! Sniffo core: MITM debugging proxy engine, independent from the desktop UI.

pub mod ca;
pub mod client;
pub mod flow;
pub mod proxy;
pub mod rules;
pub mod system;

pub use ca::RootCa;
pub use flow::{Flow, FlowId, FlowState, FlowSummary, Message};
pub use proxy::{BreakpointHit, Decision, Editable, Engine, FlowEvent, ProxyHandle, SslProxying, StartOptions};
pub use rules::{Action, AllowList, Matcher, Rule, Rules};
